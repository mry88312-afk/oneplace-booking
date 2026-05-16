/**
 * 前端時區工具函數
 * 
 * 後端資料庫以 UTC 儲存所有時間，但 Drizzle 以 mode:'string' 返回的格式
 * 是 "2026-03-18 05:30:00"（沒有 Z 後綴）。
 * 
 * JavaScript 的 new Date("2026-03-18 05:30:00") 會將其解析為「本地時間」，
 * 導致在 UTC+8 的瀏覽器中被多加 8 小時。
 * 
 * 本模組提供統一的時間解析和格式化工具，確保所有後端時間都被正確解析為 UTC。
 */

/**
 * 將後端返回的時間字串解析為正確的 Date 物件。
 * 後端以 UTC 儲存，但返回的字串可能沒有 Z 後綴。
 * 
 * @param value - 後端返回的時間字串（如 "2026-03-18 05:30:00" 或 "2026-03-18T05:30:00.000Z"）
 * @returns Date 物件，或 null（如果無法解析）
 */
export function parseUTCDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  
  const str = String(value).trim();
  if (!str) return null;
  
  // If already has timezone info (Z or +/-offset), parse directly
  if (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  
  // No timezone info — assume UTC (add Z suffix)
  // Handle both "2026-03-18 05:30:00" and "2026-03-18T05:30:00" formats
  const normalized = str.replace(' ', 'T');
  const d = new Date(normalized + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 將後端返回的時間字串格式化為台北時間（UTC+8）的顯示字串。
 * 
 * @param value - 後端返回的時間字串
 * @param formatStr - 格式字串（使用 Intl.DateTimeFormat 選項）
 * @returns 格式化後的台北時間字串
 */
export function formatTaipei(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = parseUTCDate(value);
  if (!d) return '';
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  
  return d.toLocaleString('zh-TW', { ...defaultOptions, ...options });
}

/**
 * 將台北時間的日期和時間字串轉換為 UTC 毫秒時間戳。
 * 用於排程提交等場景。
 * 
 * @param dateStr - 日期字串（如 "2026-03-18"）
 * @param timeStr - 時間字串（如 "12:00"）
 * @returns UTC 毫秒時間戳
 */
export function taipeiToUTCTimestamp(dateStr: string, timeStr: string): number {
  // 建立 UTC+8 的時間，然後減去 8 小時得到 UTC
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  
  // 使用 Date.UTC 建立 UTC 時間，但因為輸入是台北時間，需要減 8 小時
  const utcMs = Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
  return utcMs;
}

/**
 * 從 UTC Date 物件取得台北時間的日期字串（YYYY-MM-DD）
 */
export function toTaipeiDateStr(value: string | Date | null | undefined): string {
  const d = parseUTCDate(value);
  if (!d) return '';
  
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  
  const year = parts.find(p => p.type === 'year')?.value || '';
  const month = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}

/**
 * 從 UTC Date 物件取得台北時間的時間字串（HH:mm）
 */
export function toTaipeiTimeStr(value: string | Date | null | undefined): string {
  const d = parseUTCDate(value);
  if (!d) return '';
  
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
