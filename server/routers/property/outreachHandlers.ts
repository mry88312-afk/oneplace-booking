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
import { and, eq, inArray, gte, lt } from "drizzle-orm";
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
  source?: string;
  recipient_phone?: string | null;
  alt_text?: string | null;
  vars?: Record<string, any> | null;
  card_override?: any;
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
    schedule_id: row.id ?? "",
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
  // 列自帶變數（booking 提醒帶 booking_date/booking_time 等）後蓋前
  if (row.vars && typeof row.vars === "object") {
    for (const [k, v] of Object.entries(row.vars)) vars[k] = String(v ?? "");
  }
  return vars;
}

/** 台北時區 'YYYY-MM-DD'（輸入 ms 時間戳）。 */
function taipeiYmd(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
/** 台北時區 'HH:mm'。 */
function taipeiHm(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
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

/** 發送失敗時回寫追蹤欄位（last_error / last_attempt_at / attempt_count）。僅用於真實發送路徑；測試模式不回寫，保持可重複測、不污染計數。 */
async function markSendFailure(id: string, errMsg: string): Promise<void> {
  await sbQuery(
    `update outreach.schedule
        set last_error=$2, last_attempt_at=now(), attempt_count=coalesce(attempt_count,0)+1, updated_at=now()
      where id=$1`,
    [id, String(errMsg || "send failed").slice(0, 1000)],
  );
}

/** 確認單筆（僅 pending/skipped 可確認）；回報是否成功與原因，供批次重用。 */
async function confirmOne(id: string): Promise<{ id: string; ok: boolean; error?: string }> {
  const r = await sbQuery<{ id: string }>(
    `update outreach.schedule set status='confirmed', updated_at=now()
      where id=$1 and status in ('pending','skipped') returning id`,
    [id],
  );
  if (r.length) return { id, ok: true };
  const cur = await sbQuery<{ status: string }>(`select status from outreach.schedule where id=$1`, [id]);
  if (!cur.length) return { id, ok: false, error: "查無此排程" };
  return { id, ok: false, error: `目前狀態為 ${cur[0].status}，僅 pending/skipped 可確認` };
}

/** 跳過單筆（已發送/取消者不可跳過）；回報是否成功與原因，供批次重用。 */
async function skipOne(id: string): Promise<{ id: string; ok: boolean; error?: string }> {
  const r = await sbQuery<{ id: string }>(
    `update outreach.schedule set status='skipped', updated_at=now()
      where id=$1 and status in ('pending','confirmed','skipped') returning id`,
    [id],
  );
  if (r.length) return { id, ok: true };
  const cur = await sbQuery<{ status: string }>(`select status from outreach.schedule where id=$1`, [id]);
  if (!cur.length) return { id, ok: false, error: "查無此排程" };
  return { id, ok: false, error: `目前狀態為 ${cur[0].status}，無法跳過` };
}

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
            s.source, s.recipient_phone, s.alt_text, s.vars, s.card_override,
            r.card_template
       from outreach.schedule s
       left join outreach.rule r on r.key = s.rule_key
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
      // 卡片：api 來源帶 card_override，其餘用規則卡
      const card = row.card_override ?? row.card_template;
      const altText = row.alt_text || RULE_ALT_TEXT[row.rule_key] || "一方生活通知";
      if (!card) {
        if (!redirect) await markSendFailure(row.id, "無卡片內容（card_override 與規則卡皆空）");
        result.failed++;
        result.errors.push({ id: row.id, error: "no card" });
        continue;
      }
      if (redirect) {
        // 測試模式：改寄到測試 LINE、跳過防重、不改原排程狀態（可重複測、永不送真人）
        const tmsg = toFlexMessage(renderTemplate(card, computeVars(row)), "【測試】" + altText);
        const tpush = await pushLineDirect(redirect, tmsg);
        if (tpush.success) result.sent++;
        else {
          result.failed++;
          result.errors.push({ id: row.id, error: tpush.error || "push failed" });
        }
        continue;
      }
      // 退租提醒：發送前再驗（解掃描後取消/改期）
      if (row.source === "booking") {
        const bid = Number(row.vars?.booking_id);
        const db = await getDb();
        const bk = db && bid
          ? await db.select({ status: schema.bookingRecords.status, bookingTime: schema.bookingRecords.bookingTime })
              .from(schema.bookingRecords).where(eq(schema.bookingRecords.id, bid)).limit(1)
          : [];
        const ok = bk.length > 0 && bk[0].status === "confirmed" && taipeiYmd(bk[0].bookingTime) === String(row.vars?.booking_date || "");
        if (!ok) {
          await sbQuery(
            `update outreach.schedule set status='skipped', suppressed_reason=$2, updated_at=now() where id=$1`,
            [row.id, "退租預約已取消或已改期（發送前再驗）"],
          );
          result.skipped++;
          continue;
        }
      }
      // 收件人：只有電話的（api 來源）發送前換 UID；查無留失敗可重試
      let targetUid = row.tenant_uid;
      if (!targetUid && row.recipient_phone) {
        const normalized = row.recipient_phone.replace(/[\s\-()]/g, "");
        const t = await sbQuery<{ line_uid: string }>(
          `select line_uid from contract.tenants where primary_phone=$1 and line_uid is not null and line_uid<>'' limit 1`,
          [normalized],
        );
        if (t.length) {
          targetUid = t[0].line_uid;
          await sbQuery(`update outreach.schedule set tenant_uid=$2, updated_at=now() where id=$1`, [row.id, targetUid]);
        } else {
          await markSendFailure(row.id, `查無 LINE UID（電話 ${normalized}），綁定後可重送`);
          result.failed++;
          result.errors.push({ id: row.id, error: `no LINE UID for phone ${normalized}` });
          continue;
        }
      }
      if (!targetUid) {
        await markSendFailure(row.id, "無收件人（uid 與電話皆空）");
        result.failed++;
        result.errors.push({ id: row.id, error: "no recipient" });
        continue;
      }
      // 防重打擾只適用合約規則卡（booking 提醒本來就該有退租預約；api 內容由來源系統決定）
      if ((row.source ?? "rule") === "rule" && (await hasActiveBookingSuppress(targetUid))) {
        await sbQuery(
          `update outreach.schedule set status='suppressed', suppressed_reason=$2, updated_at=now() where id=$1`,
          [row.id, "已有續約/退租預約（booking_records 即時查核）"],
        );
        result.suppressed++;
        continue;
      }
      const message = toFlexMessage(renderTemplate(card, computeVars(row)), altText);
      const push = await pushLineDirect(targetUid, message);
      if (push.success) {
        await sbQuery(
          `update outreach.schedule set status='sent', sent_at=now(), last_error=null, updated_at=now() where id=$1`,
          [row.id],
        );
        result.sent++;
      } else {
        console.error(`[outreach] push failed for ${row.id}: ${push.error}`);
        await markSendFailure(row.id, push.error || "push failed"); // status 不變、可重試，記錄失敗
        result.failed++;
        result.errors.push({ id: row.id, error: push.error || "push failed" });
      }
    } catch (err: any) {
      console.error(`[outreach] error on ${row.id}: ${err?.message || err}`);
      if (!redirect) {
        try { await markSendFailure(row.id, String(err?.message || err)); } catch {}
      }
      result.failed++; // 維持原狀，下次重試
      result.errors.push({ id: row.id, error: String(err?.message || err) });
    }
  }
  return result;
}

