import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { google } from 'googleapis';
import { closeDb } from '../db/connection';
import { bookingRouter } from '../routers/property/booking';
import { acceptsNewBookings, bookingCardAction, bookingEntryParams, bookingLoginRedirect } from '../../shared/bookingEntry';

test('closed entry and old cards distinguish direct, encoded and malformed LIFF parameters', () => {
  assert.equal(acceptsNewBookings('contract'), false);
  assert.equal(acceptsNewBookings('renewal'), true);
  assert.equal(acceptsNewBookings('checkout'), true);
  for (const action of ['cancel', 'reschedule'] as const) {
    const search = `?${action}=5&dataset=booking-fixture`;
    for (const input of [search, `?liff.state=${encodeURIComponent(search)}`, `?liff.state=${encodeURIComponent('/book/renewal' + search)}`, `?liff.state=${encodeURIComponent(encodeURIComponent(search))}`]) {
      const params = bookingEntryParams(input);
      assert.deepEqual(bookingCardAction(params), { action, bookingId: 5 });
      assert.equal(params.get('dataset'), 'booking-fixture');
      const redirect = new URL(bookingLoginRedirect('https://booking.example', 'contract', params));
      assert.equal(redirect.pathname, '/book/renewal');
      assert.deepEqual(bookingCardAction(redirect.searchParams), { action, bookingId: 5 });
      assert.equal(redirect.searchParams.get('dataset'), 'booking-fixture');
    }
  }
  for (const id of ['', '0', '-1', '5garbage', 'Infinity', '9007199254740992'])
    assert.equal(bookingCardAction(bookingEntryParams(`?reschedule=${id}`)), null);
  assert.equal(bookingCardAction(bookingEntryParams('?liff.state=%E0%A4%A')), null);
});

