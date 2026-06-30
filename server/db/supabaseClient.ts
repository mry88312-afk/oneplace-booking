/**
 * Supabase (Postgres) 連線 — 僅供「週期詢問」後端使用。
 *
 * 注意：本服務的 DATABASE_URL 是 TiDB（mysql2），與 Supabase 無關。
 * Supabase 走獨立環境變數 SUPABASE_DB_URL（Supabase → Settings → Database
 * → Connection pooling 的 URI，建議用 pooler:6543）。service_role 等級的
 * 連線只存在後端，瀏覽器永遠只打 Zeabur tRPC，金鑰不外洩。
 */
import { Pool } from "pg";

let _pool: Pool | null = null;

export function isSupabaseConfigured(): boolean {
  return !!process.env.SUPABASE_DB_URL;
}

export function getSupabasePool(): Pool | null {
  if (_pool) return _pool;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return null;
  _pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase 強制 SSL；pooler 憑證在某些執行環境不在預設信任鏈，故放寬驗證
    ssl: { rejectUnauthorized: false },
  });
  _pool.on("error", (err) => {
    console.error("[Supabase] pool error:", err?.message || err);
  });
  return _pool;
}

/** 執行查詢並回傳 rows。SUPABASE_DB_URL 未設定時丟錯（呼叫端需自行處理）。 */
export async function sbQuery<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const pool = getSupabasePool();
  if (!pool) throw new Error("SUPABASE_DB_URL not set");
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// ─── 線上續約：合約到期日視窗 ────────────────────────────────────────────────
// 線上續約 (/book/renewal) 讓租客選「下一份合約到期日」。開始日固定（目前合約到期日+1天），
// 上限抓案場到期日-15天。兩個來源都已在 Supabase 鏡像（見記憶 renewal-supabase-date-sources）：
//   · 目前合約到期日 → contract.tenant_contracts.end_date（用 contract_no 對齊）
//   · 案場到期日     → contract.owner_contracts.end_date（Ragic 1007734；本質=業主包租到期日）

/** 'YYYY-MM-DD' 日期運算（UTC，避免時區位移）。 */
function ymdToUTC(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function utcToYmd(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
function addDaysYmd(ymd: string, n: number): string {
  const dt = ymdToUTC(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcToYmd(dt);
}
function addMonthsYmd(ymd: string, n: number): string {
  const dt = ymdToUTC(ymd);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return utcToYmd(dt);
}
function addYearsYmd(ymd: string, n: number): string {
  const dt = ymdToUTC(ymd);
  dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return utcToYmd(dt);
}

export interface RenewalWindow {
  ok: boolean;                     // 是否成功取得（抓不到目前合約到期日 → false，前端不顯示選擇器）
  tooLate: boolean;                // 案場即將到期，連最短1個月都簽不了 → 前端擋下、提示找專員
  contractEndDate: string | null;  // 目前合約到期日
  siteExpiryDate: string | null;   // 案場到期日（業主包租到期日）
  startDate: string | null;        // 新合約開始日 = 目前到期日 + 1天（固定不可改）
  fullYearEndDate: string | null;  // 滿1年到期日 = 開始日 + 1年 − 1天（展延門檻＋預設基準）
  minDate: string | null;          // 最短 = 開始日 + 1個月 − 1天
  maxDate: string | null;          // 上限 = 案場到期日 − 15天（null=抓不到案場到期日，不設上限）
  defaultDate: string | null;      // 預設 = 滿1年；若上限早於滿1年，改帶上限
}

const EMPTY_RENEWAL_WINDOW: RenewalWindow = {
  ok: false, tooLate: false, contractEndDate: null, siteExpiryDate: null,
  startDate: null, fullYearEndDate: null, minDate: null, maxDate: null, defaultDate: null,
};

/** 由「目前合約到期日 + 案場到期日」算出續約日期視窗（開始日/上下限/預設）。純函式，前後端共用邏輯。 */
export function computeRenewalWindow(
  contractEndDate: string,
  siteExpiryDate: string | null,
): RenewalWindow {
  const startDate = addDaysYmd(contractEndDate, 1);
  const fullYearEndDate = addDaysYmd(addYearsYmd(startDate, 1), -1); // 起日+1年-1天
  const minDate = addDaysYmd(addMonthsYmd(startDate, 1), -1);        // 起日+1月-1天
  const maxDate = siteExpiryDate ? addDaysYmd(siteExpiryDate, -15) : null;
  const tooLate = !!maxDate && maxDate < minDate;
  // 預設1年；但若案場上限早於滿1年，預設就帶上限（不超過案場）
  const defaultDate = maxDate && maxDate < fullYearEndDate ? maxDate : fullYearEndDate;
  return {
    ok: true, tooLate, contractEndDate, siteExpiryDate,
    startDate, fullYearEndDate, minDate, maxDate, defaultDate,
  };
}

/** 該到期日是否落在合法範圍（後端送出時用來防前端竄改）。 */
export function isRenewalEndValid(w: RenewalWindow, endDate: string): boolean {
  if (!w.ok || w.tooLate || !w.minDate) return false;
  if (endDate < w.minDate) return false;
  if (w.maxDate && endDate > w.maxDate) return false;
  return true;
}

/** 用合約編號（A#####）查 Supabase，回傳已算好的續約日期視窗。抓不到/出錯一律回 ok=false（前端優雅降級）。 */
export async function getRenewalWindow(contractNo: string): Promise<RenewalWindow> {
  if (!contractNo || !isSupabaseConfigured()) return EMPTY_RENEWAL_WINDOW;
  try {
    const rows = await sbQuery<{ contract_end: string | null; site_expiry: string | null }>(
      `select to_char(tc.end_date,'YYYY-MM-DD') as contract_end,
              to_char((select max(oc.end_date) from contract.owner_contracts oc
                       where oc.property_id = tc.property_id),'YYYY-MM-DD') as site_expiry
         from contract.tenant_contracts tc
        where tc.contract_no = $1
        order by tc.end_date desc nulls last
        limit 1`,
      [contractNo],
    );
    if (!rows.length || !rows[0].contract_end) {
      console.log("[getRenewalWindow] 查無合約到期日，contract_no:", contractNo);
      return EMPTY_RENEWAL_WINDOW;
    }
    return computeRenewalWindow(rows[0].contract_end, rows[0].site_expiry);
  } catch (e: any) {
    console.error("[getRenewalWindow] Supabase 查詢失敗:", e?.message);
    return EMPTY_RENEWAL_WINDOW;
  }
}

export async function closeSupabasePool(): Promise<void> {
  if (_pool) {
    try {
      await _pool.end();
    } catch {
      /* ignore */
    }
    _pool = null;
  }
}
