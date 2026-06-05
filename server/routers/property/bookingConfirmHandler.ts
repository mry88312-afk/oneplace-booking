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
 * P26：續約「節點流程說明」卡（第二張）。預設樣式，後續可調整文案/節點。
 * 已完成的節點打勾，後續節點以待辦呈現。
 */
function buildRenewalNodeCard(_templateType: string) {
  const steps: { icon: string; text: string; done: boolean }[] = [
    { icon: "✅", text: "更新資料・取得虛擬帳號", done: true },
    { icon: "✅", text: "預約續約專員時段", done: true },
    { icon: "③", text: "專員準備續約特約與線上簽約連結", done: false },
    { icon: "④", text: "約定時段：線上簽署 + 點交", done: false },
    { icon: "⑤", text: "完成續約 🎉", done: false },
  ];
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
        spacing: "md",
        contents: steps.map((s) => ({
          type: "box" as const,
          layout: "horizontal" as const,
          spacing: "md",
          contents: [
            { type: "text" as const, text: s.icon, size: "sm" as const, color: s.done ? "#4A6741" : "#B0B0B0", flex: 0 },
            { type: "text" as const, text: s.text, size: "sm" as const, wrap: true, color: s.done ? "#333333" : "#888888", weight: (s.done ? "bold" : "regular") as const },
          ],
        })),
        paddingAll: "20px",
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "後續專員會主動與您聯繫，請留意 LINE 通知 🔔", size: "xs", color: "#AAAAAA", wrap: true, align: "center" },
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
// 三張卡上方照片網址（依序：身分 / 電話Email / 緊急聯絡人）。留空則該卡不放圖。
// 可用單一網址放三張、或各自不同；之後填入即可。
const JGB_CARD_IMAGES: (string | undefined)[] = [undefined, undefined, undefined];

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
    if (img) b.hero = { type: "image", url: img, size: "full", aspectRatio: "20:11", aspectMode: "cover" };
    return b;
  };

  const cards = [
    bubble(0, "🪪", "① 身分資料", "#4A6741", [
      kv("名稱", "填「第一人」姓名，前面加一個「/」"),
      kv("姓氏", "填「第二人」姓名"),
      kv("證件號碼", "兩人身分證字號中間用「/」隔開"),
      example("名稱：/王小明\n姓氏：陳小華\n證件：A123456789／B987654321"),
    ], `入住人數 ${occupancy}　·　1 / 3`),
    bubble(1, "📞", "② 電話 / Email", "#3B7BB0", [
      kv("電話", "兩組號碼中間加一個「.」(點)"),
      example("0912345678.0987654321"),
      { type: "text", text: "⛔ 中間不要加斜線或其他符號，否則無法送出", size: "xs", color: "#C0392B", wrap: true, margin: "md" },
      kv("Email", "填一組即可"),
    ], "2 / 3"),
    bubble(2, "🚨", "③ 緊急聯絡人", "#C2553D", [
      { type: "text", text: "✅ 建議：有血緣的親屬（父母、兄弟姊妹）或夫妻", size: "sm", color: "#333333", wrap: true, margin: "md" },
      { type: "text", text: "⛔ 避免：填「朋友」（特殊狀況除外）", size: "sm", color: "#C0392B", wrap: true, margin: "sm" },
      { type: "text", text: "依上述格式填寫，有疑問請聯繫專員 🙌", size: "xs", color: "#AAAAAA", wrap: true, margin: "lg" },
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
        // 續約：依序直推 確認卡 → 節點說明卡 →（入住非一人才）JGB 簽約提醒卡
        const occN = parseInt(String(input.formAnswers?.["入住人數"] || "").trim(), 10);
        const cards: any[] = [flexMessage, buildRenewalNodeCard(template.templateType)];
        // 入住人數 > 1 才加發 JGB 雙人入住說明卡
        if (!isNaN(occN) && occN > 1) cards.push(buildJgbCard(`${occN} 人`));
        (async () => {
          for (const c of cards) {
            const r = await pushLineDirect(input.uid, c);
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