test('actual handlers deny all new contract paths while inactive-template owners retain read, slots, reschedule and cancel', async t => {
  const env = { ...process.env };
  Object.assign(process.env, {
    BOOKING_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture',
    BOOKING_DATASET_ID: 'booking-fixture', BOOKING_WRITES_ENABLED: 'true',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'fixture@example.invalid', private_key: 'fixture' }),
  });
  t.after(async () => { await closeDb(); process.env = env; });
  const records = Array.from({ length: 4 }, (_, i) => ({
    br_id: 5 + i, br_templateId: 30002, br_tenantUid: `owner-${i}`, br_tenantName: '合成租客',
    br_roomNumber: 'TEST-A', br_address: '合成地址', br_bookingTime: Date.parse('2026-11-10T11:00:00Z'),
    br_durationMinutes: 60, br_status: 'confirmed', br_assigneeName: '曾國桐',
    br_googleCalendarId: 'bryan30740@gmail.com', br_ragicRecordId: String(99000 + i),
  }));
  const template = { bt_id: 30002, bt_projectId: 'contract', bt_templateType: '續約', bt_isActive: false, bt_ragicTaskPath: 'go-back/1', bt_liffId: '2006833424-znZYKjip' };
  const queries: Array<{ text: string; values: any[] }> = [];
  t.mock.method(Pool.prototype, 'query', async (config: any, values: any[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    queries.push({ text, values });
    if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    const source = text.includes('"booking_records"') ? records.find(r => r.br_id === values[0]) : template;
    if (text.startsWith('select')) {
      const columns = text.slice(7, text.indexOf(' from ')).split(',').map((s: string) => s.trim().replaceAll('"', ''));
      return { rows: source ? [columns.map((key: string) => Reflect.get(source, key) ?? null)] : [] };
    }
    if (text.startsWith('update')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected fixture SQL: ${text}`);
  });
  t.mock.method(Pool.prototype, 'end', async () => {});
  const external: Array<{ url: string; method: string; body: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: any, init: any = {}) => {
    external.push({ url: String(url), method: init.method || 'GET', body: String(init.body || '') });
    return new Response(JSON.stringify({ status: 'SUCCESS', ok: true }), { status: 200 });
  });
  const calendarFactory = google as { calendar: (...args: any[]) => any };
  t.mock.method(calendarFactory, 'calendar', () => ({ events: { list: async () => ({ data: { items: [] } }) } }));
  const caller = bookingRouter.createCaller({ req: {} as any, res: {} as any, user: null, adminPassword: null });
  const newBooking = {
    requestId: '00000000-0000-0000-0000-000000000001', datasetId: 'booking-fixture', projectId: 'contract',
    uid: 'owner-0', tenantName: '合成租客', roomNumber: 'TEST-A', date: '2026-11-10',
    startTime: '2026-11-10T08:00:00Z', endTime: '2026-11-10T09:00:00Z',
    calendarId: 'bryan30740@gmail.com', assigneeName: '曾國桐',
  };
  for (const run of [
    () => caller.getPublicTemplate({ projectId: 'contract' }),
    () => caller.getAvailableSlots({ projectId: 'contract', date: '2026-11-10' }),
    () => caller.getAvailableSlotsMultiDay({ projectId: 'contract', dates: ['2026-11-10'] }),
    () => caller.resolvePresetSlot({ projectId: 'contract', t: '202611101600' }),
    () => caller.verifyTenantUid({ projectId: 'contract', uid: 'owner-0' }),
    () => caller.verifyByPhone({ projectId: 'contract', phone: '0900000000' }),
    () => caller.registerTenantByPhone({ projectId: 'contract', phone: '0900000000', name: '合成租客', location: '合成地址', roomNumber: 'TEST-A' }),
    () => caller.confirmBooking(newBooking),
  ]) await assert.rejects(run, { code: 'FORBIDDEN' });
  assert.equal(queries.length, 0, 'retired new bookings stop before even opening the database');
  assert.equal(external.length, 0);

  for (const record of records) {
    const bookingContext = { bookingId: record.br_id, uid: record.br_tenantUid, datasetId: 'booking-fixture' };
    const info = await caller.getBookingForReschedule(bookingContext);
    assert.equal(info.projectId, 'contract');
    assert.equal(info.durationMinutes, 60);
    const owned = await caller.getPublicTemplate({ projectId: 'contract', bookingContext });
    assert.equal(owned.slotDurationMinutes, 60, 'old cards keep their original contract configuration');
    const single = await caller.getAvailableSlots({ projectId: 'contract', date: '2026-11-10', bookingContext });
    assert.ok(single.slots.some(s => s.available));
    assert.ok(single.slots.every(s => Date.parse(s.endTime) - Date.parse(s.startTime) === 60 * 60_000));
    const multi = await caller.getAvailableSlotsMultiDay({ projectId: 'contract', dates: ['2026-11-10'], bookingContext });
    assert.ok(multi.slotsByDate['2026-11-10'].length > 0);
  }
  for (const context of [
    { bookingId: 5, uid: 'wrong-owner', datasetId: 'booking-fixture' },
    { bookingId: 5, uid: 'owner-0', datasetId: 'old-dataset' },
    { bookingId: 5, uid: 'owner-0' },
    { bookingId: 999, uid: 'owner-0', datasetId: 'booking-fixture' },
  ]) {
    await assert.rejects(() => caller.getPublicTemplate({ projectId: 'contract', bookingContext: context }));
    await assert.rejects(() => caller.getAvailableSlots({ projectId: 'contract', date: '2026-11-10', bookingContext: context }));
    await assert.rejects(() => caller.rescheduleBooking({ ...newBooking, ...context, datasetId: context.datasetId }));
    await assert.rejects(() => caller.cancelBookingPublic(context));
  }
  await assert.rejects(() => caller.getPublicTemplate({ projectId: 'renewal', bookingContext: { bookingId: 5, uid: 'owner-0', datasetId: 'booking-fixture' } }), { code: 'FORBIDDEN' });
  assert.equal(external.length, 0, 'unauthorized actions never reach Ragic or LINE');
  assert.equal(queries.filter(q => q.text.startsWith('update')).length, 0);

  const result = await caller.rescheduleBooking({ ...newBooking, bookingId: 5, uid: 'owner-0' });
  assert.equal(result.success, true);
  assert.ok(external.some(r => r.url.includes('/go-back/1/99000?') && r.method === 'POST' && new URLSearchParams(r.body).get('1012114') === '2026/11/10 16:00'));
  assert.ok(queries.some(q => q.text.startsWith('update') && q.text.includes('"br_bookingTime"')));
  await caller.cancelBookingPublic({ bookingId: 5, uid: 'owner-0', datasetId: 'booking-fixture' });
  assert.ok(external.some(r => r.url.includes('/go-back/1/99000?') && r.method === 'DELETE'));
  assert.ok(queries.some(q => q.text.startsWith('update') && q.values.includes('cancelled')));
  assert.equal(queries.filter(q => q.text.startsWith('insert') || q.text.startsWith('delete')).length, 0, 'actions update the retained booking; never recreate or delete it');
  await new Promise(resolve => setImmediate(resolve));
});
