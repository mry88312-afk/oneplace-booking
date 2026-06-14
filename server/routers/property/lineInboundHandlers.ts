/**
 * LINE 圖文選單 postback 查詢 → 用 replyToken 免費回覆（messaging hub）。
 * MANUS 轉發 postback 事件（data 以 mh: 開頭）+ replyToken 到 /api/line/inbound。
 * 這裡用 line_uid 認租客 → 依 data 路由查詢 → 組 Flex 卡片 → reply。
 * 資料：合約/繳租帳號/報修 走 Supabase；繳租紀錄走 Ragic form 14（即時，by 虛擬帳號）。
 */
import { sbQuery, isSupabaseConfigured } from "../../db/supabaseClient";
import { replyMessage } from "./lineRichMenuClient";

const GREEN = "#2e4a36";
const RAGIC_BASE = "https://ap13.ragic.com/OnePlaceLiving";

type Tenant = { id: string; primary_name: string; primary_phone: string; virtual_account: string | null };

async function getTenant(uid: string): Promise<Tenant | null> {
  const rows = await sbQuery<Tenant>(
    `select id, primary_name, primary_phone, virtual_account from contract.tenants where line_uid=$1 limit 1`,
    [uid],
  );
  return rows[0] || null;
}

// ── Flex helpers ─────────────────────────────────────────────
function row(label: string, value: string) {
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#999999", flex: 2 },
      { type: "text", text: value || "—", size: "sm", color: "#333333", flex: 5, wrap: true },
    ],
  };
}
function bubble(title: string, bodyContents: any[], altText: string) {
  return {
    type: "flex", altText,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: GREEN, paddingAll: "14px",
        contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold", size: "lg" }] },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: bodyContents },
    },
  };
}
function txt(t: string) { return { type: "text", text: t }; }
const money = (n: any) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US"));

// ── 查詢 ─────────────────────────────────────────────────────
async function buildContract(t: Tenant) {
  const cs = await sbQuery<any>(
    `select tc.contract_no, to_char(tc.start_date,'YYYY-MM-DD') s, to_char(tc.end_date,'YYYY-MM-DD') e,
            tc.monthly_rent, tc.status, p.short_name property, u.unit_no room
       from contract.tenant_contract_parties pa
       join contract.tenant_contracts tc on tc.id = pa.tenant_contract_id
       left join property.properties p on p.id = tc.property_id
       left join property.units u on u.id = tc.unit_id
      where pa.tenant_id = $1 and tc.deleted_at is null
      order by tc.start_date desc limit 6`,
    [t.id],
  );
  if (!cs.length) return txt(`${t.primary_name} 您好，目前查不到您的合約資料，如有疑問請聯繫小幫手 🙏`);
  const blocks: any[] = [];
  cs.forEach((c, i) => {
    if (i) blocks.push({ type: "separator", margin: "lg" });
    blocks.push(row("案場", c.property));
    blocks.push(row("房間", c.room));
    blocks.push(row("租期", `${c.s || "?"} ~ ${c.e || "?"}`));
    blocks.push(row("租金", c.monthly_rent ? money(c.monthly_rent) + "/月" : "—"));
    blocks.push(row("合約編號", c.contract_no));
  });
  return bubble("📄 我的合約", blocks, "合約查詢");
}

function buildVA(t: Tenant) {
  if (!t.virtual_account) return txt(`${t.primary_name} 您好，系統尚未有您的專屬繳租帳號，請聯繫小幫手協助 🙏`);
  return bubble("🏦 繳租帳號（中國信託）", [
    { type: "text", text: t.virtual_account, weight: "bold", size: "xxl", align: "center", color: GREEN },
    { type: "text", text: "銀行代碼 822 中國信託", size: "sm", color: "#999999", align: "center", margin: "md" },
    { type: "text", text: "每月以此固定虛擬帳號繳交租金即可。", size: "xs", color: "#999999", align: "center", wrap: true, margin: "sm" },
  ], "繳租帳號：" + t.virtual_account);
}

