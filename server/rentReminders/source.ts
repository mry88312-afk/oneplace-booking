import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { Bill, dateOnly } from "./domain";

const ORIGIN = "https://jgbcontractkehsin.zeabur.app";
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
export async function fetchCurrentBills() {
  const started = Date.now();
  const fetchJson = async (path: string, body?: object) => {
    const r = await fetch(ORIGIN + path, { method: body ? "POST" : "GET", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`JGB 匯出服務 HTTP ${r.status}`);
    return r.json();
  };
  const task = await fetchJson("/api/export-bills", {
    date_type: "all", bill_type: "income", statuses: ["unreceived"], async_mode: true,
  });
  if (task?.success !== true || !task.data?.batch_code || !task.data?.filename) throw new Error("JGB 未建立匯出批次");
  const batch = String(task.data.batch_code);
  for (let attempt = 0; attempt < 24 && Date.now() - started < 120000; attempt++) {
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
