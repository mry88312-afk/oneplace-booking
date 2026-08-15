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

// ─── 房間解析：用 line_uid / 電話 反查該人所有有效合約的房間（含共同承租/主客2） ──────────
// P96 背景：房間/共同承租只記在 Ragic 合約的 1015116(全體租客電話)；Supabase 的
//   tenant_contract_parties 每份合約只有 ≤1 位租客（沒存共同承租），但整份 Ragic 合約有鏡像進
//   tenant_contracts.legacy_snapshot(JSONB)。故改用 legacy_snapshot->'1015116' 反查電話 → 命中
//   該人「當主客1 或主客2」的所有有效合約。一人可多份有效約 → 回傳陣列，呼叫端決定要不要讓租客選。
export interface Residence {
  contractNo: string;
  room: string;              // 房號（優先用 Ragic 房間編號 1007552 全列，格式與退租日曆/現行流程一致）
  property: string | null;   // 案場簡稱
  propertyId: string | null; // property.properties.id
  tenantCount: number;       // 該合約租客數（>1 = 共同承租）
  contractRecordId?: number | null;     // go-back/22 合約記錄 id（由 verify handler 補；退租/續約回寫用）
  renewalWindow?: RenewalWindow | null; // 只有 renewal 專案才填（每份合約各自的續約日期視窗）
}

interface ResidenceRow {
  contract_no: string | null;
  room: string | null;
  property: string | null;
  property_id: string | null;
  tenant_count: number | string | null;
}

const RESIDENCE_SELECT = `select tc.contract_no,
              coalesce(
                nullif(array_to_string(array(select jsonb_array_elements_text(
                   case when jsonb_typeof(tc.legacy_snapshot->'1007552')='array'
                        then tc.legacy_snapshot->'1007552' else '[]'::jsonb end)), ', '), ''),
                nullif(u.unit_no,''), nullif(u.room_code,''), nullif(tc.legacy_snapshot->>'1014736','')
              ) as room,
              p.short_name as property, p.id as property_id,
              jsonb_array_length(case when jsonb_typeof(tc.legacy_snapshot->'1015116')='array'
                                      then tc.legacy_snapshot->'1015116' else '[]'::jsonb end) as tenant_count`;

const ACTIVE_RESIDENCE_FILTER = `tc.deleted_at is null and tc.move_out_date is null
          and (tc.legacy_snapshot->>'1007778') = '存在'`;

function mapResidenceRows(rows: ResidenceRow[]): Residence[] {
  return rows
    .map((row) => ({
      contractNo: row.contract_no || "",
      room: row.room || "",
      property: row.property || null,
      propertyId: row.property_id || null,
      tenantCount: Number(row.tenant_count) || 1,
    }))
    .filter((residence) => residence.room);
}

function buildPhoneCandidates(phone: string): string[] {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^0-9]/g, "");
  const candidates = new Set([trimmed, digits]);
  if (/^09\d{8}$/.test(digits)) {
    candidates.add(`${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`);
    candidates.add(`${digits.slice(0, 4)}-${digits.slice(4)}`);
    candidates.add(`${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`);
  }
  return [...candidates].filter(Boolean);
}

/** 用 line_uid（先換電話）或直接用電話，反查所有有效合約的房間。抓不到/出錯一律回 []（呼叫端優雅降級回舊邏輯）。 */
export async function resolveResidences(opts: { lineUid?: string; phone?: string }): Promise<Residence[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    let phone = (opts.phone || "").trim();
    let tenantId = "";
    if (opts.lineUid) {
      const rows = await sbQuery<{ id: string; primary_phone: string | null }>(
        `select id, primary_phone from contract.tenants where line_uid=$1 limit 1`,
        [opts.lineUid],
      );
      tenantId = rows[0]?.id || "";
      phone = phone || rows[0]?.primary_phone || "";
    }

    if (!tenantId) {
      if (!phone) return [];
      const phoneCandidates = buildPhoneCandidates(phone);
      const exactTenant = await sbQuery<{ id: string; primary_phone: string | null }>(
        `select id, primary_phone from contract.tenants where primary_phone=any($1::text[]) limit 1`,
        [phoneCandidates],
      );
      tenantId = exactTenant[0]?.id || "";
      phone = exactTenant[0]?.primary_phone || phone;
    }

    // P104：主租客先走有索引的關係表，避免每次都展開全表 legacy JSONB 而 statement timeout。
    if (tenantId) {
      const linkedRows = await sbQuery<ResidenceRow>(
        `${RESIDENCE_SELECT}
         from contract.tenant_contract_parties tcp
         join contract.tenant_contracts tc on tc.id = tcp.tenant_contract_id
         left join property.units u on u.id = tc.unit_id
         left join property.properties p on p.id = tc.property_id
        where tcp.tenant_id=$1 and ${ACTIVE_RESIDENCE_FILTER}
        order by tc.start_date desc nulls last
        limit 10`,
        [tenantId],
      );
      const linkedResidences = mapResidenceRows(linkedRows);
      if (linkedResidences.length > 0) return linkedResidences;
    }

    if (!phone) return [];

    // 共同承租／主客2可能沒有 parties 關聯；先用精確 JSONB containment，再保留舊的正規化電話備援。
    const phoneCandidates = buildPhoneCandidates(phone);
    const exactSnapshotRows = await sbQuery<ResidenceRow>(
      `${RESIDENCE_SELECT}
         from contract.tenant_contracts tc
         left join property.units u on u.id = tc.unit_id
         left join property.properties p on p.id = tc.property_id
        where ${ACTIVE_RESIDENCE_FILTER}
          and (case when jsonb_typeof(tc.legacy_snapshot->'1015116')='array'
                    then tc.legacy_snapshot->'1015116' else '[]'::jsonb end) ?| $1::text[]
        order by tc.start_date desc nulls last
        limit 10`,
      [phoneCandidates],
    );
    const exactSnapshotResidences = mapResidenceRows(exactSnapshotRows);
    if (exactSnapshotResidences.length > 0) return exactSnapshotResidences;

    const normalizedSnapshotRows = await sbQuery<ResidenceRow>(
      `${RESIDENCE_SELECT}
         from contract.tenant_contracts tc
         left join property.units u on u.id = tc.unit_id
         left join property.properties p on p.id = tc.property_id
        where ${ACTIVE_RESIDENCE_FILTER}
          and exists (
            select 1 from jsonb_array_elements_text(
              case when jsonb_typeof(tc.legacy_snapshot->'1015116')='array'
                   then tc.legacy_snapshot->'1015116' else '[]'::jsonb end
            ) ph where regexp_replace(ph,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')
          )
        order by tc.start_date desc nulls last
        limit 10`,
      [phone],
    );
    return mapResidenceRows(normalizedSnapshotRows);
  } catch (e: any) {
    console.error("[resolveResidences] Supabase 查詢失敗:", e?.message);
    return [];
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
