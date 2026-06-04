/**
 * P22a — 續約線上化：匯訂功能移植到 Zeabur 預約後端。
 *
 * 從獨立的 tenant-form-liff（Express/REST）移植成本專案 tRPC handler：
 *  - 產生固定式虛擬帳號（純算法，無外部 API；需 ENTERPRISE_ID）
 *  - 電話 OTP 認證（三竹簡訊 + 速率限制 / 鎖定 / verifyToken / MASTER_OTP 救場）
 *  - 查詢租客是否已有 VA（Ragic for-system-use/2）
 *  - 提交：upsert 租客主檔 + 推 LINE 虛擬帳號卡 + 發 n8n webhook
 *
 * 設計：
 *  - OTP / 鎖定 / verifyToken 狀態存記憶體 Map（Zeabur 單實例 OK；水平擴展需改 Redis）
 *  - 共用 bookingHelpers 的 ragicGet/ragicPut/ragicPost（同一個 OnePlaceLiving app）
 *  - LINE 推卡片重用 LINE_MESSAGING_TENANT_ACCESS_TOKEN（與 confirm 卡片同 channel）
 */
import crypto from "crypto";
import { ragicGet, ragicPut, ragicPost } from "./bookingHelpers";

// ─── 設定 ────────────────────────────────────────────────────────────────
const config = {
  // 中信企業識別碼（5 碼）— 決定虛擬帳號開頭，務必正確，錯誤＝匯錯帳
  enterpriseId: process.env.ENTERPRISE_ID || "",
  devMode: process.env.DEV_MODE === "true",
  devOtp: process.env.DEV_OTP || "888888",
  mitake: {
    username: process.env.MITAKE_USERNAME,
    password: process.env.MITAKE_PASSWORD,
    apiUrl: process.env.MITAKE_API_URL || "https://smsapi.mitake.com.tw/b2c/mtk/SmSend",
  },
  webhook: {
    url: process.env.N8N_REMITTANCE_WEBHOOK_URL,
    secret: process.env.N8N_REMITTANCE_WEBHOOK_SECRET,
  },
  line: {
    // 重用預約系統既有的租客推播 token（同一官方帳號 channel）
    token: process.env.LINE_MESSAGING_TENANT_ACCESS_TOKEN,
    pushApiUrl: "https://api.line.me/v2/bot/message/push",
  },
  debug: process.env.DEBUG_MODE === "true",
};

// ─── 安全常數 ────────────────────────────────────────────────────────────
const OTP_RESEND_INTERVAL_MS = 60 * 1000; // 同電話再次發送間隔 60 秒
const OTP_MAX_PER_DAY = 10; // 同電話每日最多發送次數
const OTP_LOCK_DURATION_MS = 30 * 60 * 1000; // 失敗鎖定 30 分鐘
const OTP_GLOBAL_MAX_ATTEMPTS = 5; // 同電話總共最多錯誤次數
const VERIFY_TOKEN_TTL_MS = 30 * 60 * 1000; // verifyToken 有效期 30 分鐘
const OTP_TTL_MS = 5 * 60 * 1000; // OTP 有效期 5 分鐘

// ─── 記憶體狀態 ──────────────────────────────────────────────────────────
type OtpEntry = { code: string; createdAt: number; expiresAt: number; attempts: number };
type GuardEntry = {
  lastSendAt: number;
  sendCountToday: number;
  dayKey: string;
  failedCount: number;
  lockedUntil: number;
  checkLog?: number[];
};
type SessionEntry = { phone: string; createdAt: number; expiresAt: number };

const otpStore = new Map<string, OtpEntry>();
const phoneGuard = new Map<string, GuardEntry>();
const verifiedSessions = new Map<string, SessionEntry>();
let lastMitakeAccountPoint: string | null = null;

// 定期清理過期資料，避免記憶體洩漏
setInterval(() => {
  const now = Date.now();
  for (const [phone, otp] of otpStore.entries()) if (otp.expiresAt < now) otpStore.delete(phone);
  for (const [token, s] of verifiedSessions.entries()) if (s.expiresAt < now) verifiedSessions.delete(token);
  for (const [phone, g] of phoneGuard.entries()) {
    const stale = now - Math.max(g.lastSendAt, g.lockedUntil) > 24 * 60 * 60 * 1000;
    if (stale && g.lockedUntil < now) phoneGuard.delete(phone);
  }
}, 5 * 60 * 1000);

// ─── 工具 ────────────────────────────────────────────────────────────────
function maskPhone(phone: string): string {
  if (!phone || typeof phone !== "string" || phone.length < 6) return "***";
  return phone.substring(0, 4) + "****" + phone.substring(phone.length - 2);
}

