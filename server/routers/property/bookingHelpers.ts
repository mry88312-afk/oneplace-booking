/**
 * Shared helper functions for booking router handlers.
 * Extracted from booking.ts to enable handler module reuse.
 */
import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { getLockedBundle, type LockedBundle } from "../../config/lockedTemplates";

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

const RAGIC_API_KEY = process.env.RAGIC_API_KEY || "";
const BASE = "https://ap13.ragic.com";
const APP = "OnePlaceLiving";

// ─── Timezone helpers ────────────────────────────────────────────────────

/** 正確計算台北時區的星期幾（0=Sunday, 6=Saturday）
 *  避免 getDay() 在 UTC 環境下因時差導致日期偏移 */
export function getTaipeiDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getDay();
}

// ─── Google Calendar helpers ─────────────────────────────────────────────

let _cachedCredentials: any = null;
export function loadServiceAccountCredentials(): any {
  if (_cachedCredentials) return _cachedCredentials;
  const envJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (envJson) {
    try { _cachedCredentials = JSON.parse(envJson); return _cachedCredentials; } catch { /* fall through */ }
  }
  const candidates = [
    path.resolve(__dirname_local, "google-service-account.json"),
    path.resolve(__dirname_local, "..", "google-service-account.json"),
    path.resolve(process.cwd(), "server", "google-service-account.json"),
    path.resolve(process.cwd(), "server", "routers", "google-service-account.json"),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        _cachedCredentials = JSON.parse(raw);
        return _cachedCredentials;
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Google Service Account JSON 檔案格式錯誤" });
      }
    }
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Google Service Account 尚未設定" });
}

export function getCalendarClient() {
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });
  return google.calendar({ version: "v3", auth });
}

// ─── Ragic helpers ───────────────────────────────────────────────────────────

export async function ragicGet(ragicPath: string, params?: Record<string, string>) {
  const url = new URL(`${BASE}/${APP}/${ragicPath}`);
  url.searchParams.set("v", "3");
  url.searchParams.set("api", "");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${RAGIC_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Ragic API error: ${resp.status}`);
  return resp.json();
}

export async function ragicPost(ragicPath: string, data: Record<string, any>) {
  const url = `${BASE}/${APP}/${ragicPath}?v=3&api=&doFormula=true&doLinkLoad=first&doDefaultValue=true`;
  console.log(`[Ragic Payload] POST to ${ragicPath}:`, JSON.stringify(data, null, 2));
  console.log(`[Ragic Payload] URL params: doFormula=true, doLinkLoad=first`);
  // 寫入用 x-www-form-urlencoded（生產已證實可用：含中文任務名的建立皆 status=200）。
  // P87 曾短暫改 JSON，後由生產 log 確認 form-urlencoded 本來就正常而於 P88 回退。
  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) { formBody.append(k, String(v ?? "")); }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${RAGIC_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });
  const text = await resp.text();
  console.log(`[API Response] Ragic POST response (status=${resp.status}):`, text);
  if (!resp.ok) {
    console.error(`[API Response] Ragic POST FAILED: status=${resp.status}, body=${text}`);
    throw new Error(`Ragic POST error: ${resp.status} - ${text}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { raw: text }; }
  // P87 保留：Ragic 驗證/權限失敗時 HTTP 200 但 body 為 {"status":"INVALID"/"ERROR",...}；
  // 必須視為失敗丟出，才能被上層 catch 到並觸發告警（否則又是無聲失敗）。
  if (parsed?.status === "INVALID" || parsed?.status === "ERROR") {
    console.error(`[API Response] Ragic POST body ERROR:`, parsed.msg || text);
    throw new Error(`Ragic POST body error: ${parsed.msg || text}`);
  }
  return parsed;
}

