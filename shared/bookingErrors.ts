export const BOOKING_UNAVAILABLE = "暫時無法確認預約結果，請稍後再試或聯繫小幫手。";
export const BOOKING_PENDING = "這筆預約仍待確認，請勿重新建單；請聯繫小幫手核對。";
export const BOOKING_CHANGED = "這次送出的內容與待確認預約不同，請先聯繫小幫手核對原預約。";
export const BOOKING_REFRESH = "預約頁面已更新，請重新開啟原預約連結再送出。";

/** Public errors must never contain database parameters or uploaded file contents. */
export function publicErrorMessage(message: unknown, code?: string): string {
  if (code === "INTERNAL_SERVER_ERROR" || typeof message !== "string" || !message.trim()
    || message.length > 240
    || /failed query|\bparams:|data:[^;]+;base64|\b(?:select|insert into|update)\s.*(?:`|\bfrom\b)|access denied for user/i.test(message)) {
    return BOOKING_UNAVAILABLE;
  }
  return message;
}

/** Log only a bounded classification, never Error.message/query/params/cause text. */
export function errorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) return value.code;
    current = value.cause;
  }
  return "UNCLASSIFIED";
}
