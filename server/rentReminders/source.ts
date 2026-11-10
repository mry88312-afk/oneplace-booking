import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { request } from "node:https";
import { Bill, dateOnly } from "./domain";

const LEGACY_ORIGIN = "https://jgbcontractkehsin.zeabur.app";
const MACHINE_ORIGIN = "https://jgb-api.oneplace.com.tw";
const BOOKING_IDENTITY = "calendar-booking@one-place-living-manus.iam.gserviceaccount.com";

async function machinePem(): Promise<string> {
  if (process.env.JGB_BOOKING_MACHINE_PEM) return process.env.JGB_BOOKING_MACHINE_PEM;
  try {
    const { loadServiceAccountCredentials } = await import("../routers/property/bookingHelpers");
    const { google } = await import("googleapis");
    const credentials = loadServiceAccountCredentials();
    if (credentials.client_email !== BOOKING_IDENTITY) throw new Error("Unexpected booking identity");
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const result = await google.secretmanager({ version: "v1", auth }).projects.secrets.versions.access({
      name: "projects/oneplace-20261029/secrets/one820-jgb-booking-mtls/versions/latest",
    }, { timeout: 10000, retry: false });
    if (!result.data.payload?.data) throw new Error("Missing client identity");
    return Buffer.from(result.data.payload.data, "base64").toString("utf8");
  } catch {
    throw new Error("JGB OnePlace 憑證讀取失敗");
  }
}

type ReportRequest = (path: string, body?: object) => Promise<Response>;

function onePlaceClient(): ReportRequest {
  let certificate: string | undefined;
  return async (path, body) => {
    certificate ??= await machinePem();
    return machineResponse(path, certificate, body);
  };
}

export async function checkJgbFallback(onePlace = onePlaceClient()): Promise<boolean> {
  // The existing health header reports reachability of the OnePlace machine interface.
  const response = await onePlace("/machine-health");
  return response.status === 204;
}

