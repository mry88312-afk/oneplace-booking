import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import * as schema from '../../drizzle/schema';
import { assertBookingDataset } from './runtime';

/** Shared by existing-card actions and their private template/slot queries. */
export async function loadOwnedBooking(bookingId: number, uid: string, datasetId?: string) {
  assertBookingDataset(datasetId);
  const db = await getDb();
  if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
  const [record] = await db.select().from(schema.bookingRecords).where(eq(schema.bookingRecords.id, bookingId));
  if (!record) throw new TRPCError({ code: 'NOT_FOUND', message: '找不到這筆預約' });
  if (!uid || !record.tenantUid || record.tenantUid !== uid)
    throw new TRPCError({ code: 'FORBIDDEN', message: '無權限操作這筆預約' });
  const [template] = await db.select().from(schema.bookingTemplates).where(eq(schema.bookingTemplates.id, record.templateId));
  if (!template) throw new TRPCError({ code: 'NOT_FOUND', message: '預約模版不存在' });
  return { db, record, template };
}
