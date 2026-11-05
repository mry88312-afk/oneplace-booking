import { z } from 'zod';

export const remittanceReceiptSchema = z.object({
  submissionId: z.string().uuid(),
  receiptToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export const remittanceOwnerSchema = z.object({
  phone: z.string().regex(/^\d{8,15}$/),
  uid: z.string().min(1).max(100).optional(),
});
export const remittanceStatusSchema = z.object({
  status: z.enum(['pending', 'needs_review', 'ready']),
  virtualAccount: z.string().regex(/^\d{10,20}$/).optional(),
});
export type RemittanceReceipt = z.infer<typeof remittanceReceiptSchema>;
export type RemittanceStatus = z.infer<typeof remittanceStatusSchema>;
export type RemittanceOwner = z.infer<typeof remittanceOwnerSchema>;
