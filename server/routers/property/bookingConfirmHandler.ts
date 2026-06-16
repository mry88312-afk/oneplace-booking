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
      kv("證件號碼", "兩人身分證中間用「/」隔開"),
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

  // 1. 寫入 Ragic 任務表
  let ragicRecordId = "";
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
          "https://fieldopsdash-jmqd8ox8.manus.space/inbox";
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

    const result = await ragicPost(template.ragicTaskPath, ragicData);
    ragicRecordId = String(result?.ragicId || "");

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
