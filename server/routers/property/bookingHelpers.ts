/**
 * Shared helper functions for booking router handlers.
 * Extracted from booking.ts to enable handler module reuse.
 */
import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { TRPCError } from "@trpc/server";

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
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Ragic PUT（更新現有記錄） */
export async function ragicPut(ragicPath: string, ragicId: number, data: Record<string, any>) {
  const url = `${BASE}/${APP}/${ragicPath}/${ragicId}?v=3&api=&doFormula=true&doLinkLoad=first&doDefaultValue=true`;
  console.log(`[Ragic Payload] PUT to ${ragicPath}/${ragicId}:`, JSON.stringify(data, null, 2));
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
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** 從 Ragic 房客記錄中提取房源資訊（for-system-use/2 表） */
export function extractTenantInfo(record: any) {
  const tenantName = record["房客姓名1"] || record["姓名"] || record["租客姓名"] || record["Name"] || "";
  const phone = record["連絡電話1"] || "";
  const ragicId = record["_ragicId"];
  
  let roomNumber = record["目前入住房間"] || "";
  let propertyName = record["案場簡稱"] || "";
  let address = record["現居地址"] || "";
  let contractStatus = record["最新契約狀態"] || "";
  let contractId = record["最新合約編號"] || "";
  let propertyId = record["案場編號"] || "";
  
  return { tenantName, phone, roomNumber, propertyName, address, contractStatus, contractId, propertyId, ragicId };
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

  const [phoneResults, nameResults] = await Promise.all([
    normalizedPhone ? ragicGet("service-department/4", {
      where: `租客手機1,eq,${normalizedPhone}`,
      limit: "10",
    }) : Promise.resolve({}),
    tenantName ? ragicGet("service-department/4", {
      where: `姓名1,eq,${tenantName}`,
      limit: "10",
    }) : Promise.resolve({}),
  ]);

  const seen = new Set<string>();
  const allRecords = [...Object.values(phoneResults), ...Object.values(nameResults)]
    .filter((r: any) => {
      const id = String(r._ragicId || r["_ragicId"] || JSON.stringify(r));
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }) as any[];

  if (allRecords.length === 0) return null;

  const activeContracts = allRecords.filter((r: any) => r["契約狀態"] === "存在");
  if (activeContracts.length === 0) return null;
  const target = activeContracts[0];

  const rooms = target["房間編號(可多選)"];
  const roomNumber = Array.isArray(rooms) ? rooms.join(", ") : (rooms || "");

  if (roomNumber) {
    return {
      roomNumber,
      propertyName: target["案場簡稱(群組名稱)"] || "",
      contractId: target["合約編號"] || "",
      contractStatus: target["契約狀態"] || "",
    };
  }

  return null;
}

/** 從 go-back/22 合約管理表查詢租客最新合約的 Ragic 記錄 ID（用電話欄位 1007360） */
export async function lookupLatestContractRecordId(phone: string): Promise<number | null> {
  const normalized = phone ? phone.replace(/[\s\-()]/g, "") : "";
  if (!normalized) return null;
  try {
    const data = await ragicGet("go-back/22", {
      where: `1007360,eq,${normalized}`,
      limit: "5",
    });
    const records = Object.values(data) as any[];
    if (records.length === 0) {
      console.log("[Contract] go-back/22 查無合約，電話:", normalized);
      return null;
    }
    const sorted = records
      .map((r: any) => Number(r["_ragicId"]))
      .filter((id) => !isNaN(id) && id > 0)
      .sort((a, b) => b - a);
    const result = sorted.length > 0 ? sorted[0] : null;
    console.log("[Contract] go-back/22 最新合約 _ragicId:", result);
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
