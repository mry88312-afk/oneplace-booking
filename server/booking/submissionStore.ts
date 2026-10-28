import { and, eq, inArray } from "drizzle-orm";
import { bookingRecords, bookingSubmissionAttempts } from "../../drizzle/schema";
import type { getDb } from "../db";
import { errorCode } from "../../shared/bookingErrors";
import type { SubmissionStore } from "./submission";

export function createSubmissionStore(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  expected: { bookingTime: number; calendarId: string },
): SubmissionStore {
  const attempts = bookingSubmissionAttempts;
  return {
    async reserve(key, payloadHash) {
      try {
        await db.insert(attempts).values({ requestKey: key, payloadHash, state: "processing" });
        return { kind: "owner" };
      } catch (error) {
        if (errorCode(error) !== "ER_DUP_ENTRY") throw error;
      }
      const [row] = await db.select().from(attempts).where(eq(attempts.requestKey, key)).limit(1);
      if (!row) throw new Error("Reservation unavailable");
      if (row.payloadHash !== payloadHash) return { kind: "conflict" };
      if (row.state === "completed" && row.bookingId && row.ragicRecordId) {
        const [booking] = await db.select({
          status: bookingRecords.status, ragicId: bookingRecords.ragicRecordId,
          bookingTime: bookingRecords.bookingTime, calendarId: bookingRecords.googleCalendarId,
        })
          .from(bookingRecords).where(eq(bookingRecords.id, row.bookingId)).limit(1);
        // A cancelled, deleted or rescheduled booking must not replay an obsolete confirmation.
        if (!booking || booking.status !== "confirmed" || booking.ragicId !== row.ragicRecordId
          || booking.bookingTime !== expected.bookingTime || booking.calendarId !== expected.calendarId) return { kind: "pending" };
        return { kind: "completed", result: { success: true, status: "confirmed", bookingId: row.bookingId, ragicRecordId: row.ragicRecordId } };
      }
      return { kind: "pending" };
    },
    async recordRagic(key, ragicId) {
      const [result] = await db.update(attempts).set({ ragicRecordId: ragicId, state: "ragic_written" })
        .where(and(eq(attempts.requestKey, key), eq(attempts.state, "processing")));
      if (result.affectedRows !== 1) throw new Error("Reservation no longer owned");
    },
    async complete(key, record) {
      return db.transaction(async tx => {
        const [row] = await tx.select().from(attempts).where(eq(attempts.requestKey, key)).for("update");
        if (!row || !row.ragicRecordId || row.state !== "ragic_written" || row.ragicRecordId !== record.ragicRecordId) {
          throw new Error("Reservation no longer owned");
        }
        const [saved] = await tx.insert(bookingRecords).values(record);
        if (!saved.insertId) throw new Error("Missing booking receipt");
        await tx.update(attempts).set({ state: "completed", bookingId: saved.insertId })
          .where(eq(attempts.requestKey, key));
        return { success: true, status: "confirmed", bookingId: saved.insertId, ragicRecordId: row.ragicRecordId };
      });
    },
    async markPending(key, stage) {
      // Do not overwrite a committed completion after an ambiguous COMMIT acknowledgement.
      await db.update(attempts).set({ state: "needs_review", failureStage: stage })
        .where(and(eq(attempts.requestKey, key), inArray(attempts.state, ["processing", "ragic_written"])));
    },
  };
}
