/**
 * P23 — 預約卡片動作：取消 / 變更時間（退租 + 續約共用）。
 *
 * 卡片上的兩顆按鈕（在 bookingConfirmHandler 的 flex）以 URI 開啟預約 LIFF：
 *   ?reschedule=<bookingId> → 改期模式（選新時段 → rescheduleBooking 更新 Ragic 日期）
 *   ?cancel=<bookingId>     → 取消確認頁（→ cancelBookingPublic 硬刪除 Ragic 任務）
 *
 * 安全：所有動作都用 LINE uid 比對該筆預約的 tenantUid，避免猜 bookingId 亂改/亂刪。
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { ragicPut, ragicDelete, ragicExecuteButton } from "./bookingHelpers";
import { relayPush } from "./bookingConfirmHandler";

// ─── LINE 卡片小工具（取消 / 變更後通知）──────────────────────────────────

function taipeiParts(ms: number) {
  const t = new Date(ms + 8 * 3600000);
  const wd = ["日", "一", "二", "三", "四", "五", "六"][t.getUTCDay()];
  return {
    dateStr: `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}`,
    weekday: wd,
    timeStr: `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`,
  };
}

/** 卡片底部動作按鈕（變更時間 / 取消），需 liffId */
function buildActionFooter(liffId: string | null, bookingId: number, templateType: string): any | undefined {
  if (!liffId) return undefined;
  return {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [
      { type: "button", style: "primary", height: "sm", color: "#4A6741",
        action: { type: "uri", label: `變更${templateType}時間`, uri: `https://liff.line.me/${liffId}?reschedule=${bookingId}` } },
      { type: "button", style: "secondary", height: "sm",
        action: { type: "uri", label: `取消${templateType}`, uri: `https://liff.line.me/${liffId}?cancel=${bookingId}` } },
    ],
    paddingAll: "16px",
  };
}

/** 通用資訊卡（header 色塊 + 資料列 + 可選 footer/note） */
function buildSimpleCard(opts: {
  title: string;
  headerColor: string;
  altText: string;
  rows: { label: string; value: string }[];
  note?: string;
  footer?: any;
}) {
  const bubble: any = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      contents: [{ type: "text", text: opts.title, size: "lg", weight: "bold", color: "#FFFFFF", wrap: true }],
      backgroundColor: opts.headerColor,
      paddingAll: "20px",
    },
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        ...opts.rows.map((r) => ({
          type: "box",
          layout: "horizontal",
          margin: "md",
          contents: [
            { type: "text", text: r.label, size: "sm", color: "#8C8C8C", flex: 2 },
            { type: "text", text: r.value, size: "sm", color: "#333333", weight: "bold", flex: 4, wrap: true },
          ],
        })),
        ...(opts.note
          ? [
              { type: "separator", margin: "xl" },
              { type: "text", text: opts.note, size: "xs", color: "#AAAAAA", margin: "lg", wrap: true, align: "center" },
            ]
          : []),
      ],
      paddingAll: "20px",
    },
  };
  if (opts.footer) bubble.footer = opts.footer;
  return { type: "flex" as const, altText: opts.altText, contents: bubble };
}

/** 取得預約 + 對應模版（含 uid 比對）。回傳 { record, template }。 */
async function loadOwnedBooking(bookingId: number, uid: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

  const [record] = await db
    .select()
    .from(schema.bookingRecords)
    .where(eq(schema.bookingRecords.id, bookingId));
  if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "找不到這筆預約" });

  // 安全：uid 必須與該筆預約的 tenantUid 相符
  if (!uid || !record.tenantUid || record.tenantUid !== uid) {
    throw new TRPCError({ code: "FORBIDDEN", message: "無權限操作這筆預約" });
  }

  const [template] = await db
    .select()
    .from(schema.bookingTemplates)
    .where(eq(schema.bookingTemplates.id, record.templateId));
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "預約模版不存在" });

  return { db, record, template };
}

/** 改期前先取得這筆預約的基本資料（前端跳過驗證直接進選時段用） */
export async function handleGetBookingForReschedule(input: { bookingId: number; uid: string }) {
  const { record, template } = await loadOwnedBooking(input.bookingId, input.uid);
  return {
    bookingId: record.id,
    projectId: template.projectId,
    templateType: template.templateType,
    tenantName: record.tenantName || "",
    roomNumber: record.roomNumber || "",
    address: record.address || "",
    currentBookingTime: record.bookingTime,
    durationMinutes: record.durationMinutes,
    status: record.status,
  };
}