function getTodayKey(): string {
  return new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
}

function getPhoneGuard(phone: string): GuardEntry {
  let g = phoneGuard.get(phone);
  const today = getTodayKey();
  if (!g) {
    g = { lastSendAt: 0, sendCountToday: 0, dayKey: today, failedCount: 0, lockedUntil: 0 };
    phoneGuard.set(phone, g);
  } else if (g.dayKey !== today) {
    g.sendCountToday = 0;
    g.dayKey = today;
  }
  return g;
}

function isPhoneLocked(phone: string): boolean {
  const g = phoneGuard.get(phone);
  if (!g) return false;
  return g.lockedUntil > Date.now();
}

/** 時序安全的字串比較（防 timing attack） */
function safeEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueVerifyToken(phone: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  verifiedSessions.set(token, { phone, createdAt: now, expiresAt: now + VERIFY_TOKEN_TTL_MS });
  return token;
}

/** 驗證 session token；consume=true 為一次性消耗 */
function checkVerifyToken(token: string | undefined, phone: string, consume = false): boolean {
  if (!token) return false;
  const s = verifiedSessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    verifiedSessions.delete(token);
    return false;
  }
  if (s.phone !== phone) return false;
  if (consume) verifiedSessions.delete(token);
  return true;
}

function isTaiwanMobile(phone: string): boolean {
  return /^09\d{8}$/.test(phone);
}

/**
 * 取 8 碼「繳款人識別碼」
 * - 台灣手機：去除 09 取後 8 碼
 * - 外國電話：開頭固定 9 + 純數字的 SHA-256 雜湊 7 碼（內部規則）
 */
function getPayerId(phone: string): string {
  if (isTaiwanMobile(phone)) return phone.substring(2);
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) throw new Error("電話必須含有數字");
  const hash = crypto.createHash("sha256").update(digits).digest("hex");
  const n = parseInt(hash.substring(0, 7), 16) % 10_000_000;
  return "9" + String(n).padStart(7, "0");
}

/**
 * 生成 14 碼虛擬帳號：企業識別碼(5) + 繳款人識別碼(8) + 檢查碼(1)
 * @throws 若 ENTERPRISE_ID 未設定或非 5 碼數字（避免產出錯誤帳號導致匯錯帳）
 */
export function generateVirtualAccount(phone: string): string {
  const enterpriseID = config.enterpriseId;
  if (!/^\d{5}$/.test(enterpriseID)) {
    throw new Error("ENTERPRISE_ID 未設定或非 5 碼數字，無法產生虛擬帳號");
  }
  const payerID = getPayerId(phone);
  const sourceStr = enterpriseID + payerID; // 13 碼
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3];
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const product = parseInt(sourceStr[i]) * weights[i];
    sum += product % 10;
  }
  let checkCode = 10 - (sum % 10);
  if (checkCode === 10) checkCode = 0;
  return sourceStr + checkCode.toString();
}

function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── 三竹 ────────────────────────────────────────────────────────────────
const MITAKE_ERROR_CODES: Record<string, string> = {
  "*": "系統發生錯誤，請聯絡三竹資訊窗口人員",
  a: "簡訊發送功能暫時停止服務，請稍候再試",
  b: "簡訊發送功能暫時停止服務，請稍候再試",
  c: "請輸入帳號",
  d: "請輸入密碼",
  e: "帳號、密碼錯誤",
  f: "帳號已過期",
  h: "帳號已被停用",
  k: "無效的連線位址",
  l: "帳號已達到同時連線數上限",
  m: "必須變更密碼，在變更密碼前，無法使用簡訊發送服務",
  n: "密碼已逾期，在變更密碼前，將無法使用簡訊發送服務",
  p: "沒有權限使用外部 Http 程式",
  r: "系統暫停服務，請稍後再試",
  s: "帳務處理失敗，無法發送簡訊",
  t: "簡訊已過期",
  u: "簡訊內容不得為空白",
  v: "無效的手機號碼",
  x: "發送檔案過大，無法發送簡訊",
  y: "參數錯誤",
};

function parseMitakeResponse(responseText: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of responseText.split(/[\r\n]+/)) {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) result[key.trim()] = valueParts.join("=").trim();
  }
  return result;
}

function isMitakeSuccess(statuscode: string): boolean {
  return ["0", "1", "2", "4"].includes(statuscode);
}

