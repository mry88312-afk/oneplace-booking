import { TRPCError } from '@trpc/server';
import { acceptsNewBookings, CONTRACT_ENTRY_CLOSED } from '../../shared/bookingEntry';
import { loadOwnedBooking } from './ownedBooking';

export interface BookingActionContext {
  bookingId: number;
  uid: string;
  datasetId?: string;
}

export function assertNewBookingAllowed(projectId: string): void {
  if (!acceptsNewBookings(projectId))
    throw new TRPCError({ code: 'FORBIDDEN', message: CONTRACT_ENTRY_CLOSED });
}

export async function assertTemplateAccess(projectId: string, bookingContext?: BookingActionContext): Promise<void> {
  if (!bookingContext) return assertNewBookingAllowed(projectId);
  const { template } = await loadOwnedBooking(bookingContext.bookingId, bookingContext.uid, bookingContext.datasetId);
  if (template.projectId !== projectId)
    throw new TRPCError({ code: 'FORBIDDEN', message: '預約與專案不符，請重新從原確認卡開啟' });
}
