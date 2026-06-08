/**
 * 週期詢問互動回饋（項目 8）— 「開啟連結」方案，全程不經 LINE webhook / MANUS。
 *
 * 卡片上的兩顆按鈕改成「開啟連結」(uri action)，連結指向本系統 /f/:id：
 *   - ?r=ok   → 記一筆「住得舒服」回饋到 Ragic，顯示謝謝頁。
 *   - ?r=help → 顯示後台可編輯的小問卷，送出後記一筆「需要協助」+ LINE 通知後台名單。
 *
 * 身分一律靠連結帶的 schedule id（不可猜的 UUID）→ 合約編號 / 電話，不靠姓名。
 * 寫 Ragic 用 ragicPost（已內建 doLinkLoad=first）：只寫合約編號，Ragic 會自動帶出
 * 租客手機/姓名/房號；其餘欄位（卡片類型/發送日期/回覆時間/回饋類型/不滿意項目/留言）直接寫。
 */
import { sbQuery, isSupabaseConfigured } from "../../db/supabaseClient";
import { ragicPost } from "./bookingHelpers";
import { pushLineDirect } from "./bookingConfirmHandler";

/** Ragic「回饋單」表（go-back/75）欄位 ID（由使用者建立並提供）。 */
const FB_SHEET = "go-back/75";
const FB_FIELDS = {
  contractNo: "1023087", // 合約編號（連結載入鑰匙；doLinkLoad 會自動帶出手機/姓名/房號）
  cardType: "1023092", // 卡片類型
  sendDate: "1023093", // 發送日期
  replyTime: "1023094", // 回覆時間
  feedbackType: "1023095", // 回饋類型（住得舒服 / 需要協助）
  dissatisfaction: "1023096", // 不滿意項目
  note: "1023097", // 留言
} as const;

export type FeedbackRow = {
  id: string;
  tenant_uid: string;
  tenant_name: string | null;
  room: string | null;
  property_name: string | null;
  contract_no: string | null;
  scheduled_date: string | null;
  rule_label: string | null;
  feedback_at: string | null;
};

/** 依連結帶的 schedule id 查出該筆資料；查無回 null（頁面顯示通用謝謝、不寫入）。 */
export async function loadFeedbackRow(scheduleId: string): Promise<FeedbackRow | null> {
  if (!isSupabaseConfigured()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(scheduleId)) return null;
  const rows = await sbQuery<FeedbackRow>(
    `select s.id, s.tenant_uid, s.tenant_name, s.room, s.property_name, s.contract_no,
            to_char(s.scheduled_date,'YYYY-MM-DD') as scheduled_date, r.label as rule_label,
            s.feedback_at
       from outreach.schedule s
       left join outreach.rule r on r.key = s.rule_key
      where s.id = $1`,
    [scheduleId],
  );
  return rows[0] || null;
}

/** 原子認領：第一個請求把 feedback_at 設起來（回 true）；之後再點回 false（已回覆過、不重複寫、不重複通知）。 */
export async function claimFeedback(scheduleId: string, type: "satisfied" | "help"): Promise<boolean> {
  if (!isSupabaseConfigured()) return true;
  const r = await sbQuery<{ id: string }>(
    `update outreach.schedule set feedback_at=now(), feedback_type=$2, updated_at=now()
      where id=$1 and feedback_at is null returning id`,
    [scheduleId, type],
  );
  return r.length > 0;
}

/** 寫 Ragic 失敗時回滾認領，讓房客可重試（避免被永久鎖住）。 */
export async function unclaimFeedback(scheduleId: string): Promise<void> {
  try {
    await sbQuery(`update outreach.schedule set feedback_at=null, updated_at=now() where id=$1`, [scheduleId]);
  } catch {
    /* best effort */
  }
}

const DEFAULT_SURVEY = {
  title: "哪個部分讓你比較不滿意？（可複選）",
  items: ["房間設備", "清潔／環境", "維修太慢或沒處理", "噪音／鄰居", "費用／帳務", "管理或服務態度", "其他"],
  note_label: "想多說一點（選填）",
};

