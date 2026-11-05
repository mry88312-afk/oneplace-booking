import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenewalRemittance } from './remittance';

const phone = '0912345678';
const uid = 'Ufixture';
const verifyToken = 'a'.repeat(48);
const receipt = { submissionId: '11111111-1111-4111-8111-111111111111', receiptToken: 'b'.repeat(64) };
const tenant = { _ragicId: 42, '1007372': phone, '1007383': uid, '1007373': 'Fixture', '1007374': 'TEST-ID', '1007542': 'test@example.invalid', '1007377': 'Test', '1021087': '92564123456780' };

function fixture(reply: Record<string, unknown> = { success: true, status: 'pending', ...receipt }, status = 202) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const writes: unknown[] = [];
  const source: Record<string, unknown> = { ...tenant };
  const service = createRenewalRemittance({
    readTenant: async () => ({ 42: source }),
    writeTenant: async (id, fields) => { writes.push({ id, fields }); Object.assign(source, fields); },
    request: async (path, init) => { calls.push({ path, init }); return new Response(JSON.stringify(reply), { status }); },
  });
  return { service, calls, writes };
}

test('new verification token submits canonical tenant once without exposing identity fields', async () => {
  const { service, calls, writes } = fixture();
  const result = await service.submit({ phone, uid, verifyToken });
  assert.deepEqual(result, { status: 'pending', ...receipt });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/submit');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.idNumber, 'TEST-ID');
  assert.equal(body.verifyToken, verifyToken);
  assert.equal(body.name, 'Fixture');
  assert.equal(JSON.stringify(result).includes('TEST-ID'), false);
  assert.equal(writes.length, 0);
});

test('pending response never releases a premature account', async () => {
  const { service } = fixture({ success: true, status: 'pending', ...receipt, virtualAccount: 'unconfirmed' });
  assert.equal('virtualAccount' in await service.submit({ phone, uid, verifyToken }), false);
});

test('status lookup uses receipt authorization and rejects account for another phone', async () => {
  const { service, calls } = fixture({ success: true, status: 'ready', ...receipt, phone: '0999999999', virtualAccount: '92564123456780' }, 200);
  await assert.rejects(service.status({ ...receipt, phone }), /手機資料不符/);
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), `Bearer ${receipt.receiptToken}`);
});

test('only ready receipt can save optional renewal profile, never name or ID', async () => {
  const { service, writes } = fixture({ success: true, status: 'ready', ...receipt, phone, virtualAccount: '92564123456780' }, 200);
  assert.deepEqual(await service.complete({ ...receipt, phone, uid, email: 'new@example.invalid', job: 'New job' }), { virtualAccount: '92564123456780' });
  assert.deepEqual(writes, [{ id: 42, fields: { '1021087': '92564123456780', '1007542': 'new@example.invalid', '1007377': 'New job' } }]);
  await service.complete({ ...receipt, phone, uid, email: 'new@example.invalid', job: 'New job' });
  assert.equal(writes.length, 1, 'lost completion response must not write the same profile again');
  const pending = fixture();
  await assert.rejects(pending.service.complete({ ...receipt, phone, uid }), /尚未/);
  assert.equal(pending.writes.length, 0);
});

test('a rejected or unconfirmed profile write never reports completion', async () => {
  const service = createRenewalRemittance({
    readTenant: async () => ({ 42: tenant }),
    writeTenant: async () => ({ status: 'SUCCESS' }),
    request: async () => new Response(JSON.stringify({ success: true, status: 'ready', ...receipt, phone, virtualAccount: '92564123456780' })),
  });
  await assert.rejects(service.complete({ ...receipt, phone, uid, email: 'not-persisted@example.invalid' }), /儲存尚未確認/);
});

test('identity mismatch and multiple matches stop before deposit submission', async () => {
  const f = fixture();
  await assert.rejects(f.service.submit({ phone, uid: 'Uother', verifyToken }), /身份不符/);
  assert.equal(f.calls.length, 0);
  const service = createRenewalRemittance({ readTenant: async () => [tenant, tenant], writeTenant: async () => {}, request: async () => { throw new Error('must not call'); } });
  await assert.rejects(service.submit({ phone, uid, verifyToken }), /多筆/);
});

test('missing existing native required data stops explicitly, without inventing identity data', async () => {
  const service = createRenewalRemittance({ readTenant: async () => ({ 42: { ...tenant, '1007374': '' } }), writeTenant: async () => {}, request: async () => { throw new Error('must not call'); } });
  await assert.rejects(service.submit({ phone, uid, verifyToken }), /既有租客資料不完整/);
});

test('upstream errors and malformed success never leak body or look completed', async () => {
  for (const [status, body] of [[401, { success: false, message: 'secret' }], [503, { secret: 'private SQL' }], [202, { success: true, message: '驗證成功' }]] as const) {
    const { service } = fixture(body, status);
    await assert.rejects(service.submit({ phone, uid, verifyToken }), error => error instanceof Error && !/secret|private SQL|驗證成功/.test(error.message));
  }
});