// ─── LINE 虛擬帳號 Flex 卡片 ─────────────────────────────────────────────
function buildVirtualAccountFlexMessage(virtualAccount: string) {
  return {
    type: "flex" as const,
    altText: "[固定式虛擬帳號]",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🏠 歡迎成為一方生活的室友", weight: "bold", color: "#FFFFFF", size: "md" },
        ],
        backgroundColor: "#6D846F",
        paddingAll: "md",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "這是您的專屬固定虛擬帳號，請先存起來！", size: "sm", color: "#666666", wrap: true, margin: "sm" },
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "銀行代碼", color: "#888888", size: "sm", flex: 2 },
                  { type: "text", text: "822 (中國信託)", wrap: true, color: "#333333", size: "sm", flex: 4, weight: "bold" },
                ],
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "虛擬帳號", color: "#888888", size: "sm", flex: 2 },
                  { type: "text", text: String(virtualAccount), wrap: true, color: "#111111", size: "lg", flex: 4, weight: "bold" },
                ],
              },
            ],
            backgroundColor: "#F5F7FA",
            paddingAll: "md",
            cornerRadius: "md",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            action: { type: "clipboard", label: "複製帳號", clipboardText: String(virtualAccount) },
            color: "#6D846F",
          },
        ],
        flex: 0,
        paddingAll: "md",
      },
    },
  };
}

