import { TRPCError } from '@trpc/server';
import { remittanceReceiptSchema, remittanceStatusSchema, type RemittanceOwner, type RemittanceReceipt, type RemittanceStatus } from '../../shared/remittance';

type Dependencies = {
  readTenant: (phone: string) => Promise<unknown>;
  writeTenant: (id: number, fields: Record<string, string>) => Promise<unknown>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const fail = (message: string, code: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT' | 'SERVICE_UNAVAILABLE' | 'UNAUTHORIZED' = 'SERVICE_UNAVAILABLE'): never => { throw new TRPCError({ code, message }); };

/** Native deposit owns account creation, durable deduplication and notifications.
 * Only its ready receipt authorizes the existing renewal profile update. */
export function createRenewalRemittance(deps: Dependencies) {
  async function tenant(input: RemittanceOwner) {
    const raw = await deps.readTenant(input.phone);
    const root = object(raw);
    const values = Array.isArray(raw) ? raw : root._ragicId !== undefined ? [root] : Object.values(root);
    const rows = values.map(object).filter(r => r._ragicId !== undefined);
    if (rows.length > 1) fail('同一手機有多筆租客資料，請聯絡服務人員確認', 'CONFLICT');
    const row = rows[0];
    if (!row || text(row['1007372']) !== input.phone) fail('查無對應租客資料，請聯絡服務人員', 'BAD_REQUEST');
    if (input.uid && text(row['1007383']) && text(row['1007383']) !== input.uid) fail('身份不符，無法設定帳號', 'FORBIDDEN');
    const id = Number(row._ragicId);
    if (!Number.isSafeInteger(id) || id < 0) fail('租客資料異常，請聯絡服務人員');
    return { row, id };
  }
  async function request(path: string, init: RequestInit) {
    let response: Response;
    try { response = await deps.request(path, init); }
    catch { return fail('暫時無法確認處理結果，請使用原資料重試，勿重新送件'); }
    if (!response.ok) {
      if (response.status === 401) fail('手機驗證已失效，請重新驗證', 'UNAUTHORIZED');
      if (response.status === 404) fail('無法確認收件憑證，請聯絡服務人員，勿重新送件', 'CONFLICT');
      if (response.status === 409) fail('帳號資料需要服務人員確認，請勿重新送件', 'CONFLICT');
      if (response.status === 400) fail('既有租客資料不完整，請聯絡服務人員確認', 'BAD_REQUEST');
      fail('帳號服務暫時無法確認結果，請稍後使用原資料重試');
    }
    let data: Record<string, unknown>;
    try { data = object(await response.json()); }
    catch { return fail('帳號服務回應不完整，請稍後重試'); }
    if (data.success !== true) fail('帳號服務尚未確認成功，請稍後重試');
    return data;
  }
  function present(data: Record<string, unknown>, phone: string): RemittanceStatus {
    // Deliberately discard any account attached to pending/review responses.
    const parsed = remittanceStatusSchema.safeParse({ status: data.status, ...(data.status === 'ready' ? { virtualAccount: data.virtualAccount } : {}) });
    if (!parsed.success) return fail('帳號服務回應不完整，請稍後重試');
    if (parsed.data.status === 'ready') {
      if (data.phone !== phone) fail('收件手機資料不符，請聯絡服務人員', 'FORBIDDEN');
      if (!parsed.data.virtualAccount) fail('帳號尚未確認可用，請稍後重試');
    }
    return parsed.data;
  }
  async function status(input: RemittanceReceipt & { phone: string }) {
    const data = await request(`/submissions/${encodeURIComponent(input.submissionId)}`, { headers: { Authorization: `Bearer ${input.receiptToken}` }, cache: 'no-store' });
    if (data.submissionId !== input.submissionId) fail('收件資料不符，請聯絡服務人員', 'FORBIDDEN');
    return present(data, input.phone);
  }
  return {
    async submit(input: RemittanceOwner & { verifyToken: string }) {
      const { row } = await tenant(input);
      // Keep the native payload identical to the source. Renewal profile edits are
      // saved only after ready, as before. Never invent or expose an ID number.
      const fields = { name: '1007373', idNumber: '1007374', email: '1007542', job: '1007377' };
      const profile = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, text(row[id])]));
      if (Object.values(profile).some(value => !value || value.length > 200)) fail('既有租客資料不完整，請聯絡服務人員補齊後再試', 'BAD_REQUEST');
      const franchise = text(row['1023001']);
      const data = await request('/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, phone: input.phone, uid: text(row['1007383']), franchiseId: /^fellow-\d+$/.test(franchise) ? franchise : null, verifyToken: input.verifyToken }),
      });
      const receipt = remittanceReceiptSchema.safeParse(data);
      if (!receipt.success) return fail('尚未取得完整收件憑證，請使用原資料重試');
      return { ...present(data, input.phone), ...receipt.data };
    },
    status,
    async complete(input: RemittanceReceipt & RemittanceOwner & { email?: string; job?: string }) {
      const state = await status(input);
      if (state.status !== 'ready' || !state.virtualAccount) return fail('帳號尚未確認可用，請稍後再試', 'CONFLICT');
      const { row, id } = await tenant(input);
      if (text(row['1021087']) && text(row['1021087']) !== state.virtualAccount) fail('租客帳號資料不同，請聯絡服務人員確認', 'CONFLICT');
      const fields: Record<string, string> = { '1021087': state.virtualAccount };
      if (input.email?.trim()) fields['1007542'] = input.email.trim();
      if (input.job?.trim()) fields['1007377'] = input.job.trim();
      // Read first: a repeated completion after a lost response causes no new write.
      if (Object.entries(fields).some(([key, value]) => text(row[key]) !== value)) {
        await deps.writeTenant(id, fields);
        const check = await tenant(input);
        if (Object.entries(fields).some(([key, value]) => text(check.row[key]) !== value)) fail('資料儲存尚未確認，請稍後重試');
      }
      return { virtualAccount: state.virtualAccount };
    },
  };
}

