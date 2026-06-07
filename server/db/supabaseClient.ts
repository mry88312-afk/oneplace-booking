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