/** Ragic PUT（更新現有記錄） */
export async function ragicPut(ragicPath: string, ragicId: number, data: Record<string, any>) {
  const url = `${BASE}/${APP}/${ragicPath}/${ragicId}?v=3&api=&doFormula=true&doLinkLoad=first&doDefaultValue=true`;
  console.log(`[Ragic Payload] PUT to ${ragicPath}/${ragicId}:`, JSON.stringify(data, null, 2));
  // 同 ragicPost：寫入用 form-urlencoded（P88 回退；生產已證實可用）。
  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) { formBody.append(k, String(v ?? "")); }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${RAGIC_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });
  const text = await resp.text();
  console.log(`[API Response] Ragic PUT response (status=${resp.status}):`, text);
  if (!resp.ok) {
    console.error(`[API Response] Ragic PUT FAILED: status=${resp.status}, body=${text}`);
    throw new Error(`Ragic PUT error: ${resp.status} - ${text}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { raw: text }; }
  // Ragic 驗證/權限失敗時 HTTP 200 但 body 是 {"status":"INVALID"/"ERROR","msg":"..."}
  if (parsed?.status === "INVALID" || parsed?.status === "ERROR") {
    console.error(`[API Response] Ragic PUT body ERROR:`, parsed.msg || text);
    throw new Error(`Ragic PUT body error: ${parsed.msg || text}`);
  }
  return parsed;
}

/** Ragic 硬刪除一筆記錄（HTTP DELETE）。用於取消預約時刪掉任務表記錄。
 *  純刪除、不帶 doWorkflow：刪 Google 日曆的 webhook 由動作按鈕(bId)負責，
 *  避免刪除再觸發一次工作流程造成重複。 */
export async function ragicDelete(ragicPath: string, ragicId: number) {
  const url = `${BASE}/${APP}/${ragicPath}/${ragicId}?v=3&api=`;
  console.log(`[Ragic Payload] DELETE ${ragicPath}/${ragicId}`);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Basic ${RAGIC_API_KEY}` },
  });
  const text = await resp.text();
  console.log(`[API Response] Ragic DELETE response (status=${resp.status}):`, text);
  if (!resp.ok) {
    console.error(`[API Response] Ragic DELETE FAILED: status=${resp.status}, body=${text}`);
    throw new Error(`Ragic DELETE error: ${resp.status} - ${text}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { raw: text }; }
  if (parsed?.status === "ERROR") {
    console.error(`[API Response] Ragic DELETE body ERROR:`, parsed.msg || text);
    throw new Error(`Ragic DELETE body error: ${parsed.msg || text}`);
  }
  return parsed;
}

/**
 * 執行 Ragic 動作按鈕（官方 API 2.3.9 Execute Action Button）。
 *  POST {base}/{app}/{ragicPath}/{recordId}?api&v=3&bId={buttonId}（無 body）。
 *  按鈕內部的 server-side JS 會自行執行（例如：發 webhook 刪 Google 日曆 + query.deleteEntry 刪該筆）。
 *  buttonId 可由 GET {ragicPath}/metadata/actionButton?api&category=massOperation 取得。
 */
export async function ragicExecuteButton(ragicPath: string, ragicId: number, buttonId: string) {
  const url = `${BASE}/${APP}/${ragicPath}/${ragicId}?api&v=3&bId=${encodeURIComponent(buttonId)}`;
  console.log(`[Ragic ActionButton] POST ${ragicPath}/${ragicId} bId=${buttonId}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${RAGIC_API_KEY}` },
  });
  const text = await resp.text();
  console.log(`[API Response] Ragic ActionButton response (status=${resp.status}):`, text.slice(0, 400));
  if (!resp.ok) {
    console.error(`[API Response] Ragic ActionButton FAILED: status=${resp.status}, body=${text}`);
    throw new Error(`Ragic action button error: ${resp.status} - ${text}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { raw: text }; }
  if (parsed?.status === "ERROR") {
    console.error(`[API Response] Ragic ActionButton body ERROR:`, parsed.msg || text);
    throw new Error(`Ragic action button body error: ${parsed.msg || text}`);
  }
  return parsed;
}

/** 從 Ragic 房客記錄中提取房源資訊（for-system-use/2 表）。
 *  以欄位編號（field id）優先讀取，中文欄名做後備，避免顯示名變動造成讀取失敗。 */
export function extractTenantInfo(record: any) {
  const g = (id: string, ...names: string[]): string => {
    const v = record[id];
    if (v !== undefined && v !== null && v !== "") return v;
    for (const n of names) {
      const nv = record[n];
      if (nv !== undefined && nv !== null && nv !== "") return nv;
    }
    return "";
  };
  const tenantName = g("1007373", "房客姓名1", "姓名", "租客姓名", "Name");
  const phone = g("1007372", "連絡電話1");
  const email = g("1007542", "email", "Email", "電子郵件");
  const job = g("1007377", "職業", "工作");
  const ragicId = record["_ragicId"];

  const roomNumber = g("1008436", "目前入住房間");
  const propertyName = g("1010551", "案場簡稱") || g("1015395", "案場簡稱(群組名稱)");
  const address = g("1008440", "現居地址");
  const contractStatus = g("1007796", "最新契約狀態");
  const contractId = g("1019285", "最新合約編號");
  const propertyId = g("1010546", "案場編號");

  return { tenantName, phone, email, job, roomNumber, propertyName, address, contractStatus, contractId, propertyId, ragicId };
}

