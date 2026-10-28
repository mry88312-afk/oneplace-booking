import { TRPCError } from '@trpc/server';
import { BOOKING_UNAVAILABLE } from '../../shared/bookingErrors';

export const LEGACY_BOOKING = '這是舊資料庫的預約連結，請聯繫小幫手依 Ragic 紀錄協助取消或改期。';

export function bookingDatasetId(): string | null {
  const value = process.env.BOOKING_DATASET_ID?.trim();
  return value && /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : null;
}

export function bookingWritesEnabled() {
  return process.env.BOOKING_WRITES_ENABLED === 'true' && bookingDatasetId() !== null;
}

export function assertBookingWritesEnabled() {
  if (!bookingWritesEnabled()) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: BOOKING_UNAVAILABLE });
}

export function assertBookingDataset(datasetId?: string) {
  const current = bookingDatasetId();
  if (!current || datasetId !== current) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LEGACY_BOOKING });
}

export function bookingActionUrl(liffId: string, action: 'cancel' | 'reschedule', bookingId: number) {
  const dataset = bookingDatasetId();
  if (!dataset) throw new Error('Booking dataset not configured');
  const url = new URL(`https://liff.line.me/${liffId}`);
  url.searchParams.set(action, String(bookingId));
  url.searchParams.set('dataset', dataset);
  return url.toString();
}
