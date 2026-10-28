import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBookingWritesEnabled, assertBookingDataset, bookingActionUrl } from './runtime';

test('writes require both an explicit switch and a fixed dataset', t => {
  const old = { ...process.env };
  t.after(() => { process.env = old; });
  delete process.env.BOOKING_DATASET_ID;
  process.env.BOOKING_WRITES_ENABLED = 'true';
  assert.throws(assertBookingWritesEnabled, { code: 'SERVICE_UNAVAILABLE' });
  process.env.BOOKING_DATASET_ID = 'booking-fixture';
  process.env.BOOKING_WRITES_ENABLED = 'false';
  assert.throws(assertBookingWritesEnabled, { code: 'SERVICE_UNAVAILABLE' });
  process.env.BOOKING_WRITES_ENABLED = 'true';
  assert.doesNotThrow(assertBookingWritesEnabled);
  assert.throws(() => assertBookingDataset(), { code: 'PRECONDITION_FAILED' });
  assert.throws(() => assertBookingDataset('old-dataset'), { code: 'PRECONDITION_FAILED' });
  assert.doesNotThrow(() => assertBookingDataset('booking-fixture'));
  for (const action of ['cancel', 'reschedule'] as const) {
    const url = new URL(bookingActionUrl('fixture-liff', action, 1));
    assert.equal(url.searchParams.get('dataset'), 'booking-fixture');
    assert.equal(url.searchParams.get(action), '1');
  }
});

test('old cards cannot read, cancel or reschedule a reused numeric ID', async t => {
  const old = { ...process.env };
  t.after(() => { process.env = old; });
  Object.assign(process.env, { BOOKING_DATASET_ID: 'booking-fixture', BOOKING_WRITES_ENABLED: 'true' });
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('unexpected'); });
  const handlers = await import('../routers/property/bookingRescheduleHandlers');
  for (const datasetId of [undefined, 'old-dataset']) {
    const input = { bookingId: 1, uid: 'same-user', datasetId };
    await assert.rejects(handlers.handleGetBookingForReschedule(input), { code: 'PRECONDITION_FAILED' });
    await assert.rejects(handlers.handleCancelBookingPublic(input), { code: 'PRECONDITION_FAILED' });
    await assert.rejects(handlers.handleRescheduleBooking({ ...input, date: '2026-11-01', startTime: '', endTime: '', calendarId: '', assigneeName: '' }), { code: 'PRECONDITION_FAILED' });
  }
  assert.equal(externalCalls, 0);
});