/** 從 service-department/4 合約表查詢房源資訊（用電話或姓名） */
export async function lookupContractInfo(phone: string, tenantName: string): Promise<{
  roomNumber: string;
  propertyName: string;
  contractId: string;
  contractStatus: string;
} | null> {
  const normalizedPhone = phone ? phone.replace(/[\s\-()]/g, "") : "";
  if (!normalizedPhone && !tenantName) return null;

  // service-department/4 合約表欄位 ID：租客手機1=1007361 / 姓名1=1007544 / 契約狀態=1007778
  //   房間編號(可多選)=1007552 / 案場簡稱(群組名稱)=1015395 / 合約編號=1007360
  const [phoneResults, nameResults] = await Promise.all([
    normalizedPhone ? ragicGet("service-department/4", {
      where: `1007361,eq,${normalizedPhone}`,
      limit: "10",
      naming: "EID",
    }) : Promise.resolve({}),
    tenantName ? ragicGet("service-department/4", {
      where: `1007544,eq,${tenantName}`,
      limit: "10",
      naming: "EID",
    }) : Promise.resolve({}),
  ]);

  const seen = new Set<string>();
  const allRecords = [...Object.values(phoneResults), ...Object.values(nameResults)]
    .filter((r: any) => {
      const id = String(r["_ragicId"] || JSON.stringify(r));
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }) as any[];

  if (allRecords.length === 0) return null;

  const activeContracts = allRecords.filter((r: any) => r["1007778"] === "存在");
  if (activeContracts.length === 0) return null;
  const target = activeContracts[0];

  const rooms = target["1007552"];
  const roomNumber = Array.isArray(rooms) ? rooms.join(", ") : (rooms || "");

  if (roomNumber) {
    return {
      roomNumber,
      propertyName: target["1015395"] || "",
      contractId: target["1007360"] || "",
      contractStatus: target["1007778"] || "",
    };
  }

  return null;
}

/**
 * 從 go-back/22 合約管理表查詢合約的 Ragic 記錄 ID
 * 流程：for-system-use/2 的欄位 1019285（最新合約編號）→ 拿到合約編號
 *       → 去 go-back/22 用欄位 1007360 查該合約編號 → 回傳 _ragicId
 */
