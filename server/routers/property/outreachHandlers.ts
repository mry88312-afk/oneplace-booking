/**
 * 週期詢問（periodic outreach）— Zeabur「嘴巴」端。
 *
 * 大腦（Supabase）每日用 pg_cron 算出 outreach.schedule、並用 pg_net 把
 * 「已確認且到期」的 schedule_ids POST 到 /api/outreach/run。本檔負責：
 *   1) runOutreach()：發送前再用本地 booking_records 即時防重（stale-value race），
 *      渲染卡片變數、pushLineDirect、回寫 status。
 *   2) tRPC adminProcedure：後台看板（列出/編輯/立即送）與規則編輯器、設定。
 *
 * 所有 Supabase 讀寫都在後端（SUPABASE_DB_URL），瀏覽器只打本服務 tRPC。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { router, adminProcedure } from "../../_core/trpc";
import { sbQuery, isSupabaseConfigured } from "../../db/supabaseClient";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { pushLineDirect } from "./bookingConfirmHandler";

type ScheduleRow = {
  id: string;
  tenant_uid: string;
  tenant_name: string | null;
  room: string | null;
  property_name: string | null;
  contract_no: string | null;
  contract_end_date: string | null; // 'YYYY-MM-DD'
  rule_key: string;
  scheduled_date: string;
  status: string;
  manually_edited: boolean;
  suppressed_reason: string | null;
  sent_at: string | null;
};

/** 把卡片範本內的 {{變數}} 換成實際值（JSON-safe）。 */
export function renderTemplate(template: any, vars: Record<string, string>): any {
  let json = JSON.stringify(template);
  for (const [k, v] of Object.entries(vars)) {
    // 用 JSON.stringify 取得跳脫後的字串，去掉外層引號後嵌入既有 JSON 字串中
    const safe = JSON.stringify(String(v ?? "")).slice(1, -1);
    json = json.split(`{{${k}}}`).join(safe);
  }
  // 清掉未對應到的佔位符，避免殘留 {{xxx}}
  json = json.replace(/\{\{[^}]+\}\}/g, "");
  return JSON.parse(json);
}

/** 由 schedule 列計算卡片變數。days_until_expiry 於發送當下重算（即使延後送也準確）。 */
function computeVars(row: ScheduleRow): Record<string, string> {
  const vars: Record<string, string> = {
    tenant_name: row.tenant_name ?? "",
    room: row.room ?? "",
    property_name: row.property_name ?? "",
    contract_end_date: row.contract_end_date ?? "",
    days_until_expiry: "",
  };
  if (row.contract_end_date) {
    const end = new Date(row.contract_end_date + "T00:00:00Z").getTime();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days = Math.round((end - today.getTime()) / 86_400_000);
    vars.days_until_expiry = String(days);
  }
  return vars;
}

/**
 * 即時防重：該 line_uid 是否已有 confirmed 的續約/退租預約（本地 TiDB booking_records）。
 * 補抓「剛在 Zeabur 預約、Supabase 鏡像尚未同步」的空窗。
 */
