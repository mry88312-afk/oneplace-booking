import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { errorCode } from "../../shared/bookingErrors";

const createDatabase = (client: Pool) => drizzle({ client });
let database: ReturnType<typeof createDatabase> | null = null;
let pool: Pool | null = null;
let rebuilding: Promise<void> | null = null;
let lastHealthCheck = 0;

/** Separate service credentials; never fall back to the old Manus MySQL database. */
export function createBookingPool(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Booking requires PostgreSQL');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(process.env.BOOKING_DATABASE_CA ? { ca: process.env.BOOKING_DATABASE_CA.replace(/\\n/g, '\n') } : {}) },
    max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    query_timeout: 20_000, application_name: 'oneplace-booking',
  });
}

async function rebuild() {
  if (rebuilding) return rebuilding;
  rebuilding = (async () => {
    const old = pool;
    pool = null;
    database = null;
    await old?.end().catch(() => {});
    if (!process.env.BOOKING_DATABASE_URL) return;
    let candidate: Pool | null = null;
    try {
      candidate = createBookingPool(process.env.BOOKING_DATABASE_URL);
      candidate.on('error', error => console.error('[Booking DB] Idle connection:', errorCode(error)));
      await candidate.query('SELECT 1');
      pool = candidate;
      database = createDatabase(candidate);
      lastHealthCheck = Date.now();
    } catch (error) {
      console.error('[Booking DB] Connection failed:', errorCode(error));
      await candidate?.end().catch(() => {});
    }
  })().finally(() => { rebuilding = null; });
  return rebuilding;
}

export async function getDb() {
  if (!database) await rebuild();
  else if (pool && Date.now() - lastHealthCheck >= 30_000) {
    lastHealthCheck = Date.now();
    try { await pool.query('SELECT 1'); }
    catch { await rebuild(); }
  }
  return database;
}

export function isDatabaseHealthy() { return database !== null && pool !== null; }

export async function closeDb() {
  const old = pool;
  pool = null;
  database = null;
  lastHealthCheck = 0;
  await old?.end();
}
