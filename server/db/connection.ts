import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type ClientBase } from "pg";
import { errorCode } from "../../shared/bookingErrors";
import { isMigrationTrial } from '../booking/migrationTrial';

const createDatabase = (client: Pool) => drizzle({ client });
let database: ReturnType<typeof createDatabase> | null = null;
let pool: Pool | null = null;
let rebuilding: Promise<void> | null = null;
let lastHealthCheck = 0;

/** Separate service credentials; never fall back to the old Manus MySQL database. */
export function createBookingPool(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Booking requires PostgreSQL');
  if (isMigrationTrial() && url.port === '6543') throw new Error('Trial requires a session connection, not transaction pooling');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  // URL options take precedence in pg: remove them before forcing read-only sessions.
  if (isMigrationTrial()) url.searchParams.delete('options');
  return new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(process.env.BOOKING_DATABASE_CA ? { ca: process.env.BOOKING_DATABASE_CA.replace(/\\n/g, '\n') } : {}) },
    max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    query_timeout: 20_000, application_name: isMigrationTrial() ? 'oneplace-booking-trial' : 'oneplace-booking',
    ...(isMigrationTrial() ? {
      options: '-c default_transaction_read_only=on',
      // Supabase's pooler may ignore startup options. Await verification BEFORE
      // lending this connection; never alter the database role or global defaults.
      onConnect: async (client: ClientBase) => {
        await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        const result = await client.query('SHOW default_transaction_read_only');
        if (result.rows[0]?.default_transaction_read_only !== 'on') throw new Error('Trial database connection is not read-only');
      },
    } : {}),
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
