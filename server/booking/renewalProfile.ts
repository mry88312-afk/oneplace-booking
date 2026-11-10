import { TRPCError } from '@trpc/server';
import { z } from 'zod';

export const renewalProfileChanges = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
  job: z.string().trim().min(1).max(200).optional(),
}).strict();

export const bindingHelp = '這個 LINE 帳號尚未綁定租客資料，請聯絡客服協助綁定。';

export function usesLineRenewal(projectId: string) {
  return projectId === 'renewal' && Boolean(process.env.BOOKING_REMITTANCE_BRIDGE);
}

type TenantStore = {
  lookup: (uid: string) => Promise<unknown>;
  update: (id: number, fields: Record<string, string>) => Promise<unknown>;
};

export function createRenewalProfile(store: TenantStore) {
  async function tenant(uid: string) {
    const raw = await store.lookup(uid);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '暫時無法讀取租客資料，請稍後重試。' });
    }
    const records = Object.values(raw).filter((v): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v) && v['1007383'] === uid);
    if (!records.length) throw new TRPCError({ code: 'FORBIDDEN', message: bindingHelp });
    const row = records[0];
    const id = Number(row._ragicId);
    if (records.length !== 1 || !/^\d+$/.test(String(row._ragicId)) || !Number.isSafeInteger(id)) {
      throw new TRPCError({ code: 'CONFLICT', message: '租客資料需要客服協助確認。' });
    }
    return { row, id };
  }

  return {
    async save(uid: string, changes: z.infer<typeof renewalProfileChanges>) {
      const { row, id } = await tenant(uid);
      const fields: Record<string, string> = {};
      const keys = { name: '1007373', email: '1007542', job: '1007377' } as const;
      for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
        const value = changes[key];
        if (value !== undefined && String(row[keys[key]] ?? '').trim() !== value) fields[keys[key]] = value;
      }
      if (!(fields[keys.job] || String(row[keys.job] ?? '').trim())) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '請填寫職業' });
      }
      if (Object.keys(fields).length) {
        await store.update(id, fields);
        const check = await tenant(uid);
        if (check.id !== id || Object.entries(fields).some(([field, value]) => String(check.row[field] ?? '').trim() !== value)) {
          throw new TRPCError({ code: 'CONFLICT', message: '資料儲存尚未確認，請重試。' });
        }
      }
    },
    async existingAccount(uid: string) {
      const { row } = await tenant(uid);
      const account = String(row['1021087'] ?? '').trim();
      return /^\d{10,20}$/.test(account) ? account : undefined;
    },
  };
}

export async function renewalProfileStore() {
  const { ragicGet, ragicPut } = await import('../routers/property/bookingHelpers');
  return createRenewalProfile({
    lookup: uid => ragicGet('for-system-use/2', { where: `1007383,eq,${uid}`, limit: '2', naming: 'EID' }),
    update: (id, fields) => ragicPut('for-system-use/2', id, fields),
  });
}