/** 取消預約：硬刪除 Ragic 任務 + 本地標記取消 */
export async function handleCancelBookingPublic(input: { bookingId: number; uid: string }) {
  const { db, record, template } = await loadOwnedBooking(input.bookingId, input.uid);

  if (record.status === "cancelled") {
    return { success: true, alreadyCancelled: true };
  }

  // 刪除 Ragic 任務：優先觸發動作按鈕（按鈕內部會發 webhook 刪 Google 日曆 + 刪除該筆）；
  // 未設定按鈕 ID 時退回直接 DELETE（不連動日曆）。
  if (record.ragicRecordId) {
    const numericId = Number(record.ragicRecordId);
    if (!isNaN(numericId) && numericId > 0) {
      const buttonId = process.env.RAGIC_CANCEL_BUTTON_ID || "42"; // go-back/1 取消動作按鈕 bId
      // ① 先觸發動作按鈕 → 發 webhook 刪 Google 日曆（best-effort，失敗不擋後續刪除）
      if (buttonId) {
        try {
          await ragicExecuteButton(template.ragicTaskPath, numericId, buttonId);
          console.log(`[Reschedule] 已觸發取消動作按鈕（刪 Google 日曆）${template.ragicTaskPath}/${numericId} bId=${buttonId}`);
        } catch (err: any) {
          console.error("[Reschedule] 動作按鈕觸發失敗（仍繼續刪 Ragic）:", err.message);
        }
      }
      // ② 刪除 Ragic 任務記錄（關鍵動作，失敗才算取消失敗）
      try {
        await ragicDelete(template.ragicTaskPath, numericId);
        console.log(`[Reschedule] 已刪除 Ragic 任務 ${template.ragicTaskPath}/${numericId}`);
      } catch (err: any) {
        console.error("[Reschedule] Ragic 刪除失敗:", err.message);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "取消失敗，請稍後再試或聯繫客服" });
      }
    }
  }

  await db
    .update(schema.bookingRecords)
    .set({ status: "cancelled", cancelReason: "租客自行取消" })
    .where(eq(schema.bookingRecords.id, record.id));

  // 送出「已取消」卡片（fire-and-forget，失敗不影響結果）
  if (record.tenantUid) {
    const p = taipeiParts(record.bookingTime);
    const rows = [
      { label: "類型", value: template.templateType },
      { label: "姓名", value: record.tenantName || "" },
      ...(record.roomNumber ? [{ label: "房間", value: record.roomNumber }] : []),
      { label: "原時間", value: `${p.dateStr}（${p.weekday}）${p.timeStr}` },
    ];
    relayPush(
      record.tenantUid,
      buildSimpleCard({
        title: `已取消${template.templateType}`,
        headerColor: "#9CA3AF",
        altText: `已取消${template.templateType}預約`,
        rows,
        note: "此預約已取消，如需重新預約請聯繫一方或重新開啟預約連結。",
      }),
    ).catch(() => {});
  }

  return { success: true };
}

/** 變更時間：更新 Ragic 任務日期 + 本地紀錄 */
export async function handleRescheduleBooking(input: {
  bookingId: number;
  uid: string;
  date: string;
  startTime: string; // ISO
  endTime: string; // ISO
  calendarId: string;
  assigneeName: string;
}) {
  const { db, record, template } = await loadOwnedBooking(input.bookingId, input.uid);

  if (record.status === "cancelled") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "此預約已取消，無法變更" });
  }

  // 計算台北時間字串（與 confirm handler 一致）
  const startDt = new Date(input.startTime);
  const taipeiOffset = 8 * 60 * 60 * 1000;
  const taipeiTime = new Date(startDt.getTime() + taipeiOffset);
  const ragicDateTime = `${taipeiTime.getUTCFullYear()}/${String(taipeiTime.getUTCMonth() + 1).padStart(2, "0")}/${String(taipeiTime.getUTCDate()).padStart(2, "0")} ${String(taipeiTime.getUTCHours()).padStart(2, "0")}:${String(taipeiTime.getUTCMinutes()).padStart(2, "0")}`;
  const m = taipeiTime.getUTCMonth() + 1;
  const d = taipeiTime.getUTCDate();
  const taskName = `${m}/${d}${template.templateType}${record.roomNumber || ""}(${record.tenantName || ""})`;

  // 更新 Ragic 任務（日期/任務名/負責人）
  if (record.ragicRecordId) {
    const numericId = Number(record.ragicRecordId);
    if (!isNaN(numericId) && numericId > 0) {
      try {
        await ragicPut(template.ragicTaskPath, numericId, {
          "1012114": ragicDateTime,
          "1012112": taskName,
          "1012113": input.assigneeName,
        });
        console.log(`[Reschedule] 已更新 Ragic 任務 ${template.ragicTaskPath}/${numericId} → ${ragicDateTime}`);
      } catch (err: any) {
        console.error("[Reschedule] Ragic 更新失敗:", err.message);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "變更失敗，請稍後再試或聯繫客服" });
      }
    }
  }

  // 更新本地紀錄
  await db
    .update(schema.bookingRecords)
    .set({
      bookingTime: new Date(input.startTime).getTime(),
      assigneeName: input.assigneeName,
      googleCalendarId: input.calendarId,
    })
    .where(eq(schema.bookingRecords.id, record.id));

  // 送出「已更新時間」卡片（保留動作按鈕，可再次變更/取消）
  if (record.tenantUid) {
    const s = taipeiParts(new Date(input.startTime).getTime());
    const e = taipeiParts(new Date(input.endTime).getTime());
    const rows = [
      { label: "類型", value: template.templateType },
      { label: "姓名", value: record.tenantName || "" },
      ...(record.roomNumber ? [{ label: "房間", value: record.roomNumber }] : []),
      { label: "新日期", value: `${s.dateStr}（${s.weekday}）` },
      { label: "新時間", value: `${s.timeStr} - ${e.timeStr}` },
      { label: "負責人", value: input.assigneeName },
    ];
    relayPush(
      record.tenantUid,
      buildSimpleCard({
        title: "✅ 已更新預約時間",
        headerColor: "#4A6741",
        altText: `已更新${template.templateType}時間 ${s.dateStr} ${s.timeStr}`,
        rows,
        footer: buildActionFooter(template.liffId, record.id, template.templateType),
        note: template.liffId ? undefined : "如需再次變更或取消，請聯繫我們",
      }),
    ).catch(() => {});
  }

  return { success: true, bookingId: record.id };
}
