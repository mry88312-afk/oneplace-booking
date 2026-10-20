export type Fee = { name: string; amount: number };
export type Bill = {
  id: string; contractId: string; name: string; payer: string; room: string;
  due: string; period: string; leaseEnd: string; total: number; rent: number;
  fees: Fee[]; issue: string | null;
};
export type Identity = {
  contract_id: string; jgb_id: string | null; raw_jgb_id: string | null;
  contract_no: string; end_date: string | null; move_out_date: string | null;
  status: string; ownership_region: string | null; hq_internal_category: string | null;
  tenant_id: string | null; tenant_name: string | null; uid: string | null;
  property_name: string | null; property_deleted: string | null;
  uid_conflict?: boolean;
};
export const TAG = "租金提醒";
export const PREFIX = "jgb-rent:";
export const normalize = (v: unknown) => String(v ?? "").replace(/\s/g, "");
export const taipeiDate = (now = new Date()) => new Date(+now + 8 * 3600_000).toISOString().slice(0, 10);
export function dateOnly(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? s : null;
}
export function overdueDays(due: string, today: string): number {
  if (!dateOnly(due) || !dateOnly(today)) return NaN;
  return Math.round((Date.parse(today) - Date.parse(due)) / 86400_000);
}
export function inSendWindow(now: Date, start: string): boolean {
  const local = new Date(+now + 8 * 3600_000).toISOString();
  return local.slice(0, 10) >= start && local.slice(11, 16) >= "12:00" && local.slice(11, 16) < "12:15";
}
function matchingIdentities(contractId: string, identities: Identity[] | unknown): Identity[] {
  const rows: Identity[] = Array.isArray(identities) ? identities : [];
  return rows.filter(r => r && (String(r.jgb_id ?? "").trim() === contractId ||
    String(r.raw_jgb_id ?? "").trim() === contractId));
}
export function tenantInboxUrl(contractId: string, identities: Identity[] | unknown): string | null {
  const matches = matchingIdentities(contractId, identities);
  if (matches.length !== 1) return null;
  const r = matches[0];
  if (!r.tenant_id || !r.tenant_name || !r.uid || !/^U[0-9a-f]{32}$/i.test(r.uid) || r.uid_conflict) return null;
  if (r.jgb_id && r.raw_jgb_id && String(r.jgb_id).trim() !== String(r.raw_jgb_id).trim()) return null;
  return `https://fieldops.zeabur.app/inbox?uid=${encodeURIComponent(r.uid)}`;
}
export function decide(bill: Bill, identities: Identity[] | unknown, today: string) {
  const matches = matchingIdentities(bill.contractId, identities);
  const names = [bill.payer, ...matches.map(r => r.tenant_name)].map(normalize);
  const blocked = (reason: string) => ({ eligible: false as const, reason, identity: matches[0] ?? null });
  if (names.some(n => n === "游凰儀" || n === "藍堂嘉")) return blocked("示範資料");
  if (!dateOnly(bill.leaseEnd)) return blocked("JGB 合約到期日待核對");
  if (bill.leaseEnd < today) return blocked("JGB 合約已到期");
  if (matches.length !== 1) return blocked(matches.length ? "合約或主承租人多重對應" : "缺少合約對應");
  const r = matches[0];
  if (r.jgb_id && r.raw_jgb_id && String(r.jgb_id).trim() !== String(r.raw_jgb_id).trim()) return blocked("JGB ID 欄位衝突");
  if (r.property_deleted || r.ownership_region !== "總公司" || r.hq_internal_category === "靠行") return blocked("非總公司管理租約或歸屬不明");
  if (!dateOnly(r.end_date)) return blocked("主檔合約到期日待核對");
  if (r.end_date! < today) return blocked("合約已到期");
  if (r.move_out_date) return blocked("已有退租日期");
  if (r.status !== "active") return blocked("合約取消／退租標記待核對");
  if (!r.tenant_id || !r.tenant_name) return blocked("缺少主承租人");
  if (!r.uid || !/^U[0-9a-f]{32}$/i.test(r.uid)) return blocked("主承租人尚未綁定有效 UID");
  if (r.uid_conflict) return blocked("UID 對應衝突，待核對");
  if (bill.issue) return blocked(bill.issue);
  if (!Number.isFinite(bill.rent) || bill.rent <= 0) return blocked("非租金帳單");
  if (!Number.isFinite(bill.total) || bill.total <= 0) return blocked("金額待核對");
  const days = overdueDays(bill.due, today);
  if (!Number.isFinite(days)) return blocked("繳費期限待核對");
  if (days < 2) return blocked("尚未到逾期第 2 天");
  return { eligible: true as const, reason: "可提醒", identity: r };
}
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const text = (value: string, extra: Record<string, unknown> = {}) =>
  ({ type: "text", text: value || "—", size: "sm", wrap: true, color: "#454D45", ...extra });
const pair = (label: string, value: string) => ({
  type: "box", layout: "baseline", spacing: "sm",
  contents: [text(label, { color: "#889083", flex: 2 }), text(value, { flex: 5 })],
});
export function buildFlex(bill: Bill, identity: Identity, today: string) {
  const days = overdueDays(bill.due, today);
  return {
    type: "flex",
    altText: `${bill.name}｜已逾期 ${days} 天｜應到帳 NT$ ${money(bill.total)}`.slice(0, 400),
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#2E4A36", paddingAll: "20px", spacing: "sm",
        contents: [
          text("一方生活", { color: "#DCE8DC", weight: "bold" }),
          text("租金入帳提醒", { size: "xl", color: "#FFFFFF", weight: "bold" }),
          text(bill.name, { size: "lg", color: "#FFFFFF", weight: "bold" }),
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "lg",
        contents: [
          text(`${identity.tenant_name}您好，以下帳單目前仍顯示應到帳，提醒您協助確認付款狀況。`),
          { type: "box", layout: "vertical", backgroundColor: "#F2F5F0", cornerRadius: "12px", paddingAll: "16px", spacing: "sm",
            contents: [
              text("本期應到帳金額", { color: "#66715F" }),
              text(`NT$ ${money(bill.total)}`, { size: "xxl", weight: "bold", color: "#2E4A36" }),
              text(`已逾期 ${days} 天`, { size: "lg", weight: "bold", color: "#9A6324" }),
              text(`計算至 ${today.replaceAll("-", "/")}`, { size: "xs", color: "#66715F" }),
            ] },
          { type: "box", layout: "vertical", spacing: "sm",
            contents: [pair("房屋", bill.room), pair("帳單期間", bill.period), pair("繳費期限", bill.due),
              pair("帳單編號", bill.id)] },
          { type: "separator", color: "#E5E9E1" },
          { type: "box", layout: "vertical", spacing: "sm",
            contents: [text("費用明細", { weight: "bold" }), ...bill.fees.map(f => pair(f.name, `$${money(f.amount)}`))] },
        ],
      },
      footer: { type: "box", layout: "vertical", paddingAll: "20px", paddingTop: "0px", contents: [
        text("若您已付款，請直接回覆本訊息，提供付款日期與帳號末五碼，方便我們協助核對。謝謝您！", { color: "#66715F" }),
      ] },
    },
  };
}