function machineResponse(path: string, pem: string, body?: object): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(MACHINE_ORIGIN + path, {
      method: body ? "POST" : "GET", cert: pem, key: pem,
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(path === "/machine-health" ? 5000 : 30000),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) {
          res.destroy(new Error("JGB 匯出回應過大"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const status = res.statusCode ?? 502;
        const content = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString("utf8");
        resolve(new Response(content, { status }));
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const FEES = ["租金", "押金", "車位租金", "車位押金", "電費", "水費", "瓦斯費", "網路費", "第四台",
  "管理費", "車位管理費", "清潔費", "公共服務維護費用", "行政費用", "-續約＿押金遞延", "-折扣"];
function number(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && /^-?\d+(,\d{3})*(\.\d+)?$/.test(v.trim())) return Number(v.replaceAll(",", ""));
  return NaN;
}
function scalar(v: ExcelJS.CellValue): unknown {
  // Do not execute or trust formulas in imported workbooks.
  if (typeof v === "object" && v !== null && !(v instanceof Date)) return null;
  return v;
}
export function parseRows(input: unknown[][]): Bill[] {
  if (!Array.isArray(input) || !Array.isArray(input[0])) throw new Error("JGB 匯出內容無效");
  const headers = input[0].map(x => String(x ?? "").trim());
  const required = ["合約ID", "帳單ID", "帳單狀態", "付款人", "合約租期", "帳單描述", "帳單週期", "物件名稱",
    "繳費期限", "幣別", "應到帳金額", "已到帳金額", ...FEES];
  for (const h of required) if (headers.filter(x => x === h).length !== 1) throw new Error(`JGB 欄位變更：${h}`);
  // Unknown fee columns would make the footer reconciliation incomplete.
  if (headers.slice(headers.indexOf("租金")).some(h => !FEES.includes(h))) throw new Error("JGB 費用欄位變更");
  const bills: Bill[] = [];
  let footer: number | null = null;
  const ids = new Set<string>();
  for (const row of input.slice(1)) {
    if (!Array.isArray(row) || row.every(v => v == null || v === "")) continue;
    const value = (key: string) => row[headers.indexOf(key)];
    const str = (key: string) => String(value(key) ?? "").trim();
    if (!str("帳單ID") && row.includes("總計")) {
      if (footer !== null) throw new Error("JGB 重複總計");
      footer = number(value("應到帳金額")); continue;
    }
    const id = str("帳單ID"), contractId = str("合約ID");
    if (!/^\d+$/.test(id) || !/^\d+$/.test(contractId) || ids.has(id)) throw new Error("JGB 帳單 ID 缺漏或重複");
    ids.add(id);
    if (str("帳單狀態") !== "應到帳") throw new Error("JGB 匯出範圍不是完整應到帳");
    const fees = FEES.map(name => ({ name, amount: number(value(name)) }));
    const total = number(value("應到帳金額"));
    const paid = value("已到帳金額");
    const lease = str("合約租期").match(/^\d{4}-\d{2}-\d{2}\s*~\s*(\d{4}-\d{2}-\d{2})$/);
    let issue: string | null = null;
    if (str("幣別") !== "TWD") issue = "幣別待核對";
    if (fees.some(f => !Number.isFinite(f.amount)) || !Number.isFinite(total) ||
        Math.abs(fees.reduce((s, f) => s + f.amount, 0) - total) > 0.01) issue = "費用明細與整張金額待核對";
    if (paid != null && paid !== "" && number(paid) !== 0) issue = "已有入帳金額，待核對";
    if (!str("帳單描述")) issue = "缺少帳單名稱";
    bills.push({ id, contractId, name: str("帳單描述"), payer: str("付款人"), room: str("物件名稱"),
      due: dateOnly(value("繳費期限")) ?? "", period: str("帳單週期"), leaseEnd: lease?.[1] ?? "",
      total, rent: number(value("租金")), fees: fees.filter(f => f.amount !== 0), issue });
  }
  const sum = bills.reduce((s, b) => s + b.total, 0);
  if (footer === null || !Number.isFinite(footer) || !Number.isFinite(sum) || Math.abs(footer - sum) > 0.01)
    throw new Error("JGB 全部帳單與總計不符，停止通知");
  return bills;
}
export async function parseWorkbook(bytes: ArrayBuffer): Promise<Bill[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  // JGB also exports an invoice sheet; only 帳務報表 contains the authoritative bill population.
  const sheet = workbook.getWorksheet("帳務報表");
  if (!sheet) throw new Error("JGB 缺少帳務報表分頁");
  if (sheet.rowCount > 10000 || sheet.columnCount > 100) throw new Error("JGB 匯出超過安全筆數");
  const rows: unknown[][] = [];
  sheet.eachRow(row => {
    const cells: unknown[] = [];
    for (let i = 1; i <= sheet.columnCount; i++) cells.push(scalar(row.getCell(i).value));
    rows.push(cells);
  });
  return parseRows(rows);
}
const zeaburRequest: ReportRequest = (path, body) => fetch(LEGACY_ORIGIN + path, {
  method: body ? "POST" : "GET", redirect: "error", headers: { "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
});

function failedBeforeConnect(error: unknown): boolean {
  // node:https reports DNS/TCP failures directly. Timeouts and resets may occur after delivery.
  return error instanceof Error && "code" in error &&
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(String(error.code));
}

export async function fetchCurrentBills(onePlace = onePlaceClient(), zeabur = zeaburRequest) {
  const started = Date.now();
  let machine = await checkJgbFallback(onePlace).catch(() => false);
  const read = async (path: string, body?: object) => {
    const response = await (machine ? onePlace : zeabur)(path, body);
    if (!response.ok) throw new Error(`JGB 匯出服務 HTTP ${response.status}`);
    return response.json();
  };
  const fetchJson = async (path: string, body?: object) => {
    try {
      return await read(path, body);
    } catch (err) {
      // POST can switch only from the primary after a proven pre-connect failure.
      // A status GET is safe on the other host using the acknowledged batch.
      if (body && (!machine || !failedBeforeConnect(err))) throw err;
      machine = !machine;
      console.warn(`[jgb-report] switching to ${machine ? "OnePlace" : "Zeabur"} for ${body ? "export" : "status"}`);
      return read(path, body);
    }
  };
  console.info(`[jgb-report] export via ${machine ? "OnePlace" : "Zeabur"}`);
  const task = await fetchJson("/api/export-bills", {
    date_type: "all", bill_type: "income", statuses: ["unreceived"], async_mode: true,
  });
  if (task?.success !== true || !task.data?.batch_code || !task.data?.filename) throw new Error("JGB 未建立匯出批次");
  const batch = String(task.data.batch_code);
  let checkedAlternate = false;
  for (let attempt = 0; attempt < 24 && Date.now() - started < 120000; attempt++) {
    // A stalled job may finish on the other host. Switch once, retaining the same batch.
    if (!checkedAlternate && (attempt >= 8 || Date.now() - started >= 45000)) {
      checkedAlternate = true;
      machine = !machine;
    }
    const state = await fetchJson(`/api/check-status?${new URLSearchParams({ batch_code: batch, filename: task.data.filename })}`);
    if (state?.success === true && Number(state.data?.process) === 100 && state.data?.url) {
      // Never read the shared latest_report.xlsx: other exports can overwrite it.
      const url = new URL(state.data.url);
      if (url.protocol !== "https:" || url.hostname !== "img.jgbsmart.com" || url.port || url.username || url.password)
        throw new Error("JGB 匯出網址不在允許來源");
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`JGB 檔案 HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > 8_000_000) throw new Error("JGB 匯出檔案過大");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8_000_000) throw new Error("JGB 匯出檔案過大");
      return { bills: await parseWorkbook(bytes), fetchedAt: new Date(started), batch,
        digest: createHash("sha256").update(Buffer.from(bytes)).digest("hex") };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error("JGB 匯出逾時；本日不使用舊資料補送");
}