export async function lookupLatestContractRecordId(contractNumber: string): Promise<number | null> {
  if (!contractNumber) return null;
  try {
    const data = await ragicGet("go-back/22", {
      where: `1007360,eq,${contractNumber}`,
      limit: "1",
      naming: "EID",
    });
    const records = Object.values(data) as any[];
    if (records.length === 0) {
      console.log("[Contract] go-back/22 查無合約，合約編號:", contractNumber);
      return null;
    }
    const id = Number(records[0]["_ragicId"]);
    const result = !isNaN(id) && id > 0 ? id : null;
    console.log("[Contract] go-back/22 合約 _ragicId:", result, "合約編號:", contractNumber);
    return result;
  } catch (err: any) {
    console.error("[Contract] lookupLatestContractRecordId 失敗:", err.message);
    return null;
  }
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
export const bookingRateMap = new Map<string, { count: number; resetAt: number }>();

/** Ragic 圖片/檔案上傳（multipart/form-data）
 *  Ragic 圖片欄位不接受 JSON 字串，必須用 multipart/form-data 上傳實際檔案
 *  等同 curl: curl -F "fieldId=@file" -F "api=" -F "v=3" -H "Authorization:Basic KEY" URL
 */
export async function ragicUploadFile(
  ragicPath: string,
  ragicId: number,
  fieldId: string,
  fileUrlOrDataUrl: string
): Promise<void> {
  try {
    let arrayBuffer: ArrayBuffer;
    let fileName: string;
    let contentType: string;

    if (fileUrlOrDataUrl.startsWith("data:")) {
      // base64 data URL：前端直接 FileReader 編出來的，沒繞中間站
      // 格式：data:image/jpeg;base64,/9j/4AAQ...
      const match = fileUrlOrDataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) throw new Error("Invalid data URL format");
      contentType = match[1] || "application/octet-stream";
      const base64 = match[2];
      const buffer = Buffer.from(base64, "base64");
      arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
      // 推副檔名（jpeg → jpg 比較通用）
      const subtype = contentType.split("/")[1]?.split("+")[0] || "bin";
      const ext = subtype === "jpeg" ? "jpg" : subtype;
      fileName = `upload.${ext}`;
      console.log(`[Ragic Upload] Decoded base64 data URL, type=${contentType}, size=${arrayBuffer.byteLength}`);
    } else {
      // URL：從遠端下載（舊有的 S3 流程，保留向後相容）
      console.log(`[Ragic Upload] Downloading file from: ${fileUrlOrDataUrl}`);
      const fileResp = await fetch(fileUrlOrDataUrl);
      if (!fileResp.ok) {
        throw new Error(`Failed to download file: ${fileResp.status}`);
      }
      arrayBuffer = await fileResp.arrayBuffer();
      const urlPath = new URL(fileUrlOrDataUrl).pathname;
      fileName = decodeURIComponent(urlPath.split("/").pop() || "upload.jpg");
      contentType = fileResp.headers.get("content-type") || "image/jpeg";
    }
    
    // 2. 用 Node.js 原生 FormData 上傳到 Ragic（模擬 curl -F）
    const url = `${BASE}/${APP}/${ragicPath}/${ragicId}`;
    
    const formData = new FormData();
    // 檔案欄位：等同 curl -F "fieldId=@file"
    const fileBlob = new Blob([arrayBuffer], { type: contentType });
    formData.append(fieldId, fileBlob, fileName);
    // API 參數：等同 curl -F "api=" -F "v=3"
    formData.append("api", "");
    formData.append("v", "3");
    
    console.log(`[Ragic Upload] Uploading to ${ragicPath}/${ragicId}, field=${fieldId}, file=${fileName}, size=${arrayBuffer.byteLength}, contentType=${contentType}`);
    
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${RAGIC_API_KEY}`,
        // 不要手動設定 Content-Type，讓 fetch 自動加上 boundary
      },
      body: formData,
    });
    
    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[Ragic Upload] FAILED: status=${resp.status}, body=${text}`);
      throw new Error(`Ragic upload error: ${resp.status} - ${text}`);
    }
    console.log(`[Ragic Upload] SUCCESS: field=${fieldId}, response=${text.substring(0, 200)}`);
  } catch (err: any) {
    console.error(`[Ragic Upload] Error uploading file to field ${fieldId}:`, err.message);
  }
}

export const RAGIC_API_KEY_VALUE = RAGIC_API_KEY;

/**
 * P19a/P81-A: 統一的模版解析器 — locked 專案 hardcode 優先，其餘走 DB。
 *
 * - 退租/續約（lockedTemplates 命中）→ 直接回 hardcode，**完全不打 DB**
 *     · 這才是 lockedTemplates 的設計原意（見該檔頭註解「先呼叫 getLockedBundle」）
 *     · 省掉每支查詢 1~3 次雲端 MySQL 來回，並確保程式碼即真相（DB 殘留的舊 record 不會反蓋）
 * - 一般專案（後台 BookingAdmin 建立）→ getLockedBundle 回 null → 走 DB 查詢
 * - 都找不到 → 回 null（呼叫端轉 NOT_FOUND）
 *
 * 回傳 { template, fields, rules }（fields/rules 已按 sortOrder 排序），與 LockedBundle 結構一致。
 */
export async function resolveTemplateBundle(
  projectId: string,
): Promise<LockedBundle | null> {
  // P81-A: locked 專案（退租/續約）hardcode 優先、跳過 DB（熱路徑省雲端 DB 來回）
  const locked = getLockedBundle(projectId);
  if (locked) {
    return locked.template.isActive ? locked : null;
  }

  // 一般專案才查 DB
  try {
    const db = await getDb();
    if (db) {
      const [template] = await db
        .select()
        .from(schema.bookingTemplates)
        .where(
          and(
            eq(schema.bookingTemplates.projectId, projectId),
            eq(schema.bookingTemplates.isActive, true),
          ),
        );
      if (template) {
        const fields = await db
          .select()
          .from(schema.bookingFormFields)
          .where(eq(schema.bookingFormFields.templateId, template.id))
          .orderBy(schema.bookingFormFields.sortOrder);
        const rules = await db
          .select()
          .from(schema.calendarRoutingRules)
          .where(eq(schema.calendarRoutingRules.templateId, template.id))
          .orderBy(schema.calendarRoutingRules.sortOrder);
        return { template, fields, rules };
      }
    }
  } catch (err: any) {
    console.error("[resolveTemplateBundle] DB error:", err?.message);
  }

  return null;
}
