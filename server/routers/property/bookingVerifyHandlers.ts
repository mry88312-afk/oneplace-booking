/**
 * Handler functions for tenant verification procedures.
 * Extracted from booking.ts for maintainability.
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import {
  ragicGet,
  ragicPut,
  extractTenantInfo,
  lookupLatestContractRecordId,
  RAGIC_API_KEY_VALUE,
} from "./bookingHelpers";

export async function handleVerifyTenantUid(input: {
  projectId: string;
  uid: string;
}) {
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (err: any) {
    console.error("[Booking-Verify] DB connection failed:", err?.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });
  }
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });

  let template: typeof schema.bookingTemplates.$inferSelect | undefined;
  try {
    const [row] = await db
      .select()
      .from(schema.bookingTemplates)
      .where(
        and(
          eq(schema.bookingTemplates.projectId, input.projectId),
          eq(schema.bookingTemplates.isActive, true)
        )
      );
    template = row;
  } catch (err: any) {
    console.error("[Booking-Verify] DB query failed:", err?.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });
  }
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });

  if (!RAGIC_API_KEY_VALUE) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ragic API 尚未設定" });
  }

  const TENANT_TABLE = "for-system-use/2";
  const UID_FIELD = "lineuid";
  console.log("[Booking-Verify] ===== verifyTenantUid 開始 =====");
  console.log("[Booking-Verify] 輸入 UID:", input.uid);
  console.log("[Booking-Verify] 查詢表: ", TENANT_TABLE);
  console.log("[Booking-Verify] 查詢欄位:", UID_FIELD);
  console.log("[Booking-Verify] 查詢條件: where=" + `${UID_FIELD},eq,${input.uid}`);

  let records: any[] = [];
  const data = await ragicGet(TENANT_TABLE, {
    where: `${UID_FIELD},eq,${input.uid}`,
    limit: "1",
  });
  records = Object.values(data) as any[];
  console.log("[Booking-Verify] Ragic where 回傳筆數:", records.length);

  if (records.length === 0) {
    console.log("[Booking-Verify] where 查無結果，改用 fts 全文搜尋");
    const ftsData = await ragicGet(TENANT_TABLE, {
      fts: input.uid,
      limit: "5",
    });
    const ftsRecords = Object.values(ftsData) as any[];
    console.log("[Booking-Verify] fts 回傳筆數:", ftsRecords.length);
    records = ftsRecords.filter((r: any) => r["lineuid"] === input.uid);
    console.log("[Booking-Verify] fts 過濾後匹配筆數:", records.length);
  }

  if (records.length > 0) {
    console.log("[Booking-Verify] 第一筆資料 key fields:", {
      "房客姓名1": records[0]["房客姓名1"],
      "連絡電話1": records[0]["連絡電話1"],
      "lineuid": records[0]["lineuid"],
      "_ragicId": records[0]["_ragicId"],
    });
  } else {
    console.log("[Booking-Verify] Ragic 查無結果！可能原因: UID 不存在於資料表");
    console.log("[Booking-Verify] 原始回傳 data:", JSON.stringify(data).substring(0, 500));
  }

  if (records.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "NEED_PHONE",
    });
  }

  const record = records[0];
  const info = extractTenantInfo(record);
  console.log("[Booking-Verify] extractTenantInfo 結果:", {
    tenantName: info.tenantName,
    roomNumber: info.roomNumber,
    propertyName: info.propertyName,
    address: info.address,
    phone: info.phone,
    ragicId: info.ragicId,
  });

  const contractRecordId = await lookupLatestContractRecordId(info.phone);

  return {
    tenantName: info.tenantName,
    roomNumber: info.roomNumber,
    propertyName: info.propertyName,
    address: info.address,
    phone: info.phone,
    templateId: template.id,
    templateType: template.templateType,
    contractRecordId,
  };
}

export async function handleVerifyByPhone(input: {
  projectId: string;
  phone: string;
  uid?: string;
}) {
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (err: any) {
    console.error("[Booking-Phone] DB connection failed:", err?.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });
  }
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });

  let template: typeof schema.bookingTemplates.$inferSelect | undefined;
  try {
    const [row] = await db
      .select()
      .from(schema.bookingTemplates)
      .where(
        and(
          eq(schema.bookingTemplates.projectId, input.projectId),
          eq(schema.bookingTemplates.isActive, true)
        )
      );
    template = row;
  } catch (err: any) {
    console.error("[Booking-Phone] DB query failed:", err?.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "SERVICE_UNAVAILABLE" });
  }
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });

  if (!RAGIC_API_KEY_VALUE) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ragic API 尚未設定" });
  }

  const normalizedPhone = input.phone.replace(/[\s\-()]/g, "");

  const TENANT_TABLE = "for-system-use/2";
  console.log("[Booking-Phone] ===== verifyByPhone 開始 =====");
  console.log("[Booking-Phone] 輸入電話:", normalizedPhone);
  console.log("[Booking-Phone] 附帶 UID:", input.uid || "(無)");
  console.log("[Booking-Phone] 查詢表:", TENANT_TABLE);

  const PHONE_FIELD_ID = "1007372";
  const whereData = await ragicGet(TENANT_TABLE, {
    where: `${PHONE_FIELD_ID},eq,${normalizedPhone}`,
    limit: "10",
  });
  const allRecords = Object.values(whereData) as any[];
  console.log("[Booking-Phone] Ragic where (field ID 1007372) 查詢回傳筆數:", allRecords.length);

  if (allRecords.length > 0) {
    console.log("[Booking-Phone] 匹配到的第一筆:", {
      "房客姓名1": allRecords[0]["房客姓名1"],
      "連絡電話1": allRecords[0]["連絡電話1"],
      "lineuid": allRecords[0]["lineuid"],
      "目前入住房間": allRecords[0]["目前入住房間"],
      "現居地址": allRecords[0]["現居地址"],
    });
  } else {
    console.log("[Booking-Phone] 電話查詢無結果（where + fts 均無）");
  }

  if (allRecords.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "PHONE_NOT_FOUND",
    });
  }

  const record = allRecords[0];
  const info = extractTenantInfo(record);

  const UID_WRITE_FIELD_ID = "1007383";
  if (input.uid && info.ragicId && !record["lineuid"]) {
    try {
      await ragicPut(TENANT_TABLE, info.ragicId, {
        [UID_WRITE_FIELD_ID]: input.uid,
      });
      console.log(`[Booking] Wrote LINE UID ${input.uid} to Ragic field 1007383, record ${info.ragicId}`);
    } catch (err: any) {
      console.error("[Booking] Failed to write LINE UID to Ragic:", err.message);
    }
  }

  const contractRecordId = await lookupLatestContractRecordId(info.phone);

  return {
    tenantName: info.tenantName,
    roomNumber: info.roomNumber,
    propertyName: info.propertyName,
    address: info.address,
    phone: info.phone,
    templateId: template.id,
    templateType: template.templateType,
    contractRecordId,
  };
}