async function pushLineFlex(userId: string, flexMessage: any): Promise<{ success: boolean; error?: string }> {
  const token = config.line.token;
  if (!userId || !token) return { success: false, error: "missing_userId_or_token" };
  try {
    const resp = await fetch(config.line.pushApiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: userId, messages: [flexMessage] }),
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

// ─── Handlers ────────────────────────────────────────────────────────────

/** 查詢租客是否已有固定虛擬帳號（不回傳帳號本身，需經 OTP 才核發） */
export async function handleCheckTenant(input: { phone: string }) {
  const { phone } = input;
  if (!/^\d{8,15}$/.test(phone)) return { success: false, message: "電話號碼格式錯誤" };

  if (isPhoneLocked(phone)) return { success: false, message: "此手機已被暫時鎖定，請稍後再試" };

  // 60 秒內最多查 3 次
  const cguard = getPhoneGuard(phone);
  cguard.checkLog = (cguard.checkLog || []).filter((t) => Date.now() - t < 60000);
  if (cguard.checkLog.length >= 3) return { success: false, message: "查詢過於頻繁，請稍後再試" };
  cguard.checkLog.push(Date.now());

  try {
    const data = await ragicGet("for-system-use/2", { where: `1007372,eq,${phone}`, limit: "1" });
    const records = Object.values(data) as any[];
    if (records.length > 0 && (records[0] as any)["_ragicId"] !== undefined) {
      const r = records[0] as any;
      const va = r["固定式虛擬帳號"] || r["1021087"] || r["_ragicId_1021087"];
      if (va) return { success: true, hasFixedVirtualAccount: true };
    }
  } catch (err: any) {
    console.error("[Remittance] check-tenant Ragic error:", err.message);
  }
  return { success: true, hasFixedVirtualAccount: false };
}

/** 發送 OTP（台灣手機走三竹；外國電話引導客服用 MASTER_OTP） */
export async function handleSendOtp(input: { phone: string }) {
  const { phone } = input;
  if (!phone || !/^\d{8,15}$/.test(phone)) return { success: false, message: "請輸入有效的電話號碼" };

  if (!isTaiwanMobile(phone)) {
    return { success: false, isForeignPhone: true, message: "外國電話無法發送簡訊，請聯繫一方客服取得驗證碼" };
  }

  if (isPhoneLocked(phone)) {
    const g = phoneGuard.get(phone)!;
    const remain = Math.ceil((g.lockedUntil - Date.now()) / 60000);
    return { success: false, message: `此手機已被暫時鎖定，請於 ${remain} 分鐘後再試` };
  }

  const guard = getPhoneGuard(phone);
  if (guard.lastSendAt && Date.now() - guard.lastSendAt < OTP_RESEND_INTERVAL_MS) {
    const wait = Math.ceil((OTP_RESEND_INTERVAL_MS - (Date.now() - guard.lastSendAt)) / 1000);
    return { success: false, message: `請等待 ${wait} 秒後再重新發送` };
  }
  if (guard.sendCountToday >= OTP_MAX_PER_DAY) {
    return { success: false, message: "今日驗證碼發送次數已達上限，請明日再試或聯繫客服" };
  }

  // 開發模式：固定驗證碼
  if (config.devMode) {
    otpStore.set(phone, { code: config.devOtp, createdAt: Date.now(), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    guard.lastSendAt = Date.now();
    guard.sendCountToday += 1;
    return { success: true, message: "驗證碼已發送至您的手機", devMode: true };
  }

  const otp = generateOTP();
  otpStore.set(phone, { code: otp, createdAt: Date.now(), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  if (!config.mitake.username || !config.mitake.password) {
    return { success: false, message: "系統設定錯誤，請聯繫管理員（三竹憑證未設定）" };
  }

  try {
    const params = new URLSearchParams({
      username: config.mitake.username,
      password: config.mitake.password,
      dstaddr: phone,
      smbody: `【一方生活】您的驗證碼為：${otp}，請於5分鐘內完成驗證。`,
    });
    const resp = await fetch(`${config.mitake.apiUrl}?CharsetURL=UTF8`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: params.toString(),
    });
    const responseText = await resp.text();
    const mitakeResult = parseMitakeResponse(responseText);
    const statuscode = mitakeResult.statuscode;
    if (isMitakeSuccess(statuscode)) {
      lastMitakeAccountPoint = mitakeResult.AccountPoint || null;
      guard.lastSendAt = Date.now();
      guard.sendCountToday += 1;
      console.log(`[Remittance] OTP 發送成功 phone=${maskPhone(phone)} 剩餘點數=${mitakeResult.AccountPoint}`);
      return { success: true, message: "驗證碼已發送至您的手機" };
    }
    const errorMessage = MITAKE_ERROR_CODES[statuscode] || `發送失敗 (錯誤碼: ${statuscode})`;
    console.error(`[Remittance] OTP 發送失敗 phone=${maskPhone(phone)} code=${statuscode}`);
    return { success: false, message: errorMessage, errorCode: statuscode };
  } catch (err: any) {
    console.error("[Remittance] send-otp 例外:", err.message);
    return { success: false, message: "發送驗證碼失敗，請稍後重試" };
  }
}

/** 驗證 OTP → 成功核發虛擬帳號 + verifyToken */
export async function handleVerifyOtp(input: { phone: string; otp: string }) {
  const { phone, otp } = input;
  if (!phone || !otp) return { success: false, message: "請提供手機號碼和驗證碼" };
  if (!/^\d{8,15}$/.test(phone)) return { success: false, message: "電話號碼格式錯誤" };

  const guard = getPhoneGuard(phone);

  // 萬能密碼優先（客服救場，即使鎖定也有效）
  const masterOtp = process.env.MASTER_OTP;
  if (masterOtp && safeEqual(otp, masterOtp)) {
    console.warn(`[Remittance][AUDIT] 萬能密碼使用 phone=${maskPhone(phone)} wasLocked=${isPhoneLocked(phone)}`);
    guard.lockedUntil = 0;
    guard.failedCount = 0;
    const virtualAccount = generateVirtualAccount(phone);
    const verifyToken = issueVerifyToken(phone);
    return { success: true, message: "驗證成功", virtualAccount, verifyToken };
  }

  if (isPhoneLocked(phone)) {
    const remain = Math.ceil((guard.lockedUntil - Date.now()) / 60000);
    return { success: false, message: `此手機已被暫時鎖定，請於 ${remain} 分鐘後再試` };
  }

  const storedOtp = otpStore.get(phone);
  if (!storedOtp) {
    guard.failedCount = (guard.failedCount || 0) + 1;
    if (guard.failedCount >= OTP_GLOBAL_MAX_ATTEMPTS) {
      guard.lockedUntil = Date.now() + OTP_LOCK_DURATION_MS;
      return { success: false, message: "錯誤次數過多，手機已被暫時鎖定 30 分鐘" };
    }
    return { success: false, message: "請先發送驗證碼" };
  }
  if (Date.now() > storedOtp.expiresAt) {
    otpStore.delete(phone);
    return { success: false, message: "驗證碼已過期，請重新發送" };
  }
  if (!safeEqual(storedOtp.code, otp)) {
    storedOtp.attempts = (storedOtp.attempts || 0) + 1;
    guard.failedCount = (guard.failedCount || 0) + 1;
    if (guard.failedCount >= OTP_GLOBAL_MAX_ATTEMPTS) {
      guard.lockedUntil = Date.now() + OTP_LOCK_DURATION_MS;
      otpStore.delete(phone);
      return { success: false, message: "驗證碼錯誤次數過多，手機已被暫時鎖定 30 分鐘" };
    }
    if (storedOtp.attempts >= 5) {
      otpStore.delete(phone);
      return { success: false, message: "驗證碼錯誤次數過多，請重新發送驗證碼" };
    }
    return { success: false, message: `驗證碼錯誤，剩餘 ${OTP_GLOBAL_MAX_ATTEMPTS - guard.failedCount} 次嘗試機會` };
  }

  // 成功
  otpStore.delete(phone);
  guard.failedCount = 0;
  const virtualAccount = generateVirtualAccount(phone);
  const verifyToken = issueVerifyToken(phone);
  return { success: true, message: "驗證成功", virtualAccount, verifyToken };
}

/** 提交：核對 verifyToken + 重算 VA 防篡改 → upsert 租客主檔 + 推 VA 卡 + 發 n8n */
export async function handleSubmitRemittance(input: {
  uid?: string;
  name: string;
  phone: string;
  idNumber: string;
  email: string;
  job: string;
  virtualAccount: string;
  verifyToken: string;
  lineProfile?: { userId?: string; displayName?: string | null; pictureUrl?: string | null; statusMessage?: string | null } | null;
}) {
  const { uid, name, phone, idNumber, email, job, virtualAccount, verifyToken, lineProfile } = input;

  if (!name || !phone || !idNumber || !email || !job || !virtualAccount) {
    return { success: false, message: "請填寫所有必填欄位" };
  }
  if (!/^\d{8,15}$/.test(phone)) return { success: false, message: "電話號碼格式錯誤" };

  // 必須持有有效 verifyToken（驗證過該電話 OTP 才能提交）
  if (!checkVerifyToken(verifyToken, phone, true)) {
    console.warn(`[Remittance] submit 未持有效 verifyToken phone=${maskPhone(phone)}`);
    return { success: false, message: "未通過驗證，請重新進行手機驗證" };
  }

  // 重算虛擬帳號，防前端篡改
  const expectedVA = generateVirtualAccount(phone);
  if (virtualAccount !== expectedVA) {
    console.warn(`[Remittance] submit 虛擬帳號不一致 phone=${maskPhone(phone)}`);
    return { success: false, message: "虛擬帳號驗證失敗" };
  }

  // Ragic 欄位（for-system-use/2 租客主檔）
  const F = {
    uid: "1007383",
    name: "1007373",
    phone: "1007372",
    idNumber: "1007374",
    email: "1007542",
    job: "1007377",
    virtualAccount: "1021087",
  };
  const ragicData: Record<string, any> = {
    [F.uid]: uid || "",
    [F.name]: name,
    [F.phone]: phone,
    [F.idNumber]: idNumber,
    [F.email]: email,
    [F.job]: job,
    [F.virtualAccount]: virtualAccount,
  };

  // upsert：先用電話查現有記錄
  try {
    const searchData = await ragicGet("for-system-use/2", { where: `${F.phone},eq,${phone}`, limit: "1" });
    const ids = Object.keys(searchData).filter((k) => k !== "status");
    const ragicId = ids.length > 0 ? Number(searchData[ids[0]]?.["_ragicId"] ?? ids[0]) : null;
    if (ragicId && !isNaN(ragicId)) {
      await ragicPut("for-system-use/2", ragicId, ragicData);
      console.log(`[Remittance] Ragic 更新成功 phone=${maskPhone(phone)} id=${ragicId}`);
    } else {
      await ragicPost("for-system-use/2", ragicData);
      console.log(`[Remittance] Ragic 新增成功 phone=${maskPhone(phone)}`);
    }
  } catch (err: any) {
    console.error(`[Remittance] Ragic 寫入失敗 phone=${maskPhone(phone)}:`, err.message);
    return { success: false, message: "資料提交失敗，請稍後重試" };
  }

  // 推 LINE 虛擬帳號卡片（失敗不影響主流程）
  const lineUserId = lineProfile?.userId || uid;
  if (lineUserId) {
    const r = await pushLineFlex(lineUserId, buildVirtualAccountFlexMessage(virtualAccount));
    if (!r.success) console.warn(`[Remittance] LINE 推卡片失敗: ${r.error}`);
  } else {
    console.warn("[Remittance] 無 lineUserId，跳過推卡片");
  }

  // n8n webhook（失敗不影響主流程）
  if (config.webhook.url) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.webhook.secret) headers["X-Webhook-Secret"] = config.webhook.secret;
      await fetch(config.webhook.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          event: "remittance_submitted",
          timestamp: new Date().toISOString(),
          lineProfile: lineProfile || { userId: uid, displayName: null, pictureUrl: null, statusMessage: null },
          formData: { name, phone, idNumber, email, job },
          virtualAccount,
          smsCredits: lastMitakeAccountPoint,
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      console.error("[Remittance] n8n webhook 失敗:", err.message);
    }
  }

  return { success: true, message: "資料提交成功", virtualAccount };
}