async function buildRent(t: Tenant) {
  if (!t.virtual_account) return txt(`${t.primary_name} 您好，尚未有您的繳租帳號，無法查詢繳費紀錄，請聯繫小幫手 🙏`);
  const key = process.env.RAGIC_API_KEY;
  if (!key) return txt("繳費系統暫時無法連線，請稍後再試。");
  const url = `${RAGIC_BASE}/accounting-department/14?api&v=3&naming=EID&where=1022234,eq,${encodeURIComponent(t.virtual_account)}`;
  let rows: any[] = [];
  try {
    const resp = await fetch(url, { headers: { Authorization: `Basic ${key}` }, signal: AbortSignal.timeout(12000) });
    if (resp.ok) {
      const d: any = await resp.json();
      rows = Object.values(d)
        .filter((r: any) => r && typeof r === "object" && r["1022234"])
        .map((r: any) => ({ amount: r["1022235"], date: r["1022237"] || r["1022238"] }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 8);
    }
  } catch (e: any) {
    console.error("[inbound] ragic rent error:", e?.message);
    return txt("查詢繳費紀錄時連線逾時，請稍後再試 🙏");
  }
  if (!rows.length) return txt(`${t.primary_name} 您好，目前查不到繳費入帳紀錄。`);
  const blocks: any[] = rows.map((r) => row(String(r.date || "—"), money(r.amount)));
  blocks.unshift({ type: "text", text: "近期入帳紀錄", size: "xs", color: "#999999" });
  return bubble("💰 繳租紀錄", blocks, "繳租紀錄");
}

async function buildRepair(uid: string, name: string) {
  // 註：created_at 是匯入 Supabase 的日期（非真實報修日）；ticket_no（修YYYYMM-NNN）才含月份，故用單號排序/呈現。
  const ts = await sbQuery<any>(
    `select ticket_no, task_summary, status, internal_progress_category,
            to_char(completed_date,'YYYY-MM-DD') completed
       from service.maintenance_tickets
      where reporter_line_uid = $1 and deleted_at is null
      order by ticket_no desc limit 6`,
    [uid],
  );
  if (!ts.length) return txt(`${name} 您好，目前沒有您的報修紀錄。需要報修可從選單「修繕報修」提交 🛠️`);
  const clip = (s: string) => { const x = (s || "").replace(/\s+/g, " ").trim(); return x.length > 34 ? x.slice(0, 34) + "…" : x; };
  const statusZh = (r: any) =>
    r.completed ? `✅ 已完成（${r.completed}）`
      : (r.internal_progress_category || (r.status === "reported" ? "🔧 已受理，安排中" : "🔧 處理中"));
  const blocks: any[] = [];
  ts.forEach((r, i) => {
    if (i) blocks.push({ type: "separator", margin: "lg" });
    blocks.push(row("項目", clip(r.task_summary) || r.ticket_no));
    blocks.push(row("狀態", statusZh(r)));
    blocks.push(row("單號", r.ticket_no));
  });
  return bubble("🛠️ 報修進度", blocks, "報修進度");
}

function buildFaq() {
  return bubble("❓ 常見問題", [
    { type: "text", text: "• 繳租：點選單「繳租帳號」查看專屬帳號\n• 繳費紀錄：點「繳租紀錄」\n• 合約資訊：點「我的合約」\n• 報修：點「修繕報修」提交、「修繕進度」查進度", wrap: true, size: "sm", color: "#333333" },
    { type: "text", text: "其他問題請於此聊天室留言，小幫手會盡快回覆 🙏", wrap: true, size: "xs", color: "#999999", margin: "md" },
  ], "常見問題");
}

// ── 路由 + 回覆 ──────────────────────────────────────────────
export async function handleInboundEvents(
  events: any[],
  opts: { debug?: boolean } = {},
): Promise<{ index: number; data: string; replied: boolean; reply_status: string; reply_error: string | null; matched: string | null; preview?: any }[]> {
  const out: { index: number; data: string; replied: boolean; reply_status: string; reply_error: string | null; matched: string | null; preview?: any }[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev?.type !== "postback") continue;
    const data = String(ev?.postback?.data || "");
    const uid: string | undefined = ev?.source?.userId;
    const replyToken: string | undefined = ev?.replyToken;
    if (!data.startsWith("mh:")) continue;
    if (!isSupabaseConfigured()) { out.push({ index: i, data, replied: false, reply_status: "no_db", reply_error: null, matched: null }); continue; }
    let msg: any;
    let matched: string | null = null;
    let note: string | null = null; // 語意註記：tenant_not_found / query_error（即使有回覆友善訊息也記錄）
    try {
      const t = uid ? await getTenant(uid) : null;
      if (data === "mh:faq") msg = buildFaq();
      else if (!t) { msg = txt("找不到您的租客資料，請確認是否已綁定，或聯繫小幫手 🙏"); note = "tenant_not_found"; }
      else {
        matched = t.primary_name || null;
        if (data === "mh:contract") msg = await buildContract(t);
        else if (data === "mh:va") msg = buildVA(t);
        else if (data === "mh:rent") msg = await buildRent(t);
        else if (data === "mh:repair") msg = await buildRepair(uid!, t.primary_name);
        else continue;
      }
    } catch (e: any) {
      console.error("[inbound] query error:", data, e?.message);
      msg = txt("查詢時發生問題，請稍後再試或聯繫小幫手 🙏");
      note = "query_error: " + (e?.message || "");
    }
    let replied = false;
    let reply_status: string;
    let reply_error: string | null = note;
    if (opts.debug) {
      reply_status = "debug";
    } else if (replyToken) {
      try {
        await replyMessage(replyToken, [msg]);
        replied = true;
        reply_status = "ok";
      } catch (e: any) {
        reply_status = "failed";
        reply_error = e?.message || "reply error";
        console.error("[inbound] reply error:", e?.message);
      }
    } else {
      reply_status = "no_token";
    }
    out.push({ index: i, data, replied, reply_status, reply_error, matched, preview: msg });
  }
  return out;
}
