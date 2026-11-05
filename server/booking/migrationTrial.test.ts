import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Client } from 'pg';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { router, publicProcedure, adminProcedure } from '../_core/trpc';
import { createContext } from '../_core/context';
import { assertTrialConfiguration, migrationTrialMiddleware } from './migrationTrial';
import { bookingWritesEnabled } from './runtime';
import { createBookingPool } from '../db/connection';

test('trial blocks HTTP side effects, all mutations, unknown/admin queries and batched writes before handlers', async t => {
  const saved = { ...process.env };
  Object.assign(process.env, { BOOKING_MIGRATION_TRIAL: 'true', BOOKING_WRITES_ENABLED: 'false', ADMIN_PASSWORD: 'fixture' });
  t.after(() => { process.env = saved; });
  let writes = 0;
  const mutation = publicProcedure.mutation(() => { writes++; return true; });
  const app = express();
  app.use(migrationTrialMiddleware, express.json());
  app.use('/api/trpc', createExpressMiddleware({ createContext, allowMethodOverride: true, router: router({
    booking: router({ getPublicTemplate: publicProcedure.query(() => ({ migrationTrial: true })), confirmBooking: mutation,
      unexpectedRead: publicProcedure.query(() => { writes++; return true; }),
      adminRead: adminProcedure.query(() => { writes++; return true; }) }),
  }) }));
  app.all(['/f/:id', '/api/outreach/run', '/api/outreach/test-send', '/api/line/inbound', '/api/future'], (_req, res) => { writes++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ['/f/fixture?r=ok', '/api/outreach/run', '/api/outreach/test-send', '/api/line/inbound', '/api/future']) {
    for (const method of ['GET', 'POST', 'HEAD']) assert.equal((await fetch(base + path, { method })).status, 403, `${method} ${path}`);
  }
  for (const [path, method] of [['confirmBooking', 'POST'], ['unexpectedRead', 'GET'], ['adminRead', 'GET']]) {
    assert.equal((await fetch(`${base}/api/trpc/booking.${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-password': 'fixture' }, ...(method === 'POST' ? { body: '{"json":null}' } : {}) })).status, 403);
  }
  const batch = await fetch(`${base}/api/trpc/booking.getPublicTemplate,booking.confirmBooking?batch=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"0":{"json":null},"1":{"json":null}}' });
  assert.equal(batch.status, 400, 'tRPC rejects mixed query/mutation batches before execution');
  const queryBatch = await fetch(`${base}/api/trpc/booking.getPublicTemplate,booking.unexpectedRead?batch=1`);
  assert.equal(queryBatch.status, 207);
  const batchResult = await queryBatch.json();
  assert.equal(batchResult[1].error.json.data.code, 'FORBIDDEN');
  assert.equal(writes, 0);
  const read = await fetch(`${base}/api/trpc/booking.getPublicTemplate`);
  assert.equal(read.status, 200);
  assert.match(read.headers.get('content-security-policy')!, /connect-src 'self'/);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  process.env.BOOKING_MIGRATION_TRIAL = 'false';
  assert.equal((await fetch(`${base}/api/trpc/booking.confirmBooking`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"json":null}' })).status, 200);
  assert.equal(writes, 1, 'normal environment remains enabled');
});

test('trial overrides write flag, rejects outbound credentials and forces read-only pg options', async t => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  for (const key of ['RAGIC_API_KEY', 'SUPABASE_DB_URL', 'OUTREACH_RUN_SECRET', 'MAIN_SYSTEM_WEBHOOK_URL', 'BOOKING_WEBHOOK_SECRET', 'ADMIN_PASSWORD', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET']) delete process.env[key];
  process.env.BOOKING_MIGRATION_TRIAL = 'true';
  process.env.BOOKING_DATASET_ID = 'fixture-dataset';
  process.env.BOOKING_WRITES_ENABLED = 'true';
  assert.equal(bookingWritesEnabled(), false);
  assert.throws(assertTrialConfiguration, /requires/);
  process.env.BOOKING_WRITES_ENABLED = 'false';
  process.env.OUTREACH_RUN_SECRET = 'fixture';
  assert.throws(assertTrialConfiguration, /OUTREACH_RUN_SECRET/);
  delete process.env.OUTREACH_RUN_SECRET;
  assertTrialConfiguration();
  const pool = createBookingPool('postgresql://fixture:fixture@localhost/fixture?options=-c%20default_transaction_read_only%3Doff');
  assert.equal(pool.options.options, '-c default_transaction_read_only=on');
  assert.ok(!pool.options.connectionString?.includes('options='));
  const client = new Client();
  const queryMock = t.mock.method(client, 'query', async () => ({ rows: [{ default_transaction_read_only: 'off' }] }));
  await assert.rejects(async () => pool.options.onConnect?.(client), /not read-only/);
  queryMock.mock.mockImplementation(async () => ({ rows: [{ default_transaction_read_only: 'on' }] }));
  await pool.options.onConnect?.(client);
  assert.throws(() => createBookingPool('postgresql://fixture@localhost:6543/fixture'), /session connection/);
  await pool.end();
});