export async function bookingLinePrincipal(cookieHeader?: string) {
  const bridge = process.env.BOOKING_REMITTANCE_BRIDGE;
  if (!bridge) return fail('未啟用 LINE 續約驗證', 'FORBIDDEN');
  const matches = (cookieHeader || '').split(';').map(value => value.trim())
    .filter(value => /^__Host-booking_line=[0-9a-f]{64}$/.test(value));
  if (matches.length !== 1) return fail('請重新從 LINE 開啟預約', 'UNAUTHORIZED');
  const cookie = matches[0];
  const result = await fetch(bridge + '/principal', {
    headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const uid = result.headers.get('X-Booking-Subject') || '';
  if (!result.ok || !/^U[0-9a-f]{32}$/i.test(uid)) return fail('LINE 身分驗證已過期', 'UNAUTHORIZED');
  return { cookie, uid };
}

export async function renewalRemittanceService(cookieHeader?: string) {
  const bridge = process.env.BOOKING_REMITTANCE_BRIDGE;
  const { cookie, uid: verifiedUid } = bridge ? await bookingLinePrincipal(cookieHeader) : { cookie: '', uid: '' };
  const { ragicGet, ragicPut } = await import('../routers/property/bookingHelpers');
  const service = createRenewalRemittance({
    readTenant: phone => ragicGet('for-system-use/2', { where: `1007372,eq,${phone}`, limit: '2', naming: 'EID' }),
    writeTenant: (id, fields) => ragicPut('for-system-use/2', id, fields),
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      if (bridge) headers.set('Cookie', cookie);
      return fetch((bridge || 'https://deposit.zeabur.app') + '/api' + path, {
        ...init, headers, redirect: 'error', signal: AbortSignal.timeout(25000),
      });
    },
  });
  if (!bridge) return service;
  return {
    submit: (input: Parameters<typeof service.submit>[0]) => service.submit({ ...input, uid: verifiedUid }),
    status: service.status,
    complete: (input: Parameters<typeof service.complete>[0]) => service.complete({ ...input, uid: verifiedUid }),
  };
}
