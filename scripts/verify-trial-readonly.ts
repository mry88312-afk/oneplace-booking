import assert from 'node:assert/strict';
import { parse } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { createBookingPool } from '../server/db/connection';
import { assertTrialConfiguration } from '../server/booking/migrationTrial';

// No booking_records, tenant details, writes or notification requests.
const values = parse(readFileSync('.cache/trial.env'));
for (const key of Object.keys(process.env)) {
  if (/RAGIC|SUPABASE_DB|OUTREACH|WEBHOOK|LINE_CHANNEL|ADMIN_PASSWORD/.test(key)) delete process.env[key];
}
Object.assign(process.env, values);
assertTrialConfiguration();
const pool = createBookingPool(process.env.BOOKING_DATABASE_URL!);
try {
  const readonly = await pool.query('SHOW default_transaction_read_only');
  console.log('DATABASE_SESSION_READONLY=' + String(readonly.rows[0].default_transaction_read_only));
  assert.equal(readonly.rows[0].default_transaction_read_only, 'on');
  const templates = await pool.query(`SELECT "bt_projectId" AS project_id, "bt_isActive" AS is_active FROM booking.booking_templates WHERE "bt_projectId" IN ('checkout', 'renewal')`);
  assert.equal(templates.rows.length, 2);
  assert.ok(templates.rows.every(row => row.is_active));
  const evidence = { checkedAt: new Date().toISOString(), databaseReadOnly: true, templates: templates.rows };
  writeFileSync('.cache/trial-db-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error('READONLY_CHECK_FAILED', error && typeof error === 'object' && 'code' in error ? error.code : 'validation');
  process.exitCode = 1;
} finally { await pool.end(); }