/** 讀後台設定：問卷內容 + 通知 UID 名單（逗號分隔）。 */
export async function getFeedbackSettings(): Promise<{ survey: any; notifyUids: string[] }> {
  if (!isSupabaseConfigured()) return { survey: DEFAULT_SURVEY, notifyUids: [] };
  const rows = await sbQuery<{ feedback_survey: any; notify_uids: string | null }>(
    `select feedback_survey, notify_uids from outreach.settings where id=1`,
  );
  const s = rows[0] || ({} as any);
  const uids = String(s?.notify_uids || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return { survey: s?.feedback_survey || DEFAULT_SURVEY, notifyUids: uids };
}

/** 台北時間 'YYYY-MM-DD HH:mm'（伺服器固定 UTC）。 */
function nowTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** 寫一筆回饋到 Ragic「回饋單」表（ragicPost 內建 doLinkLoad=first 帶出手機/姓名/房號）。 */
export async function recordFeedback(opts: {
  row: FeedbackRow;
  type: "satisfied" | "help";
  items?: string[];
  note?: string;
}): Promise<void> {
  const { row, type, items = [], note = "" } = opts;
  const data: Record<string, string> = {
    [FB_FIELDS.contractNo]: row.contract_no || "",
    [FB_FIELDS.cardType]: row.rule_label || "",
    [FB_FIELDS.sendDate]: row.scheduled_date || "",
    [FB_FIELDS.replyTime]: nowTaipei(),
    [FB_FIELDS.feedbackType]: type === "satisfied" ? "住得舒服" : "需要協助",
    [FB_FIELDS.dissatisfaction]: items.join("、"),
    [FB_FIELDS.note]: note,
  };
  await ragicPost(FB_SHEET, data);
}

/** 不滿意回饋 → 對後台 notify_uids 每個 UID 推一則 LINE 通知（需先加官方帳號好友）。 */
export async function notifyHelp(row: FeedbackRow, items: string[], note: string): Promise<void> {
  const { notifyUids } = await getFeedbackSettings();
  if (!notifyUids.length) return;
  const text =
    `🔔 住得不舒服回報\n` +
    `房客：${row.tenant_name || "(無姓名)"}\n` +
    `住處：${[row.property_name, row.room].filter(Boolean).join(" ") || "(無)"}\n` +
    `合約：${row.contract_no || "(無)"}\n` +
    `不滿意：${items.join("、") || "(未填)"}\n` +
    `留言：${note || "(無)"}\n` +
    `時間：${nowTaipei()}\n請盡快聯繫關心 🙏`;
  for (const uid of notifyUids) {
    try {
      await pushLineDirect(uid, { type: "text", text });
    } catch (e: any) {
      console.error(`[feedback] notify ${String(uid).slice(0, 8)}… failed: ${e?.message || e}`);
    }
  }
}

// ── 房客看到的 HTML 頁面（自包含、手機開啟，不需登入 / LIFF） ──────────────────

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(inner: string): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>一方生活</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif;margin:0;background:#F7F5F0;color:#333;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:440px;width:100%;padding:28px}
  .big{font-size:20px;font-weight:700;color:#222;margin-bottom:6px;line-height:1.4}
  .sub{color:#999;font-size:13px;margin:0}
  .opts{display:flex;flex-direction:column;gap:10px;margin:18px 0}
  .opt{display:flex;align-items:center;gap:10px;font-size:15px;background:#FAF8F3;border:1px solid #EEE;border-radius:10px;padding:13px 14px;cursor:pointer}
  .opt input{width:18px;height:18px;accent-color:#534AB7;margin:0}
  .note{display:block;font-size:14px;color:#555;margin:14px 0 4px}
  .note textarea{width:100%;margin-top:6px;border:1px solid #DDD;border-radius:10px;padding:10px;font-size:15px;font-family:inherit}
  .btn{width:100%;background:#534AB7;color:#fff;border:0;border-radius:10px;padding:15px;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

/** 謝謝頁。 */
export function thankYouHtml(kind: "satisfied" | "help" | "generic" | "already"): string {
  const msg =
    kind === "help"
      ? "已收到，會盡快請小幫手與你聯繫 🙏"
      : kind === "satisfied"
        ? "謝謝你的回覆 😊"
        : kind === "already"
          ? "你已經回覆過了，謝謝 🙏"
          : "謝謝你的回覆 🙏";
  return page(`<div class="big">${msg}</div><p class="sub">可以關閉這個頁面了。</p>`);
}

/** 不滿意問卷頁（內容來自後台可編輯的 feedback_survey）。 */
export function surveyHtml(scheduleId: string, survey: any): string {
  const items: string[] = Array.isArray(survey?.items) ? survey.items : DEFAULT_SURVEY.items;
  const opts = items
    .map(
      (it) =>
        `<label class="opt"><input type="checkbox" name="items" value="${esc(it)}"><span>${esc(it)}</span></label>`,
    )
    .join("");
  return page(`
    <div class="big">${esc(survey?.title || DEFAULT_SURVEY.title)}</div>
    <form method="POST" action="/f/${encodeURIComponent(scheduleId)}">
      <div class="opts">${opts}</div>
      <label class="note">${esc(survey?.note_label || DEFAULT_SURVEY.note_label)}
        <textarea name="note" rows="3" placeholder="把想說的告訴我們…"></textarea></label>
      <button type="submit" class="btn">送出</button>
    </form>`);
}
