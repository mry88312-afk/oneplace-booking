/**
 * LINE 圖文選單 postback 查詢 → 用 replyToken 免費回覆（messaging hub）。
 * fieldops 轉發 postback 事件（data 以 mh: 開頭）+ replyToken 到 /api/line/inbound。
 * 這裡用 line_uid 認租客 → 依 data 路由查詢 → 組 Flex 卡片 → reply。
 * 資料：合約/繳租帳號/報修 走 Supabase；繳租紀錄走 Ragic form 14（即時，by 虛擬帳號）。
 */
import { sbQuery, isSupabaseConfigured } from "../../db/supabaseClient";
import { FAQ_CATEGORIES, type FaqCategory } from "../../config/faqContent";
import { relayToLine } from "./bookingConfirmHandler";

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
function bubble(title: string, bodyContents: any[], altText: string, footerContents?: any[]) {
  const contents: any = {
    type: "bubble",
    header: { type: "box", layout: "vertical", backgroundColor: GREEN, paddingAll: "14px",
      contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold", size: "lg", wrap: true }] },
    body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: bodyContents },
  };
  if (footerContents?.length) {
    contents.footer = { type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px", contents: footerContents };
  }
  return {
    type: "flex", altText,
    contents,
  };
}
function txt(t: string) { return { type: "text", text: t }; }
const money = (n: any) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US"));
// payment_method = 繳費月數：1月/3季/6半年/12年；其餘＝每 N 個月繳
const payCycle = (n: any) => {
  const m = Number(n);
  if (!m) return null;
  return (({ 1: "月繳", 3: "季繳", 6: "半年繳", 12: "年繳" } as Record<number, string>)[m]) || `每 ${m} 個月繳`;
};

// ── 查詢 ─────────────────────────────────────────────────────
async function buildContract(t: Tenant) {
  const cs = await sbQuery<any>(
    `select tc.contract_no, to_char(tc.start_date,'YYYY-MM-DD') s, to_char(tc.end_date,'YYYY-MM-DD') e,
            tc.monthly_rent, tc.payment_method, tc.status, p.short_name property, u.unit_no room
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
    const cyc = payCycle(c.payment_method);
    if (cyc) blocks.push(row("繳費方式", cyc));
    blocks.push(row("合約編號", c.contract_no));
  });
  return bubble("📄 我的合約", blocks, "合約查詢");
}

function buildVA(t: Tenant) {
  if (!t.virtual_account) return txt(`${t.primary_name} 您好，系統尚未有您的專屬繳租帳號，請聯繫小幫手協助 🙏`);
  const acct = "822-" + t.virtual_account;
  return bubble("🏦 繳租帳號", [
    { type: "text", text: "中國信託 復北分行", size: "sm", color: "#666666", align: "center" },
    { type: "text", text: acct, weight: "bold", size: "xl", align: "center", color: GREEN, margin: "sm", adjustMode: "shrink-to-fit" },
    { type: "button", style: "primary", color: GREEN, height: "sm", margin: "lg",
      action: { type: "clipboard", label: "📋 複製帳號", clipboardText: acct } },
    { type: "text", text: "（822＝中國信託）每月以此帳號繳交租金即可。", size: "xs", color: "#999999", align: "center", wrap: true, margin: "md" },
  ], "繳租帳號：" + acct);
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
        .map((r: any) => ({ amount: r["1022235"], date: r["1022237"] || r["1022238"], time: r["1022239"] }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 8);
    }
  } catch (e: any) {
    console.error("[inbound] ragic rent error:", e?.message);
    return txt("查詢繳費紀錄時連線逾時，請稍後再試 🙏");
  }
  if (!rows.length) return txt(`${t.primary_name} 您好，目前查不到匯款入帳紀錄。`);
  const blocks: any[] = rows.map((r) => ({
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: `${r.date || "—"}${r.time ? "  " + r.time : ""}`, size: "sm", color: "#555555", flex: 5, wrap: true },
      { type: "text", text: money(r.amount), size: "sm", color: GREEN, weight: "bold", align: "end", flex: 3 },
    ],
  }));
  blocks.unshift({ type: "text", text: "近期入帳（日期・時間・金額）", size: "xs", color: "#999999" });
  return bubble("💰 室友匯款紀錄", blocks, "室友匯款紀錄");
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

function faqButton(label: string, data: string, style: "primary" | "secondary" = "secondary") {
  return {
    type: "button",
    style,
    color: style === "primary" ? GREEN : undefined,
    height: "sm",
    action: { type: "postback", label, data, displayText: label },
  };
}

function faqCategoryRoute(category: FaqCategory) {
  return `mh:faq:category:${category.slug}`;
}

function faqAnswerRoute(category: FaqCategory, index: number) {
  return `mh:faq:answer:${category.slug}:${index}`;
}

function faqEscalationRoute(category: FaqCategory, index?: number) {
  return `mh:faq:escalate:${category.slug}${index == null ? "" : `:${index}`}`;
}

export type FaqEscalationContext = {
  source: "faq";
  category: string;
  question?: string;
};

export function getFaqEscalationContext(data: string): FaqEscalationContext | null {
  const match = /^mh:faq:escalate:([a-z0-9-]+)(?::(\d+))?$/.exec(data);
  if (!match) return null;
  const category = FAQ_CATEGORIES.find((entry) => entry.slug === match[1]);
  if (!category) return null;
  if (match[2] == null) return { source: "faq", category: category.label };
  const item = category.items[Number(match[2])];
  return item
    ? { source: "faq", category: category.label, question: item.question }
    : null;
}

function buildFaqCategories() {
  return bubble("❓ 常見問題", [
    { type: "text", text: "請選擇問題分類", wrap: true, size: "sm", color: "#666666" },
    ...FAQ_CATEGORIES.map((category) =>
      faqButton(`${category.icon} ${category.label}`, faqCategoryRoute(category))),
  ], "常見問題分類");
}

function buildFaqQuestions(category: FaqCategory) {
  return bubble(`${category.icon} ${category.label}`, [
    { type: "text", text: "請點選想了解的問題", wrap: true, size: "sm", color: "#666666" },
    ...category.items.map((item, index) =>
      faqButton(item.question, faqAnswerRoute(category, index))),
  ], `${category.label}常見問題`, [
    faqButton("都無法解決，請專員聯絡我", faqEscalationRoute(category), "primary"),
    faqButton("← 上一步：問題分類", "mh:faq"),
  ]);
}

function buildFaqAnswer(category: FaqCategory, index: number) {
  const item = category.items[index];
  if (!item) return buildFaqQuestions(category);
  return bubble(item.question, [
    { type: "text", text: item.answer, wrap: true, size: "sm", color: "#333333" },
  ], item.question, [
    faqButton("都無法解決，請專員聯絡我", faqEscalationRoute(category, index), "primary"),
    faqButton("← 上一步：問題列表", faqCategoryRoute(category)),
    faqButton("回常見問題分類", "mh:faq"),
  ]);
}

function buildFaqEscalationConfirmation(context: FaqEscalationContext) {
  const category = FAQ_CATEGORIES.find((entry) => entry.label === context.category);
  return bubble("🙋 已通知專員", [
    {
      type: "text",
      text: "我們已將您的對話標示為優先求助，專員會盡快與您聯絡。",
      wrap: true,
      size: "sm",
      color: "#333333",
    },
    {
      type: "text",
      text: context.question
        ? `求助內容：${context.category}／${context.question}`
        : `求助分類：${context.category}`,
      wrap: true,
      size: "xs",
      color: "#777777",
      margin: "md",
    },
  ], "已通知專員優先聯絡", [
    ...(category ? [faqButton("繼續查看這個分類", faqCategoryRoute(category))] : []),
    faqButton("回常見問題分類", "mh:faq"),
  ]);
}

/** Build the complete static FAQ navigation without requiring tenant or database lookup. */
export function buildFaqMessage(data: string) {
  if (data === "mh:faq") return buildFaqCategories();

  const escalation = getFaqEscalationContext(data);
  if (escalation) return buildFaqEscalationConfirmation(escalation);

  const categoryMatch = /^mh:faq:category:([a-z0-9-]+)$/.exec(data);
  if (categoryMatch) {
    const category = FAQ_CATEGORIES.find((entry) => entry.slug === categoryMatch[1]);
    return category ? buildFaqQuestions(category) : buildFaqCategories();
  }

  const answerMatch = /^mh:faq:answer:([a-z0-9-]+):(\d+)$/.exec(data);
  if (answerMatch) {
    const category = FAQ_CATEGORIES.find((entry) => entry.slug === answerMatch[1]);
    return category ? buildFaqAnswer(category, Number(answerMatch[2])) : buildFaqCategories();
  }

  return data.startsWith("mh:faq:") ? buildFaqCategories() : null;
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
    let msg: any;
    let matched: string | null = null;
    let faqEscalation: FaqEscalationContext | null = null;
    let note: string | null = null; // 語意註記：tenant_not_found / query_error（即使有回覆友善訊息也記錄）
    try {
      const faqMessage = buildFaqMessage(data);
      if (faqMessage) {
        msg = faqMessage;
        faqEscalation = getFaqEscalationContext(data);
      } else {
        if (!isSupabaseConfigured()) {
          out.push({ index: i, data, replied: false, reply_status: "no_db", reply_error: null, matched: null });
          continue;
        }
        const t = uid ? await getTenant(uid) : null;
        if (!t) { msg = txt("找不到您的租客資料，請確認是否已綁定，或聯繫小幫手 🙏"); note = "tenant_not_found"; }
        else {
          matched = t.primary_name || null;
          if (data === "mh:contract") msg = await buildContract(t);
          else if (data === "mh:va") msg = buildVA(t);
          else if (data === "mh:rent") msg = await buildRent(t);
          else if (data === "mh:repair") msg = await buildRepair(uid!, t.primary_name);
          else continue;
        }
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
      const r = await relayToLine("reply", { replyToken, messages: [msg] }, {
        recordUid: uid,
        supportEscalation: faqEscalation ?? undefined,
      });
      if (r.success) {
        replied = true;
        reply_status = "ok";
      } else {
        reply_status = "failed";
        reply_error = r.error || "relay/reply failed";
        console.error("[inbound] reply error:", r.error);
      }
    } else {
      reply_status = "no_token";
    }
    out.push({ index: i, data, replied, reply_status, reply_error, matched, preview: msg });
  }
  return out;
}
