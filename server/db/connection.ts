import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 每 30 秒做一次健康檢查

/**
 * 重建連線池（當偵測到連線池死亡時呼叫）
 */
async function rebuildPool(): Promise<void> {
  console.log("[Database] Rebuilding connection pool...");
  try {
    if (_pool) {
      try { await _pool.end(); } catch { /* ignore */ }
    }
  } finally {
    _pool = null;
    _db = null;
  }
  if (!process.env.DATABASE_URL) {
    console.error("[Database] DATABASE_URL not set!");
    return;
  }
  try {
    _pool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      timezone: "+00:00",
      connectionLimit: 20,
      queueLimit: 50,
      waitForConnections: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      idleTimeout: 60_000,
      connectTimeout: 15_000,
    });
    _db = drizzle({ client: _pool }) as any;
    console.log("[Database] Connection pool rebuilt successfully");
  } catch (error: any) {
    console.error("[Database] Failed to rebuild pool - code:", error?.code, "message:", error?.message);
    _db = null;
    _pool = null;
  }
}

/**
 * 做一次輕量健康檢查，若失敗則重建連線池
 */
async function checkAndHealPool(): Promise<void> {
  const now = Date.now();
  if (now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return;
  _lastHealthCheck = now;
  if (!_pool) return;
  try {
    const conn = await _pool.getConnection();
    await conn.query("SELECT 1");
    conn.release();
  } catch (err: any) {
    // errno 9001 = PD server timeout, errno 1040 = too many connections, etc.
    console.error("[Database] Health check failed - code:", err?.code, "errno:", err?.errno, "message:", err?.message);
    console.warn("[Database] Rebuilding pool due to health check failure...");
    await rebuildPool();
  }
}

/**
 * Get the Drizzle ORM instance backed by a mysql2 connection pool.
 *
 * Pool settings:
 *  - connectionLimit: 20 (max concurrent connections)
 *  - queueLimit: 50 (max queued requests before rejecting)
 *  - waitForConnections: true
 *  - enableKeepAlive: true (prevent idle disconnects from cloud DB)
 *  - keepAliveInitialDelay: 10_000 ms
 *  - idleTimeout: 60_000 ms (release idle connections after 1 min)
 *  - connectTimeout: 15_000 ms
 */
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    await rebuildPool();
  }

  // 如果在冷啟動或連接失敗時，嘗試重建一次
  if (!_db && process.env.DATABASE_URL) {
    console.warn("[Database] First pool build failed, retrying once...");
    await rebuildPool();
  }

  // 定期健康檢查，自動修復死亡的連線池
  if (_db) {
    await checkAndHealPool();
  }
  return _db;
}

/**
 * 快速檢查資料庫是否可用（不会觸發重建）
 * 供各 scheduler 在執行前先檢查，避免 DB 故障時卡住
 */
export function isDatabaseHealthy(): boolean {
  return _db !== null && _pool !== null;
}

/**
 * Gracefully close the connection pool (call on process shutdown).
 */
export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
