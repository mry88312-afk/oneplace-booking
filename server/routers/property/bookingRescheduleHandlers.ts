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
import { ragicPut, ragicDelete } from "./bookingHelpers";

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

  // 硬刪除 Ragic 任務記錄（go-back/1 等 ragicTaskPath）
  if (record.ragicRecordId) {
    const numericId = Number(record.ragicRecordId);
    if (!isNaN(numericId) && numericId > 0) {
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

  return { success: true, bookingId: record.id };
}
