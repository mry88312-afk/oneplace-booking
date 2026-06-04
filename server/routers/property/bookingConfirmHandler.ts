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
import { ragicPost, ragicPut, ragicUploadFile, bookingRateMap } from "./bookingHelpers";
import { getLockedBundle, getLockedFields } from "../../config/lockedTemplates";

/**
 * Fallback：直接打 LINE Messaging API push message
 * 當主系統 webhook 失敗（500/503/timeout/network error）時使用，
 * 確保即使主系統 MANUS 掛掉，租客還是能收到預約確認卡片。
 */
async function pushLineDirect(
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

  // 取得模版（P18: 退租/續約 走 hardcode）
  const lockedBundle = getLockedBundle(input.projectId);
  let template: typeof schema.bookingTemplates.$inferSelect | undefined;
  if (lockedBundle) {
    template = lockedBundle.template;
  } else {
    const [row] = await db
      .select()
      .from(schema.bookingTemplates)
      .where(eq(schema.bookingTemplates.projectId, input.projectId));
    template = row;
  }
  if (!template)
    throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });
  if (!template.isActive)
    throw new TRPCError({ code: "NOT_FOUND", message: "預約專案已停用" });

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
    const lockedFields = getLockedFields(template.id);
    const allFields = lockedFields ?? (await db
      .select()
      .from(schema.bookingFormFields)
      .where(eq(schema.bookingFormFields.templateId, template.id)));

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
                text: "如需取消或變更，請聯繫我們",
                size: "xs",
                color: "#AAAAAA",
                margin: "lg",
                align: "center",
              },
            ],
            paddingAll: "20px",
          },
          styles: {
            header: { separator: false },
          },
        },
      };

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
  } catch (err: any) {
    console.error("[Booking] LINE notify construction error:", err.message);
  }

  return {
    success: true,
    bookingId: record.insertId,
    ragicRecordId,
  };
}