/**
 * 退租提醒掃描（每日台北 17:00 由 pg_cron 經 pg_net 呼叫）：
 * 掃 TiDB「台北明天」的退租 confirmed 預約 → 排入今天 18:00（台北）的提醒；dedupe_key 擋重複。
 */
export async function scanCheckoutReminders(): Promise<{ ok: boolean; scanned: number; inserted: number }> {
  if (!isSupabaseConfigured()) throw new Error("SUPABASE_DB_URL not set");
  const db = await getDb();
  if (!db) throw new Error("TiDB unavailable");
  // 台北「明天」的 [00:00, 24:00) 換成 UTC 毫秒區間
  const nowTp = new Date(Date.now() + 8 * 3600_000);
  const tomorrowTpMidnightUtcMs =
    Date.UTC(nowTp.getUTCFullYear(), nowTp.getUTCMonth(), nowTp.getUTCDate() + 1) - 8 * 3600_000;
  const endMs = tomorrowTpMidnightUtcMs + 86_400_000;
  const todayYmd = taipeiYmd(Date.now());
  const sendAtIso = new Date(tomorrowTpMidnightUtcMs - 86_400_000 + 18 * 3600_000).toISOString(); // 今天 18:00 台北

  const rows = await db
    .select({
      id: schema.bookingRecords.id,
      tenantUid: schema.bookingRecords.tenantUid,
      tenantName: schema.bookingRecords.tenantName,
      roomNumber: schema.bookingRecords.roomNumber,
      address: schema.bookingRecords.address,
      bookingTime: schema.bookingRecords.bookingTime,
    })
    .from(schema.bookingRecords)
    .innerJoin(schema.bookingTemplates, eq(schema.bookingRecords.templateId, schema.bookingTemplates.id))
    .where(
      and(
        eq(schema.bookingTemplates.contractAction, "退租"),
        eq(schema.bookingRecords.status, "confirmed"),
        gte(schema.bookingRecords.bookingTime, tomorrowTpMidnightUtcMs),
        lt(schema.bookingRecords.bookingTime, endMs),
      ),
    );

  let inserted = 0;
  for (const b of rows) {
    const bookingDate = taipeiYmd(b.bookingTime);
    const vars = {
      booking_id: b.id,
      booking_date: bookingDate,
      booking_time: taipeiHm(b.bookingTime),
      tenant_name: b.tenantName || "",
      room: b.roomNumber || "",
    };
    const r = await sbQuery<{ id: string }>(
      `insert into outreach.schedule
         (tenant_uid, tenant_name, room, property_name, rule_key, scheduled_date, status, send_at, source, vars, dedupe_key)
       values ($1,$2,$3,$4,'checkout_d1',$5::date,'confirmed',$6::timestamptz,'booking',$7::jsonb,$8)
       on conflict (dedupe_key) where dedupe_key is not null do nothing
       returning id`,
      [
        b.tenantUid, b.tenantName || null, b.roomNumber || null, b.address || null,
        todayYmd, sendAtIso, JSON.stringify(vars), `checkout_d1:${b.id}:${bookingDate}`,
      ],
    );
    inserted += r.length;
  }
  console.log(`[outreach] scan-checkout: scanned ${rows.length}, inserted ${inserted}`);
  return { ok: true, scanned: rows.length, inserted };
}