async function hasActiveBookingSuppress(tenantUid: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("TiDB unavailable for suppression check");
  const rows = await db
    .select({ id: schema.bookingRecords.id })
    .from(schema.bookingRecords)
    .innerJoin(
      schema.bookingTemplates,
      eq(schema.bookingRecords.templateId, schema.bookingTemplates.id),
    )
    .where(
      and(
        eq(schema.bookingRecords.tenantUid, tenantUid),
        eq(schema.bookingRecords.status, "confirmed"),
        inArray(schema.bookingTemplates.contractAction, ["續約", "退租"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 每個 rule 的通知列文字（altText）；bare bubble 包成 flex message 時用 */
const RULE_ALT_TEXT: Record<string, string> = {
  onboarding_d15: "一方生活｜入住問候 🏠",
  expiry_d60: "一方生活｜租約續約提醒 📄",
  expiry_d30: "一方生活｜租約即將到期 📄",
  expiry_d15: "一方生活｜租約到期提醒 ⏰",
};

/**
 * 把 bare bubble / carousel 包成合法的 LINE flex message（已經是完整 message 物件就原樣回傳）。
 * LINE push 的 message 必須是 flex/text/image…，不能直接送 {type:'bubble'}。
 */
export function toFlexMessage(card: any, altText?: string): any {
  if (card && (card.type === "bubble" || card.type === "carousel")) {
    return { type: "flex", altText: altText || "一方生活通知", contents: card };
  }
  return card;
}

export type RunResult = { sent: number; suppressed: number; failed: number; skipped: number; errors: { id: string; error: string }[] };

/**
 * 對指定的 schedule_ids 執行發送 gate。
 * - 非 pending/confirmed 的列 → skipped（避免重送已 sent/cancelled/skipped）
 * - 命中 booking_records → status=suppressed（非錯誤，不發）
 * - 發送成功 → status=sent + sent_at；失敗或例外 → 維持原狀以利下次重試
 */
export async function runOutreach(scheduleIds: string[]): Promise<RunResult> {
  const result: RunResult = { sent: 0, suppressed: 0, failed: 0, skipped: 0, errors: [] };
  if (!isSupabaseConfigured()) throw new Error("SUPABASE_DB_URL not set");
  if (!Array.isArray(scheduleIds) || scheduleIds.length === 0) return result;

  const rows = await sbQuery<ScheduleRow & { card_template: any }>(
    `select s.id, s.tenant_uid, s.tenant_name, s.room, s.property_name, s.contract_no,
            to_char(s.contract_end_date, 'YYYY-MM-DD') as contract_end_date,
            s.rule_key, to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
            s.status, s.manually_edited, s.suppressed_reason, s.sent_at,
            r.card_template
       from outreach.schedule s
       join outreach.rule r on r.key = s.rule_key
      where s.id = any($1::uuid[])`,
    [scheduleIds],
  );

  // 測試模式：設定了 test_redirect_uid 時，所有發送一律改寄到它（永不送真實室友）
  const redirect =
    (
      await sbQuery<{ u: string | null }>(
        `select nullif(trim(test_redirect_uid),'') as u from outreach.settings where id=1`,
      )
    )[0]?.u || null;

  for (const row of rows) {
    try {
      if (row.status !== "pending" && row.status !== "confirmed") {
        result.skipped++;
        continue;
      }
      if (redirect) {
        // 測試模式：改寄到測試 LINE、跳過防重、不改原排程狀態（可重複測、永不送真人）
        const tmsg = toFlexMessage(
          renderTemplate(row.card_template, computeVars(row)),
          "【測試】" + (RULE_ALT_TEXT[row.rule_key] || "一方生活通知"),
        );
        const tpush = await pushLineDirect(redirect, tmsg);
        if (tpush.success) result.sent++;
        else {
          result.failed++;
          result.errors.push({ id: row.id, error: tpush.error || "push failed" });
        }
        continue;
      }
      if (await hasActiveBookingSuppress(row.tenant_uid)) {
        await sbQuery(
          `update outreach.schedule set status='suppressed', suppressed_reason=$2, updated_at=now() where id=$1`,
          [row.id, "已有續約/退租預約（booking_records 即時查核）"],
        );
        result.suppressed++;
        continue;
      }
      const message = toFlexMessage(
        renderTemplate(row.card_template, computeVars(row)),
        RULE_ALT_TEXT[row.rule_key],
      );
      const push = await pushLineDirect(row.tenant_uid, message);
      if (push.success) {
        await sbQuery(
          `update outreach.schedule set status='sent', sent_at=now(), updated_at=now() where id=$1`,
          [row.id],
        );
        result.sent++;
      } else {
        console.error(`[outreach] push failed for ${row.id}: ${push.error}`);
        result.failed++; // 維持原狀，下次重試
        result.errors.push({ id: row.id, error: push.error || "push failed" });
      }
    } catch (err: any) {
      console.error(`[outreach] error on ${row.id}: ${err?.message || err}`);
      result.failed++; // 維持原狀，下次重試
      result.errors.push({ id: row.id, error: String(err?.message || err) });
    }
  }
  return result;
}

/**
 * 測試發送：把任意卡片（LINE message 物件、或 bubble/carousel）推到指定 uid，供後台預覽。
 * 從 Zeabur 發送（可穩定連到 LINE）。可帶 vars 做 {{變數}} 替換。
 */
export async function pushTestCard(
  uid: string,
  card: any,
  altText?: string,
  vars?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const rendered = vars && Object.keys(vars).length ? renderTemplate(card, vars) : card;
  const msg = toFlexMessage(rendered, altText || "測試卡片");
  return await pushLineDirect(uid, msg);
}

// ──────────────────────────────────────────────────────────────────────────
// tRPC 後台 API（皆需 x-admin-password）
// ──────────────────────────────────────────────────────────────────────────

const SCHEDULE_COLS =
  `id, tenant_uid, tenant_name, room, contract_no,
   to_char(contract_end_date,'YYYY-MM-DD') as contract_end_date,
   rule_key, to_char(scheduled_date,'YYYY-MM-DD') as scheduled_date,
   status, manually_edited, suppressed_reason, sent_at`;

export const outreachRouter = router({
  /** 後台是否已接上 Supabase（給前端顯示提示用） */
  health: adminProcedure.query(() => ({ supabaseConfigured: isSupabaseConfigured() })),

  /** 測試發送：把貼上的卡片 JSON 推到指定 uid（從 Zeabur 發送），供預覽卡片實際樣子 */
  sendTestCard: adminProcedure
    .input(
      z.object({
        uid: z.string().min(1),
        card: z.any(),
        altText: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const r = await pushTestCard(input.uid, input.card, input.altText, input.vars);
      if (!r.success) throw new TRPCError({ code: "BAD_REQUEST", message: r.error || "LINE push 失敗" });
      return { ok: true };
    }),

  /** 列出排程（預設未來；可帶 status/from/to 過濾） */
  listSchedule: adminProcedure
    .input(
      z
        .object({
          status: z
            .enum(["pending", "confirmed", "sent", "skipped", "cancelled", "suppressed"])
            .optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().min(1).max(2000).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      if (!isSupabaseConfigured()) return [];
      const clauses: string[] = [];
      const params: any[] = [];
      if (input?.status) {
        params.push(input.status);
        clauses.push(`status = $${params.length}`);
      }
      if (input?.from) {
        params.push(input.from);
        clauses.push(`scheduled_date >= $${params.length}`);
      } else if (!input?.status) {
        clauses.push(`scheduled_date >= current_date`); // 預設只看未來
      }
      if (input?.to) {
        params.push(input.to);
        clauses.push(`scheduled_date <= $${params.length}`);
      }
      params.push(input?.limit ?? 500);
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return await sbQuery(
        `select ${SCHEDULE_COLS} from outreach.schedule ${where}
         order by scheduled_date asc, tenant_name asc nulls last limit $${params.length}`,
        params,
      );
    }),

  /** 編輯單筆：改日期 / 跳過 / 確認 / 取消確認 / 取消 */
  updateScheduleItem: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        action: z.enum(["reschedule", "skip", "confirm", "unconfirm", "cancel"]),
        scheduledDate: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      switch (input.action) {
        case "reschedule":
          if (!input.scheduledDate)
            throw new TRPCError({ code: "BAD_REQUEST", message: "缺少 scheduledDate" });
          await sbQuery(
            `update outreach.schedule set scheduled_date=$2, manually_edited=true, updated_at=now() where id=$1`,
            [input.id, input.scheduledDate],
          );
          break;
        case "skip":
          await sbQuery(
            `update outreach.schedule set status='skipped', updated_at=now() where id=$1`,
            [input.id],
          );
          break;
        case "confirm":
          await sbQuery(
            `update outreach.schedule set status='confirmed', updated_at=now() where id=$1 and status in ('pending','skipped')`,
            [input.id],
          );
          break;
        case "unconfirm":
          await sbQuery(
            `update outreach.schedule set status='pending', updated_at=now() where id=$1 and status='confirmed'`,
            [input.id],
          );
          break;
        case "cancel":
          await sbQuery(
            `update outreach.schedule set status='cancelled', updated_at=now() where id=$1`,
            [input.id],
          );
          break;
      }
      return { ok: true };
    }),

  /** 立即送（提早送）：走與 run 端點完全相同的發送 gate */
  sendNow: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      return await runOutreach([input.id]);
    }),

  /** 手動重算排程（改了規則/篩選後用） */
  recomputeNow: adminProcedure.mutation(async () => {
    if (!isSupabaseConfigured()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SUPABASE_DB_URL 未設定" });
    const rows = await sbQuery<{ n: number }>(
      `select outreach.recompute_schedule() as n`,
    );
    return { inserted: rows[0]?.n ?? 0 };
  }),

  /** 規則清單（含 card_template） */
  listRules: adminProcedure.query(async () => {
    if (!isSupabaseConfigured()) return [];
    return await sbQuery(
      `select key, label, trigger_basis, offset_days, enabled, card_template, sort_order
         from outreach.rule order by sort_order, key`,
    );
  }),

  /** 編輯規則：天數 / 啟用停用 / 卡片 JSON / 標籤 */
  updateRule: adminProcedure
    .input(
      z.object({
        key: z.string(),
        label: z.string().optional(),
        offsetDays: z.number().int().optional(),
        enabled: z.boolean().optional(),
        cardTemplate: z.any().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const sets: string[] = [];
      const params: any[] = [input.key];
      if (input.label !== undefined) {
        params.push(input.label);
        sets.push(`label=$${params.length}`);
      }
      if (input.offsetDays !== undefined) {
        params.push(input.offsetDays);
        sets.push(`offset_days=$${params.length}`);
      }
      if (input.enabled !== undefined) {
        params.push(input.enabled);
        sets.push(`enabled=$${params.length}`);
      }
      if (input.cardTemplate !== undefined) {
        if (typeof input.cardTemplate !== "object" || input.cardTemplate === null)
          throw new TRPCError({ code: "BAD_REQUEST", message: "card_template 必須是 JSON 物件" });
        params.push(JSON.stringify(input.cardTemplate));
        sets.push(`card_template=$${params.length}::jsonb`);
      }
      if (!sets.length) return { ok: true };
      sets.push(`updated_at=now()`);
      await sbQuery(`update outreach.rule set ${sets.join(", ")} where key=$1`, params);
      return { ok: true };
    }),

  /** 取得設定（篩選集合 + 派送設定；run_secret 不回傳明文，只回是否已設定） */
  getSettings: adminProcedure.query(async () => {
    if (!isSupabaseConfigured()) return null;
    const rows = await sbQuery(
      `select include_ownership_regions, exclude_hq_categories, run_endpoint_url,
              (run_secret is not null and run_secret <> '') as run_secret_set,
              test_redirect_uid
         from outreach.settings where id=1`,
    );
    return rows[0] ?? null;
  }),

  /** 更新設定（篩選集合 + Zeabur run 端點 URL / 共享密鑰） */
  updateSettings: adminProcedure
    .input(
      z.object({
        includeOwnershipRegions: z.array(z.string()).optional(),
        excludeHqCategories: z.array(z.string()).optional(),
        runEndpointUrl: z.string().optional(),
        runSecret: z.string().optional(),
        testRedirectUid: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const sets: string[] = [];
      const params: any[] = [];
      // 測試模式重導：空字串 = 清除（關閉測試模式）；有值 = 開啟並重導到該 uid
      if (input.testRedirectUid !== undefined) {
        params.push(input.testRedirectUid.trim() === "" ? null : input.testRedirectUid.trim());
        sets.push(`test_redirect_uid=$${params.length}`);
      }
      // 防呆：空陣列視為「不變更」，避免表單在未載入時誤把篩選集合清空（清空 include 會導致 recompute 算不出任何排程）
      if (input.includeOwnershipRegions !== undefined && input.includeOwnershipRegions.length > 0) {
        params.push(input.includeOwnershipRegions);
        sets.push(`include_ownership_regions=$${params.length}`);
      }
      if (input.excludeHqCategories !== undefined && input.excludeHqCategories.length > 0) {
        params.push(input.excludeHqCategories);
        sets.push(`exclude_hq_categories=$${params.length}`);
      }
      // 防呆：空字串視為「不變更」，避免表單在未載入時誤把 URL 清空
      if (input.runEndpointUrl !== undefined && input.runEndpointUrl.trim() !== "") {
        params.push(input.runEndpointUrl.trim());
        sets.push(`run_endpoint_url=$${params.length}`);
      }
      if (input.runSecret !== undefined && input.runSecret !== "") {
        params.push(input.runSecret);
        sets.push(`run_secret=$${params.length}`);
      }
      if (!sets.length) return { ok: true };
      sets.push(`updated_at=now()`);
      await sbQuery(`update outreach.settings set ${sets.join(", ")} where id=1`, params);
      return { ok: true };
    }),
});
