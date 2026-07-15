/**
 * Handler for confirmBooking procedure（Zeabur 拆分版）.
 *
 * 與主系統的差異：
 * 1. 移除 tenantUserId 反查（不需要 users 表）
 * 2. LINE Flex Message 改成呼叫主系統 webhook (/api/booking/notify-line)
 *    主系統收到後會用 pushMessage 發給租客 + 記錄 system message
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { ragicPost, ragicPut, ragicUploadFile, bookingRateMap, resolveTemplateBundle } from "./bookingHelpers";
import { sbQuery } from "../../db/supabaseClient";

/**
 * Fallback：直接打 LINE Messaging API push message
 * 當主系統 webhook 失敗（500/503/timeout/network error）時使用，
 * 確保即使主系統 MANUS 掛掉，租客還是能收到預約確認卡片。
 */
export async function pushLineDirect(
  tenantUid: string,
  flexMessage: any,
): Promise<{ success: boolean; error?: string }> {
  const token = process.env.LINE_MESSAGING_TENANT_ACCESS_TOKEN;
  if (!token) {
    return { success: false, error: "LINE_MESSAGING_TENANT_ACCESS_TOKEN not set" };
  }
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: tenantUid,
        messages: [flexMessage],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: `LINE API ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * 直發 LINE（fallback 用）：把 payload 原封不動 POST 到 LINE 的 reply/push 端點。
 */
async function directLineSend(
  lineEndpoint: "reply" | "push",
  payload: any,
): Promise<{ success: boolean; error?: string }> {
  const token = process.env.LINE_MESSAGING_TENANT_ACCESS_TOKEN;
  if (!token) return { success: false, error: "LINE_MESSAGING_TENANT_ACCESS_TOKEN not set" };
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/message/${lineEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: `LINE ${lineEndpoint} ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * 統一送訊：所有對外 LINE 訊息（push / reply）都走這裡。
 * 優先 POST 到 MANUS 通用代發 relay（MANUS_LINE_RELAY_URL，MANUS 原樣轉給 LINE + 記錄客服聊天）；
 * relay 未設定 / 失敗時 fallback 直發 LINE（保命；那幾則客服不會在 MANUS 看到）。
 * payload = 原封不動要送 LINE 的 body（push={to,messages}；reply={replyToken,messages}）。
 * recordUid：給 MANUS 記錄客服聊天的對象；省略則 MANUS 不記錄（測試/內部通知用）。
 */
export async function relayToLine(
  lineEndpoint: "reply" | "push",
  payload: any,
  opts?: { recordUid?: string },
): Promise<{ success: boolean; error?: string; via?: string }> {
  // relay 網址：優先用 MANUS_LINE_RELAY_URL；沒設則由 MAIN_SYSTEM_WEBHOOK_URL 同源推導 /api/line/relay
  let relayUrl = process.env.MANUS_LINE_RELAY_URL;
  if (!relayUrl && process.env.MAIN_SYSTEM_WEBHOOK_URL) {
    try { relayUrl = new URL("/api/line/relay", process.env.MAIN_SYSTEM_WEBHOOK_URL).href; } catch {}
  }
  const secret = process.env.BOOKING_WEBHOOK_SECRET;
  if (relayUrl && secret) {
    try {
      const resp = await fetch(relayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
        body: JSON.stringify({ lineEndpoint, payload, recordUid: opts?.recordUid }),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) return { success: true, via: "manus_relay" };
      const text = await resp.text().catch(() => "");
      console.warn(`[relay] MANUS relay ${resp.status}: ${text.slice(0, 150)} → fallback 直發`);
    } catch (err: any) {
      console.warn(`[relay] MANUS relay 例外: ${err?.message} → fallback 直發`);
    }
  }
  const fb = await directLineSend(lineEndpoint, payload);
  return { success: fb.success, error: fb.error, via: fb.success ? "direct_fallback" : "failed" };
}

/** push 便捷包裝：送單張卡片給某 uid（預設記錄客服聊天；record:false 則不記，測試/內部通知用）。 */
export async function relayPush(
  uid: string,
  flexMessage: any,
  opts?: { record?: boolean },
): Promise<{ success: boolean; error?: string; via?: string }> {
  return relayToLine("push", { to: uid, messages: [flexMessage] }, {
    recordUid: opts?.record === false ? undefined : uid,
  });
}

/**
 * P87：Ragic 任務寫入失敗時，發 LINE 文字告警給員工，讓同事能人工補建任務＋日曆。
 * 這是 2026-07 Ragic 擋中文事件後補的安全網——就算 Ragic 再出狀況，也不會像那次一樣無聲吃掉預約。
 * 名單來源：env BOOKING_ALERT_UIDS（逗號/空白/分號分隔）優先，否則沿用 outreach.settings.notify_uids。
 * 全程 try/catch，告警本身絕不影響（也絕不中斷）預約主流程。
 */
export async function notifyBookingWriteFailure(info: {
  tenantName: string;
  roomNumber: string;
  templateType: string;
  startTime: string;
  bookingId: number | string;
  uid: string;
  error: string;
}): Promise<void> {
  try {
    let uids: string[] = [];
    const envUids = process.env.BOOKING_ALERT_UIDS;
    if (envUids && envUids.trim()) {
      uids = envUids.split(/[,\s;]+/).filter(Boolean);
    } else {
      try {
        const rows = await sbQuery<{ notify_uids: string | null }>(
          "select notify_uids from outreach.settings where id=1 limit 1",
        );
        uids = (rows[0]?.notify_uids || "").split(/[,\s;]+/).filter(Boolean);
      } catch (e: any) {
        console.error("[Booking][ALERT] 讀 outreach.settings 通知名單失敗:", e?.message);
      }
    }
    const t = new Date(new Date(info.startTime).getTime() + 8 * 3600000);
    const when = `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
    const text =
      `⚠️ 預約未寫入 Ragic，請人工補建任務＋Google 日曆\n\n` +
      `類型：${info.templateType}\n姓名：${info.tenantName}\n房號：${info.roomNumber}\n時間：${when}\n` +
      `預約編號：${info.bookingId}\nUID：${info.uid}\n\n原因：${String(info.error).slice(0, 300)}`;
    console.error(
      `[Booking][ALERT] Ragic 寫入失敗，告警 ${uids.length} 位員工：`,
      text.replace(/\n/g, " | "),
    );
    for (const uid of uids) {
      await relayPush(uid, { type: "text", text }, { record: false }).catch(() => {});
    }
  } catch (e: any) {
    console.error("[Booking][ALERT] 告警流程本身失敗:", e?.message || e);
  }
}

/**
 * P26：續約「節點流程說明」卡（第二張）。預設樣式，後續可調整文案/節點。
 * 已完成的節點打勾，後續節點以待辦呈現。
 */
function buildRenewalNodeCard(_templateType: string) {
  type Step = { icon: string; title: string; done?: boolean; desc?: string; subs?: string[]; note?: string };
  const steps: Step[] = [
    { icon: "✅", title: "更新個人資料・取得虛擬帳號", done: true },
    { icon: "✅", title: "預約續約專員時段", done: true },
    { icon: "③", title: "專員準備 JGB 合約，並提供連結", desc: "準備完成後會把連結傳給您" },
    {
      icon: "④", title: "在 JGB 線上完成簽署",
      subs: ["點開要簽署的合約", "填寫簽約資料", "前往簽名欄，簽名 3 次", "送出給一方"],
      note: "可在簽約時段前先完成，加速當天簽約流程",
    },
    { icon: "⑤", title: "約定時段：我們簽回・租金確認及線上點交確認" },
    { icon: "⑥", title: "完成續約 🎉" },
  ];
  const stepBox = (s: Step) => ({
    type: "box" as const, layout: "horizontal" as const, spacing: "md" as const, margin: "lg" as const,
    contents: [
      { type: "text" as const, text: s.icon, size: "md" as const, flex: 0, weight: "bold" as const, color: s.done ? "#4A6741" : "#B6843E" },
      {
        type: "box" as const, layout: "vertical" as const, flex: 1,
        contents: [
          { type: "text" as const, text: s.title, size: "sm" as const, weight: "bold" as const, wrap: true, color: s.done ? "#A2ABA2" : "#333333", decoration: (s.done ? "line-through" : "none") as const },
          ...(s.desc ? [{ type: "text" as const, text: s.desc, size: "xs" as const, color: "#999999", wrap: true, margin: "xs" as const }] : []),
          ...(s.subs ? s.subs.map((t, i) => ({ type: "text" as const, text: `${i + 1}. ${t}`, size: "xs" as const, color: "#666666", wrap: true, margin: (i === 0 ? "sm" : "xs") as const })) : []),
          ...(s.note ? [{ type: "text" as const, text: `⏰ ${s.note}`, size: "xs" as const, color: "#C2553D", wrap: true, margin: "sm" as const }] : []),
        ],
      },
    ],
  });
  return {
    type: "flex" as const,
    altText: "續約流程說明",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "📋 續約流程", weight: "bold", color: "#FFFFFF", size: "lg" },
          { type: "text", text: "目前進度與接下來的步驟", color: "#E8EFE6", size: "xs", margin: "sm" },
        ],
        backgroundColor: "#4A6741",
        paddingAll: "20px",
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: steps.map(stepBox),
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "專員會主動與您聯繫，請留意 LINE 通知 🔔", size: "xs", color: "#AAAAAA", wrap: true, align: "center" },
        ],
        paddingAll: "16px",
      },
    },
  };
}

/**
 * P39：入住非一人時加發的「雙人入住 JGB 填寫說明」— 三張輪播卡。
 * 每張卡上方可放一張照片（JGB_CARD_IMAGES，待補短網址）。
 * 重點：兩組電話中間用「.」(一個點) 隔開。
 */
// 三張卡上方照片（直接圖片網址，3:4 直式）：① 身分・電話 / ② 地址 / ③ 緊急聯絡人
const JGB_CARD_IMAGES: (string | undefined)[] = [
  "https://ppt.cc/fSV7gx@.jpg",
  "https://ppt.cc/fZ4JKx@.jpg",
  "https://ppt.cc/fywOYx@.jpg",
];

function buildJgbCard(occupancy: string) {
  const kv = (label: string, value: string) => ({
    type: "box" as const, layout: "baseline" as const, spacing: "sm" as const, margin: "sm" as const,
    contents: [
      { type: "text" as const, text: label, size: "sm" as const, color: "#8C8C8C", flex: 2 },
      { type: "text" as const, text: value, size: "sm" as const, color: "#333333", flex: 5, wrap: true },
    ],
  });
  const example = (text: string) => ({
    type: "box" as const, layout: "vertical" as const, backgroundColor: "#F6F5F1",
    cornerRadius: "md" as const, paddingAll: "10px" as const, margin: "md" as const,
    contents: [
      { type: "text" as const, text: "範例", size: "xxs" as const, color: "#B6843E", weight: "bold" as const },
      { type: "text" as const, text, size: "sm" as const, color: "#444444", wrap: true, margin: "xs" as const },
    ],
  });
  // 單張卡：上方可選圖 → 標題列(emoji+title) → 內容 → 頁碼
  const bubble = (idx: number, emoji: string, title: string, accent: string, children: any[], page: string) => {
    const b: any = {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: emoji, size: "xl", flex: 0 },
              { type: "text", text: title, weight: "bold", color: accent, size: "lg", gravity: "center", wrap: true },
            ],
          },
          { type: "separator", margin: "md", color: "#ECE9E1" },
          ...children,
          { type: "text", text: page, size: "xxs", color: "#BBBBBB", align: "end", margin: "lg" },
        ],
      },
    };
    const img = JGB_CARD_IMAGES[idx];
    if (img) b.hero = { type: "image", url: img, size: "full", aspectRatio: "3:4", aspectMode: "cover" };
    return b;
  };

  const warn = (text: string) => ({ type: "text" as const, text, size: "xs" as const, color: "#C0392B", wrap: true, margin: "sm" as const });
  const cards = [
    bubble(0, "🪪", "① 身分・電話", "#4A6741", [
      kv("名稱", "填第一人姓名，前面加一個「/」"),
      kv("姓氏", "填第二人姓名"),
      kv("證件號碼", "兩人身分證號中間用「/」隔開"),
      warn("⛔ 證件類型下拉請改選「其他身分證」，否則無法送出"),
      kv("電話", "兩組號碼中間加一個「.」(點)"),
      warn("⛔ 電話勿加斜線或其他符號，否則無法送出"),
      kv("Email", "填一組即可"),
    ], `入住人數 ${occupancy}　·　1 / 3`),
    bubble(1, "🏠", "② 地址", "#3B7BB0", [
      kv("戶籍地址", "填「第一位」室友的戶籍地址"),
      kv("通訊地址", "填「第二位」室友的戶籍地址"),
    ], "2 / 3"),
    bubble(2, "🚨", "③ 緊急聯絡人", "#C2553D", [
      { type: "text", text: "✅ 建議：有血緣的親屬（父母、兄弟姊妹）或夫妻", size: "sm", color: "#333333", wrap: true, margin: "md" },
      { type: "text", text: "⛔ 避免：填「朋友」（特殊狀況除外）", size: "sm", color: "#C0392B", wrap: true, margin: "sm" },
      { type: "text", text: "有疑問請聯繫專員協助 🙌", size: "xs", color: "#AAAAAA", wrap: true, margin: "lg" },
    ], "3 / 3"),
  ];

  return {
    type: "flex" as const,
    altText: "雙人入住 JGB 填寫說明",
    contents: { type: "carousel", contents: cards },
  };
}

/**
 * P86：退租點交「清潔提醒」輪播（4 張）。退租 (projectId=checkout) 預約成功後加發。
 * 圖片放 Supabase line-assets/flex_image（公開 bucket）。衛浴/陽台非人人有 → 純文字、措辭「如有」。
 */
const CHECKOUT_IMG = {
  closet: "https://dwoahbduwzfzqmwpvadj.supabase.co/storage/v1/object/public/line-assets/flex_image/checkout-closet.jpg",
  window: "https://dwoahbduwzfzqmwpvadj.supabase.co/storage/v1/object/public/line-assets/flex_image/checkout-window.jpg",
  filter: "https://dwoahbduwzfzqmwpvadj.supabase.co/storage/v1/object/public/line-assets/flex_image/checkout-filter.jpg",
};

function buildCheckoutCleaningCarousel() {
  const item = (label: string, value: string) => ({
    type: "box" as const, layout: "baseline" as const, spacing: "sm" as const, margin: "md" as const,
    contents: [
      { type: "text" as const, text: label, size: "sm" as const, color: "#8C8C8C", flex: 3 },
      { type: "text" as const, text: value, size: "sm" as const, color: "#333333", flex: 7, wrap: true },
    ],
  });
  const warn = (text: string) => ({ type: "text" as const, text, size: "xs" as const, color: "#C0392B", wrap: true, margin: "sm" as const });
  const note = (text: string) => ({ type: "text" as const, text, size: "xs" as const, color: "#999999", wrap: true, margin: "sm" as const });
  const subhead = (text: string) => ({ type: "text" as const, text, size: "sm" as const, weight: "bold" as const, color: "#333333", wrap: true, margin: "lg" as const });
  const inlineImg = (url: string) => ({ type: "image" as const, url, size: "full" as const, aspectRatio: "1:1" as const, aspectMode: "cover" as const, margin: "md" as const });

  const bubble = (heroUrl: string | undefined, emoji: string, title: string, accent: string, children: any[], page: string) => {
    const b: any = {
      type: "bubble", size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          { type: "box", layout: "horizontal", spacing: "sm", contents: [
            { type: "text", text: emoji, size: "xl", flex: 0 },
            { type: "text", text: title, weight: "bold", color: accent, size: "lg", gravity: "center", wrap: true },
          ]},
          { type: "separator", margin: "md", color: "#ECE9E1" },
          ...children,
          { type: "text", text: page, size: "xxs", color: "#BBBBBB", align: "end", margin: "lg" },
        ],
      },
    };
    if (heroUrl) b.hero = { type: "image", url: heroUrl, size: "full", aspectRatio: "3:4", aspectMode: "cover" };
    return b;
  };

  const cards = [
    bubble(CHECKOUT_IMG.closet, "🧹", "① 起居空間", "#4A6741", [
      item("地板", "毛髮、灰塵請用吸塵器吸乾淨"),
      item("保潔墊", "屬消耗品，請拆除並丟棄"),
      item("桌面・衣櫃", "內外擦拭至無灰塵"),
      item("窗溝・檯面", "縫隙灰塵一併清除"),
      inlineImg(CHECKOUT_IMG.window),
    ], "1 / 4"),
    bubble(CHECKOUT_IMG.filter, "❄️", "② 冷氣濾網", "#3B7BB0", [
      item("濾網", "拆下 → 水洗去灰 → 晾乾後裝回"),
      warn("⛔ 勿濕的直接裝回，易發霉"),
    ], "2 / 4"),
    bubble(undefined, "🚿", "③ 衛浴・陽台（如有）", "#C2553D", [
      subhead("🚿 獨立衛浴（套房）"),
      item("地板・馬桶", "牆角黴斑刷洗乾淨"),
      item("排水孔", "頭髮、雜物清除"),
      subhead("🪴 陽台"),
      item("地面", "落葉、雜物清掃"),
      item("排水孔", "保持暢通、勿積水"),
      note("ℹ️ 雅房／無陽台的房客，這張可以略過 🙆"),
    ], "3 / 4"),
    // P89：第 4 張改「物品帶走檢查」清單（原為清空垃圾提醒）
    bubble(undefined, "✅", "④ 清空與點交", "#4A6741", [
      { type: "text", text: "離開前請檢查這些是否都帶走：", size: "sm", color: "#333333", margin: "md", wrap: true },
      item("冰箱", "食材、飲料、冷凍品清空帶走"),
      item("廚房用品", "鍋碗、餐具、調味料收拾帶走"),
      item("鞋櫃", "鞋子、鞋盒全部清空"),
      item("洗衣精", "洗衣精、洗衣袋等記得帶走"),
      { type: "text", text: "🤝 我們點交當天見！", size: "sm", weight: "bold", color: "#4A6741", margin: "lg", wrap: true },
    ], "4 / 4"),
  ];

  return {
    type: "flex" as const,
    altText: "退租點交・清潔提醒",
    contents: { type: "carousel", contents: cards },
  };
}

export async function handleConfirmBooking(
  input: {
    projectId: string;
    uid: string;
    tenantName: string;
    roomNumber: string;
    date: string;
    startTime: string;
    endTime: string;
    calendarId: string;
    assigneeName: string;
    phone?: string;
    address?: string;
    formAnswers?: Record<string, any>;
    contractRecordId?: number;
    virtualAccount?: string;
    renewalStartDate?: string;
    renewalEndDate?: string;
    contractNo?: string;
  },
  ctx: any,
) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  // Rate limiting — 每個 IP 每小時最多 10 次預約
  const clientIp =
    ctx.req?.ip || ctx.req?.headers?.["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const rateEntry = bookingRateMap.get(String(clientIp));
  if (rateEntry && rateEntry.resetAt > now && rateEntry.count >= 10) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "預約次數過多，請稍後再試",
    });
  }
  if (!rateEntry || rateEntry.resetAt <= now) {
    bookingRateMap.set(String(clientIp), { count: 1, resetAt: now + 3600000 });
  } else {
    rateEntry.count++;
  }

  if (!input.uid || input.uid === "unknown") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "無法識別身份，請重新驗證",
    });
  }

  // 取得模版（DB 優先 + hardcode fallback；resolveTemplateBundle 已過濾 isActive）
  const bundle = await resolveTemplateBundle(input.projectId);
  if (!bundle)
    throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在或已停用" });
  const template = bundle.template;
  const isRenewal = template.templateType === "續約" || template.projectId === "renewal";

  // P95 安全網：退租/續約 一定要有房間。主客2/共同承租抓不到房間時，roomNumber 會是空字串，
  //   之前會靜默寫出一張「無房號」的退租/續約日曆任務（案場編號也連帶空白）。寧可擋下請租客聯繫，
  //   也不要產生空白單。gate 在 templateType（退租/續約）而非 zod .min(1)，避免誤擋不需房號的其他預約類型。
  const requiresRoom =
    template.templateType === "退租" ||
    template.templateType === "續約" ||
    template.ragicTaskPath === "go-back/1";
  if (requiresRoom && !input.roomNumber?.trim()) {
    console.error("[Booking] 空房號攔截（P95）:", {
      projectId: input.projectId,
      templateType: template.templateType,
      uid: input.uid,
      tenantName: input.tenantName,
      phone: input.phone || null,
    });
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "無法確認您的房間資訊，可能因為您是合約的第二位租客，請聯繫小幫手協助預約 🙏",
    });
  }

  // 線上續約 合約期間：算出 開始日 / 到期日 / 是否展延，給「寫回 Ragic」與「確認卡」共用。
  // 策略：後端先重抓 Supabase 驗一次（不信前端）；若重抓沒取得（Supabase 當下抓不到/超時），
  //       就用「租客實際填的」開始日+到期日當後備 → 確保只要租客有選日期，卡片一定顯示、Ragic 一定寫。
  //       展延與否用開始日就能自算（到期日 < 開始日+1年-1天 = 展延），不必依賴 Supabase。
  let renewalStartDate: string | null = null;
  let renewalEndDate: string | null = null;
  let renewalIsExtension = false;
  if (template.projectId === "renewal" && input.renewalEndDate) {
    // 1) 後端重抓驗證（有 contractNo 才試）
    if (input.contractNo) {
      try {
        const { getRenewalWindow, isRenewalEndValid } = await import("../../db/supabaseClient");
        const win = await getRenewalWindow(input.contractNo);
        if (win.ok && win.startDate && win.fullYearEndDate && isRenewalEndValid(win, input.renewalEndDate)) {
          renewalStartDate = win.startDate;
          renewalEndDate = input.renewalEndDate;
          renewalIsExtension = input.renewalEndDate < win.fullYearEndDate;
        } else {
          console.warn("[Booking] 續約重抓驗證未過:", {
            contractNo: input.contractNo, end: input.renewalEndDate,
            ok: win.ok, tooLate: win.tooLate, min: win.minDate, max: win.maxDate,
          });
        }
      } catch (e: any) {
        console.error("[Booking] 續約重抓失敗:", e?.message);
      }
    }
    // 2) 後備：重抓沒拿到、但前端有送開始日 → 用租客實際填的（展延用開始日自算）
    if (!renewalStartDate && input.renewalStartDate) {
      renewalStartDate = input.renewalStartDate;
      renewalEndDate = input.renewalEndDate;
      const fy = new Date(`${input.renewalStartDate}T00:00:00Z`);
      fy.setUTCFullYear(fy.getUTCFullYear() + 1);
      fy.setUTCDate(fy.getUTCDate() - 1); // 開始日 + 1年 - 1天
      renewalIsExtension = input.renewalEndDate < fy.toISOString().slice(0, 10);
      console.warn("[Booking] 續約改用前端後備值（重抓未取得）:", {
        start: renewalStartDate, end: renewalEndDate, ext: renewalIsExtension,
      });
    }
    console.log("[Booking] 續約合約期間結果:", {
      contractNo: input.contractNo, start: renewalStartDate, end: renewalEndDate, ext: renewalIsExtension,
    });
  }

  // 1. 寫入 Ragic 任務表
  let ragicRecordId = "";
  let ragicWriteError: string | null = null;
  try {
    const startDt = new Date(input.startTime);
    const taipeiOffset = 8 * 60 * 60 * 1000;
    const taipeiTime = new Date(startDt.getTime() + taipeiOffset);
    const ragicDateTime = `${taipeiTime.getUTCFullYear()}/${String(taipeiTime.getUTCMonth() + 1).padStart(2, "0")}/${String(taipeiTime.getUTCDate()).padStart(2, "0")} ${String(taipeiTime.getUTCHours()).padStart(2, "0")}:${String(taipeiTime.getUTCMinutes()).padStart(2, "0")}`;
    const m = taipeiTime.getUTCMonth() + 1;
    const d = taipeiTime.getUTCDate();
    const taskName = `${m}/${d}${template.templateType}${input.roomNumber}(${input.tenantName})`;

    const ragicData: Record<string, any> = {
      "1012117": template.templateType,
      "1012114": ragicDateTime,
      "1012112": taskName,
      "1012116": input.roomNumber,
      "1012113": input.assigneeName,
    };

    const fileFieldsToUpload: Array<{ fieldId: string; fileUrl: string }> = [];
    const allFields = bundle.fields;

    for (const field of allFields) {
      if (
        field.fieldType === "line_uid" &&
        field.ragicFieldId &&
        input.uid &&
        input.uid !== "unknown"
      ) {
        ragicData[field.ragicFieldId] = input.uid;
        continue;
      }
      if (
        field.fieldType === "inbox_url" &&
        field.ragicFieldId &&
        input.uid &&
        input.uid !== "unknown"
      ) {
        // 注意：對話網址指向主系統的客服介面
        const inboxBase =
          process.env.MAIN_SYSTEM_INBOX_URL ||
          "https://fieldops.zeabur.app/inbox";
        ragicData[field.ragicFieldId] = `${inboxBase}?uid=${input.uid}`;
        continue;
      }
      if (
        field.ragicFieldId &&
        input.formAnswers &&
        input.formAnswers[field.label]
      ) {
        let value = input.formAnswers[field.label];
        if (typeof value === "string" && value.includes("__other__")) {
          const otherKey = `${field.label}__other`;
          const otherText =
            (input.formAnswers as Record<string, string>)[otherKey] || "";
          const parts = value
            .split(",")
            .filter(Boolean)
            .map((v: string) =>
              v.trim() === "__other__"
                ? otherText
                  ? `其他：${otherText}`
                  : "其他"
                : v.trim(),
            )
            .filter(Boolean);
          value = parts.join(",");
        }
        if (field.fieldType === "file") {
          let urls: string[];
          if (typeof value === "string" && value.startsWith("data:")) {
            // base64 data URL 含逗號（data:xxx;base64,yyy），不可 split
            urls = [value];
          } else if (typeof value === "string") {
            urls = value
              .split(",")
              .map((u: string) => u.trim())
              .filter(Boolean);
          } else {
            urls = [value];
          }
          for (const url of urls) {
            fileFieldsToUpload.push({ fieldId: field.ragicFieldId, fileUrl: url });
          }
        } else {
          ragicData[field.ragicFieldId] = value;
        }
      }
    }

    // 線上續約標記：讓同事在 Ragic 一眼看出這筆是線上續約（/book/renewal）。
    // ⚠️ projectId 必須是 "renewal"（線上續約 DB 模版）— 不是 "contract"（那是線下續約 /book/contract）。
    //    P80 誤寫成 "contract"，導致線上續約從來沒被標記到；P83 修正為 "renewal"。
    // 寫入 1013030（原「您的本名」欄；本名已不收，租客姓名仍在任務名 taskName 的 (tenantName) 內）。
    if (template.projectId === "renewal") {
      ragicData["1013030"] = "線上續約";
    }

    // 線上續約 合約期間：寫回 開始日(1013716)、到期日(1013717)；展延（未滿1年）強制月繳(1013721)+備註(1013722)。
    // 視窗在前面已重抓並驗過（renewalStartDate/EndDate/IsExtension）。
    if (renewalStartDate && renewalEndDate) {
      ragicData["1013716"] = renewalStartDate;
      ragicData["1013717"] = renewalEndDate;
      if (renewalIsExtension) {
        ragicData["1013721"] = "月繳";
        ragicData["1013722"] = "展延＋2000元";
      }
    }

    const result = await ragicPost(template.ragicTaskPath, ragicData);
    ragicRecordId = String(result?.ragicId || "");
    if (!ragicRecordId) {
      // 沒丟錯但也沒拿到 ragicId（Ragic 回應異常）→ 一樣當寫入失敗，之後告警。
      ragicWriteError = `Ragic 回應未含 ragicId：${JSON.stringify(result).slice(0, 200)}`;
    }

    if (ragicRecordId && fileFieldsToUpload.length > 0) {
      const numericRagicId = Number(ragicRecordId);
      if (!isNaN(numericRagicId)) {
        for (const { fieldId, fileUrl } of fileFieldsToUpload) {
          try {
            await ragicUploadFile(
              template.ragicTaskPath,
              numericRagicId,
              fieldId,
              fileUrl,
            );
          } catch (uploadErr: any) {
            console.error(
              `[Booking] Ragic file upload error for field ${fieldId}:`,
              uploadErr.message,
            );
          }
        }
      }
    }
  } catch (err: any) {
    console.error("[Booking] Ragic POST error:", err.message);
    ragicWriteError = err?.message || String(err);
  }

  // 2. 建立本地預約記錄
  const bookingTime = new Date(input.startTime).getTime();
  const [record] = await db.insert(schema.bookingRecords).values({
    templateId: template.id,
    tenantUid: input.uid,
    tenantUserId: null,
    tenantName: input.tenantName,
    roomNumber: input.roomNumber,
    address: input.address || null,
    bookingTime,
    durationMinutes: template.slotDurationMinutes,
    assigneeName: input.assigneeName,
    googleEventId: "",
    googleCalendarId: input.calendarId,
    ragicRecordId,
    formAnswers: input.formAnswers || null,
    status: "confirmed",
  });

  // 2b. Ragic 任務寫入失敗 → 告警員工人工補建（本地紀錄已寫、租客仍會收到確認卡，故靠告警補上動線）。
  //     Fire-and-forget，絕不阻擋預約 response。
  if (ragicWriteError) {
    notifyBookingWriteFailure({
      tenantName: input.tenantName,
      roomNumber: input.roomNumber,
      templateType: template.templateType || "預約",
      startTime: input.startTime,
      bookingId: record.insertId,
      uid: input.uid,
      error: ragicWriteError,
    }).catch((e: any) => console.error("[Booking][ALERT] 觸發告警例外:", e?.message || e));
  }

  // 3. 回寫合約記錄（/go-back/22 欄位 1015394 = 續約 or 退租）
  if (input.contractRecordId && template.contractAction) {
    try {
      await ragicPut("go-back/22", input.contractRecordId, {
        "1015394": template.contractAction,
      });
      console.log(`[Booking] 合約回寫成功：record ${input.contractRecordId} → 欄位 1015394="${template.contractAction}"`);
    } catch (err: any) {
      console.error("[Booking] 合約回寫失敗（不影響預約結果）:", err.message);
    }
  }

  // 4. 構建 LINE Flex Message 並請主系統幫忙發送
  try {
    if (input.uid && input.uid !== "unknown") {
      const startDt = new Date(input.startTime);
      const taipeiOffset = 8 * 60 * 60 * 1000;
      const taipeiTime = new Date(startDt.getTime() + taipeiOffset);
      const dateStr = `${taipeiTime.getUTCFullYear()}/${String(taipeiTime.getUTCMonth() + 1).padStart(2, "0")}/${String(taipeiTime.getUTCDate()).padStart(2, "0")}`;
      const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
      const weekday = weekdays[taipeiTime.getUTCDay()];
      const timeStr = `${String(taipeiTime.getUTCHours()).padStart(2, "0")}:${String(taipeiTime.getUTCMinutes()).padStart(2, "0")}`;
      const endDt = new Date(input.endTime);
      const taipeiEnd = new Date(endDt.getTime() + taipeiOffset);
      const endTimeStr = `${String(taipeiEnd.getUTCHours()).padStart(2, "0")}:${String(taipeiEnd.getUTCMinutes()).padStart(2, "0")}`;

      const infoRows: { label: string; value: string }[] = [
        { label: "預約類型", value: template.templateType || "預約" },
        { label: "日期", value: `${dateStr}（${weekday}）` },
        { label: "時間", value: `${timeStr} - ${endTimeStr}` },
        { label: "姓名", value: input.tenantName },
      ];
      if (input.roomNumber) infoRows.push({ label: "房間", value: input.roomNumber });
      if (input.address) infoRows.push({ label: "地址", value: input.address });
      // P84：續約卡片顯示「租期」（合約期間 開始日～到期日，共 X 個月）
      if (isRenewal && renewalStartDate && renewalEndDate) {
        const fmtYmd = (s: string) => s.replace(/-/g, "/");
        const sd = new Date(`${renewalStartDate}T00:00:00Z`);
        const ed = new Date(`${renewalEndDate}T00:00:00Z`);
        ed.setUTCDate(ed.getUTCDate() + 1); // 到期日含當天 → 算月數用隔天當結束
        let months = (ed.getUTCFullYear() - sd.getUTCFullYear()) * 12 + (ed.getUTCMonth() - sd.getUTCMonth());
        if (ed.getUTCDate() < sd.getUTCDate()) months -= 1;
        infoRows.push({ label: "租期", value: `${fmtYmd(renewalStartDate)} ～ ${fmtYmd(renewalEndDate)}（共 ${months} 個月）` });
      }
      // P30：續約卡片顯示問卷答案（繳費方式 / 是否變更入住人數 / 續約備註）
      if (isRenewal && input.formAnswers) {
        for (const f of bundle.fields) {
          if (!["text", "select", "checkbox"].includes(f.fieldType)) continue;
          let v = input.formAnswers[f.label];
          if (v === undefined || v === null || String(v).trim() === "") continue;
          v = String(v);
          if (v.includes("__other__")) {
            const otherText = (input.formAnswers as Record<string, string>)[`${f.label}__other`] || "";
            v = v.split(",").filter(Boolean).map((x) => (x.trim() === "__other__" ? (otherText ? `其他：${otherText}` : "其他") : x.trim())).filter(Boolean).join("、");
          } else {
            v = v.split(",").filter(Boolean).join("、");
          }
          if (v) infoRows.push({ label: f.label, value: v });
        }
      }
      // P84：展延備註（未滿一年）
      if (isRenewal && renewalIsExtension) {
        infoRows.push({ label: "展延備註", value: "未滿一年，須收一次性 2,000 元（僅月繳）" });
      }
      // P26：續約卡片附上虛擬帳號，讓租客知道匯款帳號
      if (input.virtualAccount) {
        infoRows.push({ label: "銀行", value: "822 中國信託" });
        infoRows.push({ label: "虛擬帳號", value: input.virtualAccount });
      }

      const flexMessage = {
        type: "flex" as const,
        altText: `已收到您的預約囉！${dateStr} ${timeStr}`,
        contents: {
          type: "bubble",
          size: "mega",
          header: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "一方",
                    size: "sm",
                    color: "#FFFFFF",
                    weight: "bold",
                  },
                ],
              },
              {
                type: "text",
                text: "✅ 已收到您的預約囉！",
                size: "xl",
                weight: "bold",
                color: "#FFFFFF",
                margin: "md",
              },
            ],
            backgroundColor: "#4A6741",
            paddingAll: "20px",
          },
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              ...infoRows.map((row) => ({
                type: "box" as const,
                layout: "horizontal" as const,
                contents: [
                  {
                    type: "text" as const,
                    text: row.label,
                    size: "sm" as const,
                    color: "#8C8C8C",
                    flex: 2,
                  },
                  {
                    type: "text" as const,
                    text: row.value,
                    size: "sm" as const,
                    color: "#333333",
                    weight: "bold" as const,
                    flex: 4,
                    wrap: true,
                  },
                ],
                margin: "lg" as const,
              })),
              {
                type: "separator",
                margin: "xl",
              },
              {
                type: "text",
                text: "可使用下方按鈕變更時間或取消",
                size: "xs",
                color: "#AAAAAA",
                margin: "lg",
                align: "center",
              },
            ],
            paddingAll: "20px",
          },
          // P23：退租/續約卡片動作按鈕（需 template 有 liffId 才顯示）
          ...(template.liffId
            ? {
                footer: {
                  type: "box",
                  layout: "vertical",
                  spacing: "sm",
                  contents: [
                    {
                      type: "button",
                      style: "primary",
                      height: "sm",
                      color: "#4A6741",
                      action: {
                        type: "uri",
                        label: `變更${template.templateType}時間`,
                        uri: `https://liff.line.me/${template.liffId}?reschedule=${record.insertId}`,
                      },
                    },
                    {
                      type: "button",
                      style: "secondary",
                      height: "sm",
                      action: {
                        type: "uri",
                        label: `取消${template.templateType}`,
                        uri: `https://liff.line.me/${template.liffId}?cancel=${record.insertId}`,
                      },
                    },
                  ],
                  paddingAll: "16px",
                },
              }
            : {}),
          styles: {
            header: { separator: false },
          },
        },
      };

      if (isRenewal) {
        // 確認卡一律發；「續約流程」節點卡 +（入住>1）JGB 簽約卡只在「線上續約」(/book/renewal) 發。
        // 線下續約 (/book/contract) 不走 JGB 線上簽署流程 → 只發確認卡，不發節點卡/JGB卡。
        const cards: any[] = [flexMessage];
        if (template.projectId === "renewal") {
          cards.push(buildRenewalNodeCard(template.templateType));
          const occN = parseInt(String(input.formAnswers?.["入住人數"] || "").trim(), 10);
          if (!isNaN(occN) && occN > 1) cards.push(buildJgbCard(`${occN} 人`));
        }
        (async () => {
          for (const c of cards) {
            const r = await relayPush(input.uid, c);
            if (!r.success) console.error("[Booking] 續約卡推送失敗:", r.error);
          }
        })().catch((e: any) => console.error("[Booking] 續約多卡推送例外:", e?.message));
      }

      if (!isRenewal) {
      // P86：退租點交「清潔提醒」輪播（只在退租 checkout 發；確認卡仍走下方原本 webhook 流程）
      if (template.projectId === "checkout") {
        (async () => {
          const r = await relayPush(input.uid, buildCheckoutCleaningCarousel());
          if (!r.success) console.error("[Booking] 退租清潔卡推送失敗:", r.error);
        })().catch((e: any) => console.error("[Booking] 退租清潔卡推送例外:", e?.message));
      }
      const webhookUrl = process.env.MAIN_SYSTEM_WEBHOOK_URL;
      const webhookSecret = process.env.BOOKING_WEBHOOK_SECRET;

      // 統一的 fallback 處理：webhook 失敗時直接打 LINE API
      const fallbackToDirect = async (reason: string) => {
        console.warn(
          `[Booking] webhook 失敗(${reason})，fallback 直接打 LINE API for ${input.uid.slice(0, 8)}...`,
        );
        const fb = await pushLineDirect(input.uid, flexMessage);
        if (fb.success) {
          console.log(
            `[Booking] LINE notify sent via FALLBACK direct push for ${input.uid.slice(0, 8)}...`,
          );
        } else {
          console.error(`[Booking] FALLBACK direct push 也失敗: ${fb.error}`);
        }
      };

      if (!webhookUrl || !webhookSecret) {
        // webhook 沒設定 → 直接走 fallback
        fallbackToDirect("env not configured").catch((e) =>
          console.error("[Booking] fallback unexpected error:", e?.message || e),
        );
      } else {
        // Fire-and-forget — 不阻擋預約成功 response
        // 先嘗試走主系統 webhook（讓主系統管 recordSystemMessage 統一）
        // 主系統失敗（500/503/timeout）就 fallback 直接打 LINE API
        fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": webhookSecret,
          },
          body: JSON.stringify({
            tenantUid: input.uid,
            bookingId: record.insertId,
            flexMessage,
          }),
          signal: AbortSignal.timeout(8000),
        })
          .then(async (resp) => {
            if (!resp.ok) {
              const text = await resp.text().catch(() => "");
              console.warn(
                `[Booking] notify-line webhook returned ${resp.status}:`,
                text.slice(0, 200),
              );
              await fallbackToDirect(`webhook ${resp.status}`);
            } else {
              console.log(
                `[Booking] LINE notify sent via webhook for ${input.uid.slice(0, 8)}...`,
              );
            }
          })
          .catch(async (err) => {
            console.error("[Booking] notify-line webhook failed:", err?.message);
            await fallbackToDirect(`webhook exception: ${err?.message}`);
          });
      }
      }
    }
  } catch (err: any) {
    console.error("[Booking] LINE notify construction error:", err.message);
  }

  return {
    success: true,
    bookingId: record.insertId,
    ragicRecordId,
  };
}
