import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, closeDb } from '../server/db/connection';
import { bookingRecords, bookingSubmissionAttempts } from '../drizzle/schema';
import { createSubmissionStore } from '../server/booking/submissionStore';
import { submissionIdentity, submitBookingOnce } from '../server/booking/submission';

/** Explicit opt-in integration test, only this run's fixtures are cleaned up. No external APIs. */
export async function verifyBookingDatabase() {
  assert.equal(process.env.BOOKING_DATASET_ID, 'booking-20261028-one772');
  const db = await getDb();
  assert.ok(db, 'database connection required');
  const uid = `ONE772-test-${randomUUID()}`;
  const record = { templateId: 1, tenantUid: uid, tenantName: 'ONE-772 disposable test', roomNumber: 'TEST-ONLY', bookingTime: Date.UTC(2030, 0, 1), durationMinutes: 60, googleCalendarId: 'fixture-calendar' };
  const store = createSubmissionStore(db, { bookingTime: record.bookingTime, calendarId: record.googleCalendarId });
  const keys: string[] = [];
  const identity = () => { const id = submissionIdentity(uid, randomUUID(), record); keys.push(id.key); return id; };
  let fakeExternalCalls = 0;
  const createTask = async () => { fakeExternalCalls++; return '772000000'; };
  const uploadAttachments = async () => {};
  try {
    const first = identity();
    const options = { ...first, store, record, createTask, uploadAttachments };
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => submitBookingOnce(options)));
    assert.equal(fakeExternalCalls, 1, 'twenty concurrent submissions must create one external task');
    assert.equal(concurrent.filter(r => r.fresh).length, 1);
    const replay = await submitBookingOnce(options);
    assert.ok(replay.success);
    assert.equal(replay.fresh, false);
    assert.equal((await store.reserve(first.key, 'changed-payload')).kind, 'conflict');
    await store.markPending(first.key, 'ambiguous_commit');
    assert.equal((await store.reserve(first.key, first.payloadHash)).kind, 'completed');
    await db.update(bookingRecords).set({ bookingTime: record.bookingTime + 3600000 }).where(eq(bookingRecords.tenantUid, uid));
    assert.equal((await store.reserve(first.key, first.payloadHash)).kind, 'pending');
    await db.update(bookingRecords).set({ bookingTime: record.bookingTime, status: 'cancelled' }).where(eq(bookingRecords.tenantUid, uid));
    assert.equal((await store.reserve(first.key, first.payloadHash)).kind, 'pending');

    const failed = identity();
    assert.equal((await store.reserve(failed.key, failed.payloadHash)).kind, 'owner');
    await store.recordRagic(failed.key, '772000001');
    await assert.rejects(store.complete(failed.key, { ...record, ragicRecordId: '772000001', durationMinutes: Number.NaN }));
    const [failedRow] = await db.select().from(bookingSubmissionAttempts).where(eq(bookingSubmissionAttempts.requestKey, failed.key));
    assert.equal(failedRow.state, 'ragic_written', 'failed insert must roll back atomically');
    assert.equal(failedRow.bookingId, null);
    await store.markPending(failed.key, 'save_booking');
    assert.equal((await store.reserve(failed.key, failed.payloadHash)).kind, 'pending');
    await assert.rejects(store.recordRagic(failed.key, '772000002'));

    const ambiguous = identity();
    const lostAckStore = { ...store, complete: async (...args: Parameters<typeof store.complete>) => { await store.complete(...args); throw new Error('simulated lost COMMIT acknowledgment'); } };
    const lost = await submitBookingOnce({ ...ambiguous, store: lostAckStore, record, createTask, uploadAttachments });
    assert.equal(lost.success, false);
    const recovered = await submitBookingOnce({ ...ambiguous, store, record, createTask, uploadAttachments });
    assert.equal(recovered.success, true);
    assert.equal(recovered.fresh, false);
    assert.equal(fakeExternalCalls, 2);
    const failedExternal = identity();
    const pending = await submitBookingOnce({ ...failedExternal, store, record, createTask: async () => { throw new Error('simulated external timeout'); }, uploadAttachments });
    assert.equal(pending.success, false);
    assert.equal((await store.reserve(failedExternal.key, failedExternal.payloadHash)).kind, 'pending');

    const access = await db.execute(sql`SELECT current_user AS role, has_schema_privilege(current_user,'finance','USAGE') AS finance, has_schema_privilege('anon','booking','USAGE') AS anon, has_schema_privilege('authenticated','booking','USAGE') AS authenticated`);
    assert.deepEqual(access.rows[0], { role: 'oneplace_booking', finance: false, anon: false, authenticated: false });
    const fixtureCount = await db.select().from(bookingRecords).where(eq(bookingRecords.tenantUid, uid));
    assert.equal(fixtureCount.length, 2);
    console.log(JSON.stringify({ concurrentSubmissions: 20, fakeExternalTasksForSameRequest: 1, replay: 'passed', changedPayload: 'blocked', changedOrCancelledBooking: 'blocked', rollback: 'passed', ambiguousCommit: 'recovered without duplicate', externalTimeout: 'pending', permissions: 'passed', realExternalWrites: 0 }));
  } finally {
    await db.transaction(async tx => {
      if (keys.length) await tx.delete(bookingSubmissionAttempts).where(inArray(bookingSubmissionAttempts.requestKey, keys));
      await tx.delete(bookingRecords).where(eq(bookingRecords.tenantUid, uid));
    });
    assert.equal((await db.select().from(bookingRecords).where(eq(bookingRecords.tenantUid, uid))).length, 0);
    assert.equal((await db.select().from(bookingSubmissionAttempts).where(inArray(bookingSubmissionAttempts.requestKey, keys))).length, 0);
    console.log(JSON.stringify({ fixtureCleanup: 'verified', testUid: uid }));
    await closeDb();
  }
}