/** 投遞 API 核心：驗欄位 → 寫排程（source='api'、自動確認、去重碼擋重複）。 */
export async function enqueueMessage(body: any): Promise<{ status: number; json: any }> {
  if (!isSupabaseConfigured()) return { status: 503, json: { error: "SUPABASE_DB_URL not set" } };
  const dedupeKey = String(body?.dedupeKey || "").trim();
  if (!dedupeKey) return { status: 400, json: { error: "missing: dedupeKey" } };
  const card = body?.card;
  if (!card || typeof card !== "object") return { status: 400, json: { error: "missing/invalid: card（須為 LINE message 或 bubble JSON 物件）" } };
  const uid = String(body?.to?.uid || "").trim();
  const phone = String(body?.to?.phone || "").trim();
  if ((!uid && !phone) || (uid && phone)) return { status: 400, json: { error: "to.uid 或 to.phone 擇一必填" } };
  const immediate = body?.immediate === true;
  let sendAtMs: number;
  if (immediate) {
    sendAtMs = Date.now(); // 立即發送：當下時間
  } else {
    sendAtMs = Date.parse(String(body?.sendAt || ""));
    if (Number.isNaN(sendAtMs)) return { status: 400, json: { error: "missing/invalid: sendAt（ISO 時間，例 2026-06-15T10:00:00+08:00）；或帶 immediate:true 立即發送" } };
  }
  const tag = String(body?.tag || "").trim();
  if (!tag) return { status: 400, json: { error: "missing: tag" } };
  const altText = body?.altText ? String(body.altText) : null;

  const r = await sbQuery<{ id: string }>(
    `insert into outreach.schedule
       (tenant_uid, recipient_phone, scheduled_date, status, send_at, source, tag, card_override, alt_text, dedupe_key)
     values ($1,$2,$3::date,'confirmed',$4::timestamptz,'api',$5,$6::jsonb,$7,$8)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [
      uid || null, phone || null, taipeiYmd(sendAtMs), new Date(sendAtMs).toISOString(),
      tag, JSON.stringify(card), altText, dedupeKey,
    ],
  );
  if (r.length) {
    if (immediate) {
      // 立即發送：寫入後當下直接走發送流程，同步回報結果（仍受測試模式重導保護）
      const result = await runOutreach([r[0].id]);
      return {
        status: 200,
        json: { ok: true, id: r[0].id, deduped: false, immediate: true, sent: result.sent, suppressed: result.suppressed, failed: result.failed, error: result.errors[0]?.error ?? null },
      };
    }
    return { status: 200, json: { ok: true, id: r[0].id, deduped: false } };
  }
  const existing = await sbQuery<{ id: string }>(`select id from outreach.schedule where dedupe_key=$1`, [dedupeKey]);
  return { status: 200, json: { ok: true, id: existing[0]?.id ?? null, deduped: true } };
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
  `id, tenant_uid, tenant_name, room, property_name, contract_no,
   to_char(contract_end_date,'YYYY-MM-DD') as contract_end_date,
   rule_key, to_char(scheduled_date,'YYYY-MM-DD') as scheduled_date,
   status, manually_edited, suppressed_reason, sent_at,
   last_error, to_char(last_attempt_at,'YYYY-MM-DD HH24:MI') as last_attempt_at, attempt_count,
   source, tag, to_char(send_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI') as send_at`;

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

  /** 列出排程（可帶 status / ruleKey / search(姓名/房號/案場/合約號) / from / to 過濾） */
  listSchedule: adminProcedure
    .input(
      z
        .object({
          status: z
            .enum(["pending", "confirmed", "sent", "skipped", "cancelled", "suppressed"])
            .optional(),
          statuses: z
            .array(z.enum(["pending", "confirmed", "sent", "skipped", "cancelled", "suppressed"]))
            .optional(),
          ruleKey: z.string().optional(),
          source: z.enum(["rule", "booking", "api"]).optional(),
          tag: z.string().optional(),
          search: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          onlyFailed: z.boolean().optional(),
          limit: z.number().int().min(1).max(2000).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      if (!isSupabaseConfigured()) return [];
      const clauses: string[] = [];
      const params: any[] = [];
      if (input?.statuses && input.statuses.length) {
        params.push(input.statuses);
        clauses.push(`status = any($${params.length})`);
      } else if (input?.status) {
        params.push(input.status);
        clauses.push(`status = $${params.length}`);
      }
      if (input?.ruleKey) {
        params.push(input.ruleKey);
        clauses.push(`rule_key = $${params.length}`);
      }
      if (input?.source) {
        params.push(input.source);
        clauses.push(`source = $${params.length}`);
      }
      if (input?.tag) {
        params.push(input.tag);
        clauses.push(`tag = $${params.length}`);
      }
      if (input?.search && input.search.trim()) {
        params.push(`%${input.search.trim()}%`);
        clauses.push(
          `(tenant_name ilike $${params.length} or room ilike $${params.length} or property_name ilike $${params.length} or contract_no ilike $${params.length})`,
        );
      }
      if (input?.onlyFailed) {
        clauses.push(`status <> 'sent' and attempt_count > 0 and last_error is not null`);
      }
      if (input?.from) {
        params.push(input.from);
        clauses.push(`scheduled_date >= $${params.length}`);
      } else if (!input?.status && !input?.statuses && !input?.onlyFailed) {
        clauses.push(`scheduled_date >= current_date`); // 預設只看未來
      }
      if (input?.to) {
        params.push(input.to);
        clauses.push(`scheduled_date <= $${params.length}`);
      }
      params.push(input?.limit ?? 1000);
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      // 歷史（已發送/抑制/跳過）依事件時間倒序；未來排程依排定日正序
      const orderBy = input?.onlyFailed
        ? "last_attempt_at desc nulls last"
        : input?.status === "sent" || input?.status === "suppressed" || input?.status === "skipped"
          ? "updated_at desc nulls last"
          : "scheduled_date asc, tenant_name asc nulls last";
      return await sbQuery(
        `select ${SCHEDULE_COLS}, to_char(updated_at,'YYYY-MM-DD HH24:MI') as updated_at
         from outreach.schedule ${where} order by ${orderBy} limit $${params.length}`,
        params,
      );
    }),

  /** 統計：在 from/to 區間內，各 rule × status 的數量（看板上方一目瞭然用） */
  scheduleSummary: adminProcedure
    .input(z.object({ from: z.string().optional(), to: z.string().optional() }).optional())
    .query(async ({ input }) => {
      if (!isSupabaseConfigured()) return [];
      const clauses: string[] = [];
      const params: any[] = [];
      if (input?.from) {
        params.push(input.from);
        clauses.push(`scheduled_date >= $${params.length}`);
      }
      if (input?.to) {
        params.push(input.to);
        clauses.push(`scheduled_date <= $${params.length}`);
      }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return await sbQuery(
        `select rule_key, status, count(*)::int as n from outreach.schedule ${where} group by rule_key, status`,
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
        scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      switch (input.action) {
        case "reschedule": {
          if (!input.scheduledDate)
            throw new TRPCError({ code: "BAD_REQUEST", message: "缺少 scheduledDate" });
          // 日期＋時刻一起更新 send_at（以台北時間解讀）；未給時刻沿用原 send_at 的時刻
          const t = input.scheduledTime
            ? `$3::time`
            : `coalesce((send_at at time zone 'Asia/Taipei')::time, '09:00'::time)`;
          const params = input.scheduledTime
            ? [input.id, input.scheduledDate, input.scheduledTime]
            : [input.id, input.scheduledDate];
          await sbQuery(
            `update outreach.schedule
                set scheduled_date=$2::date,
                    send_at=(($2::date + ${t})::timestamp at time zone 'Asia/Taipei'),
                    manually_edited=true, updated_at=now()
              where id=$1`,
            params,
          );
          break;
        }
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

  /** 批次：對多筆一次確認 / 跳過（逐筆回報，個別失敗不中斷其餘） */
  updateScheduleItemsBatch: adminProcedure
    .input(
      z.object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        action: z.enum(["confirm", "skip"]),
      }),
    )
    .mutation(async ({ input }) => {
      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of input.ids) {
        try {
          results.push(input.action === "confirm" ? await confirmOne(id) : await skipOne(id));
        } catch (e: any) {
          results.push({ id, ok: false, error: String(e?.message || e) });
        }
      }
      return { results };
    }),

  /** 批次：對多筆一次立即送（逐筆走完整 gate＋測試重導；序列化並小幅節流，避免 LINE rate limit） */
  sendNowBatch: adminProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }))
    .mutation(async ({ input }) => {
      const results: { id: string; ok: boolean; outcome?: string; error?: string }[] = [];
      for (const id of input.ids) {
        try {
          const r = await runOutreach([id]);
          if (r.sent) results.push({ id, ok: true, outcome: "sent" });
          else if (r.suppressed) results.push({ id, ok: true, outcome: "suppressed" });
          else if (r.skipped) results.push({ id, ok: false, outcome: "skipped", error: "狀態非 pending/confirmed，未送" });
          else if (r.failed) results.push({ id, ok: false, outcome: "failed", error: r.errors[0]?.error || "發送失敗" });
          else results.push({ id, ok: false, error: "查無此排程" });
        } catch (e: any) {
          results.push({ id, ok: false, error: String(e?.message || e) });
        }
        await new Promise((res) => setTimeout(res, 120)); // 節流
      }
      return { results };
    }),

  /** 單筆預覽：用實際變數渲染後只送到測試對象（test_redirect_uid）；永不送室友、不改狀態、不經派送 */
  previewScheduleItem: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      if (!isSupabaseConfigured())
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SUPABASE_DB_URL 未設定" });
      const redirect =
        (
          await sbQuery<{ u: string | null }>(
            `select nullif(trim(test_redirect_uid),'') as u from outreach.settings where id=1`,
          )
        )[0]?.u || null;
      if (!redirect)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "請先到『篩選設定』填入測試 LINE 對象後再預覽；預覽只會送到測試對象、不會送給室友。",
        });
      const rows = await sbQuery<ScheduleRow & { card_template: any }>(
        `select s.id, s.tenant_uid, s.tenant_name, s.room, s.property_name, s.contract_no,
                to_char(s.contract_end_date,'YYYY-MM-DD') as contract_end_date,
                s.rule_key, to_char(s.scheduled_date,'YYYY-MM-DD') as scheduled_date,
                s.status, s.manually_edited, s.suppressed_reason, s.sent_at, r.card_template
           from outreach.schedule s join outreach.rule r on r.key = s.rule_key
          where s.id = $1`,
        [input.id],
      );
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "查無此排程" });
      const row = rows[0];
      const msg = toFlexMessage(
        renderTemplate(row.card_template, computeVars(row)),
        "【預覽】" + (RULE_ALT_TEXT[row.rule_key] || "一方生活通知"),
      );
      const push = await pushLineDirect(redirect, msg);
      if (!push.success)
        throw new TRPCError({ code: "BAD_REQUEST", message: push.error || "預覽發送失敗" });
      return { ok: true, redirectedTo: redirect };
    }),

  /** 發送成效統計：每月各狀態數量 + 失敗比例與示警（以既有欄位彙總，不另建表） */
  getOutreachStats: adminProcedure
    .input(z.object({ months: z.number().int().min(1).max(24).optional() }).optional())
    .query(async ({ input }) => {
      if (!isSupabaseConfigured()) return { buckets: [], threshold: 0.2 };
      const months = input?.months ?? 6;
      const rows = await sbQuery<{
        month: string;
        sent: number;
        suppressed: number;
        skipped: number;
        pending: number;
        confirmed: number;
        failed: number;
      }>(
        `select to_char(date_trunc('month', coalesce(sent_at, last_attempt_at, updated_at)),'YYYY-MM') as month,
                count(*) filter (where status='sent')::int as sent,
                count(*) filter (where status='suppressed')::int as suppressed,
                count(*) filter (where status='skipped')::int as skipped,
                count(*) filter (where status='pending')::int as pending,
                count(*) filter (where status='confirmed')::int as confirmed,
                count(*) filter (where status<>'sent' and attempt_count>0 and last_error is not null)::int as failed
           from outreach.schedule
          where (status in ('sent','suppressed','skipped') or attempt_count > 0)
            and coalesce(sent_at, last_attempt_at, updated_at) >= (date_trunc('month', current_date) - make_interval(months => $1))
          group by 1
          order by 1`,
        [months - 1],
      );
      const threshold = 0.2;
      const buckets = rows.map((r) => {
        const denom = r.sent + r.failed;
        const ratio = denom > 0 ? r.failed / denom : 0;
        return { ...r, ratio: Math.round(ratio * 1000) / 1000, warn: ratio > threshold };
      });
      return { buckets, threshold };
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
      `select key, label, trigger_basis, offset_days, enabled, card_template, sort_order, auto_confirm,
              to_char(send_time,'HH24:MI') as send_time
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
        autoConfirm: z.boolean().optional(),
        sendTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
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
      if (input.autoConfirm !== undefined) {
        params.push(input.autoConfirm);
        sets.push(`auto_confirm=$${params.length}`);
      }
      if (input.sendTime !== undefined) {
        params.push(input.sendTime);
        sets.push(`send_time=$${params.length}::time`);
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

  /** 未綁 UID 主客清單：有效合約但鏡像無 line_uid（可篩 N 天內到期，供人工聯繫到期詢問對象） */
  listUnboundTenants: adminProcedure
    .input(z.object({ expiringWithinDays: z.number().int().min(1).max(365).optional() }).optional())
    .query(async ({ input }) => {
      if (!isSupabaseConfigured()) return [];
      const params: any[] = [];
      let having = "";
      if (input?.expiringWithinDays) {
        params.push(input.expiringWithinDays);
        having = `having max(tc.end_date) between current_date and current_date + make_interval(days => $${params.length})`;
      }
      return await sbQuery(
        `select t.primary_name as tenant_name, t.primary_phone as phone,
                p.short_name as property_name, coalesce(u.unit_no, u.room_code) as room,
                to_char(max(tc.end_date),'YYYY-MM-DD') as contract_end_date
           from contract.tenants t
           join contract.tenant_contract_parties tcp on tcp.tenant_id = t.id
           join contract.tenant_contracts tc on tc.id = tcp.tenant_contract_id
                and tc.status = 'active' and tc.deleted_at is null
           join property.properties p on p.id = tc.property_id
           left join property.units u on u.id = tc.unit_id
          where (t.line_uid is null or t.line_uid = '')
          group by t.id, t.primary_name, t.primary_phone, p.short_name, coalesce(u.unit_no, u.room_code)
          ${having}
          order by max(tc.end_date) asc nulls last
          limit 2000`,
        params,
      );
    }),

  /** 取得設定（篩選集合 + 派送設定；run_secret 不回傳明文，只回是否已設定） */
  getSettings: adminProcedure.query(async () => {
    if (!isSupabaseConfigured()) return null;
    const rows = await sbQuery(
      `select include_ownership_regions, exclude_hq_categories, run_endpoint_url,
              (run_secret is not null and run_secret <> '') as run_secret_set,
              test_redirect_uid, feedback_survey, notify_uids
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
        notifyUids: z.string().optional(),
        feedbackSurvey: z.any().optional(),
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
      // 通知名單：允許空字串（＝清空名單，不通知任何人）
      if (input.notifyUids !== undefined) {
        params.push(input.notifyUids.trim());
        sets.push(`notify_uids=$${params.length}`);
      }
      // 問卷內容：必須是 JSON 物件
      if (input.feedbackSurvey !== undefined) {
        if (typeof input.feedbackSurvey !== "object" || input.feedbackSurvey === null)
          throw new TRPCError({ code: "BAD_REQUEST", message: "feedback_survey 必須是 JSON 物件" });
        params.push(JSON.stringify(input.feedbackSurvey));
        sets.push(`feedback_survey=$${params.length}::jsonb`);
      }
      if (!sets.length) return { ok: true };
      sets.push(`updated_at=now()`);
      await sbQuery(`update outreach.settings set ${sets.join(", ")} where id=1`, params);
      return { ok: true };
    }),
});
