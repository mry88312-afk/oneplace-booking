import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { closeDb, getDb, isDatabaseHealthy } from './connection';

test('lazy PostgreSQL pool is not healthy until a query succeeds; handler stops before external writes', async t => {
  const old = { ...process.env };
  Object.assign(process.env, { BOOKING_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture', BOOKING_DATASET_ID: 'fixture-dataset', BOOKING_WRITES_ENABLED: 'true' });
  t.after(async () => { await closeDb(); process.env = old; });
  let ended = 0;
  const logs: unknown[] = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(Pool.prototype, 'query', async () => { throw Object.assign(new Error('Access denied private-user'), { code: '28P01' }); });
  t.mock.method(Pool.prototype, 'end', async () => { ended++; });
  assert.equal(await getDb(), null);
  assert.equal(isDatabaseHealthy(), false);
  assert.equal(ended, 1);
  assert.ok(!JSON.stringify(logs).includes('private-user'));
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('unexpected external request'); });
  const { handleConfirmBooking } = await import('../routers/property/bookingConfirmHandler');
  await assert.rejects(handleConfirmBooking({
    requestId: '00000000-0000-0000-0000-000000000001', datasetId: 'fixture-dataset',
    projectId: 'checkout', uid: 'fixture-user', tenantName: 'fixture', roomNumber: 'TEST',
    date: '2026-10-31', startTime: '2026-10-31T10:00:00Z', endTime: '2026-10-31T11:00:00Z',
    calendarId: 'fixture-calendar', assigneeName: 'fixture',
  }, { req: { ip: 'fixture-ip' } }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(externalCalls, 0);
});

test('old DATABASE_URL is never used as a fallback', async t => {
  const old = { ...process.env };
  delete process.env.BOOKING_DATABASE_URL;
  process.env.DATABASE_URL = 'mysql://legacy/legacy';
  t.after(async () => { await closeDb(); process.env = old; });
  assert.equal(await getDb(), null);
});
