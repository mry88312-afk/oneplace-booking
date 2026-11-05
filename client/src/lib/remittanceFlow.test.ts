import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemittanceFlow } from './remittanceFlow';

const receipt = { submissionId: '11111111-1111-4111-8111-111111111111', receiptToken: 'b'.repeat(64) };
const token = 'a'.repeat(48);
const profile = { email: 'edited@example.invalid', job: 'Edited job' };
const account = '92564123456780';
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const calls: string[] = [];
  const api = {
    verify: async () => { calls.push('verify'); return { success: true, verifyToken: token }; },
    submit: async (t: string) => { assert.equal(t, token); calls.push('submit'); return { ...receipt, status: 'pending' as const }; },
    status: async () => { calls.push('status'); return { status: 'ready' as const, virtualAccount: account }; },
    complete: async (_r: typeof receipt, p: typeof profile) => { assert.deepEqual(p, profile); calls.push('complete'); return { virtualAccount: account }; },
  };
  return { storage, calls, api, values };
}
test('token-only verification proceeds to native intake; pending never completes', async () => {
  const f = fixture();
  const flow = createRemittanceFlow(f.storage, 'tenant', f.api);
  assert.deepEqual(await flow.advance('123456', profile), { status: 'pending' });
  assert.deepEqual(f.calls, ['verify', 'submit']);
  assert.equal(JSON.stringify([...f.values.values()]).includes('123456'), false);
});
test('reload polls receipt and retains edited profile without verifying/submitting again', async () => {
  const f = fixture();
  await createRemittanceFlow(f.storage, 'tenant', f.api).advance('123456', profile);
  const resumed = createRemittanceFlow(f.storage, 'tenant', f.api);
  assert.equal(resumed.hasSaved(), true);
  assert.deepEqual(await resumed.advance('', { email: '', job: '' }), { status: 'done', virtualAccount: account });
  assert.deepEqual(f.calls, ['verify', 'submit', 'status', 'complete']);
  assert.equal(createRemittanceFlow(f.storage, 'another-tenant', f.api).hasSaved(), false);
});
test('lost submission response reuses the same token after reload', async () => {
  const f = fixture();
  let attempts = 0;
  const submit = f.api.submit;
  f.api.submit = async t => { assert.equal(t, token); if (++attempts === 1) throw new Error('network'); return submit(t); };
  await assert.rejects(createRemittanceFlow(f.storage, 'tenant', f.api).advance('123456', profile), /network/);
  await createRemittanceFlow(f.storage, 'tenant', f.api).advance('', profile);
  assert.deepEqual(f.calls, ['verify', 'submit']);
});
test('double click shares one operation and failed completion resumes receipt', async () => {
  const f = fixture();
  const flow = createRemittanceFlow(f.storage, 'tenant', f.api);
  await Promise.all([flow.advance('123456', profile), flow.advance('123456', profile)]);
  assert.deepEqual(f.calls, ['verify', 'submit']);
  f.api.complete = async () => { throw new Error('save unavailable'); };
  await assert.rejects(flow.advance('', profile), /save unavailable/);
  assert.deepEqual(f.calls, ['verify', 'submit', 'status']);
});
test('storage failure blocks intake and review never completes', async () => {
  const f = fixture();
  await assert.rejects(createRemittanceFlow({ getItem: () => null, setItem: () => { throw new Error('blocked'); } }, 'tenant', f.api).advance('123456', profile), /無法保存/);
  assert.deepEqual(f.calls, ['verify']);
  const reviewAPI = { ...f.api, submit: async () => ({ ...receipt, status: 'needs_review' as const }) };
  assert.deepEqual(await createRemittanceFlow(f.storage, 'tenant', reviewAPI).advance('123456', profile), { status: 'needs_review' });
  assert.equal(f.calls.includes('complete'), false);
});

test('only a rejected verification without a receipt can be discarded', async () => {
  const f = fixture();
  const flow = createRemittanceFlow(f.storage, 'tenant', { ...f.api, submit: async () => { throw new Error('unauthorized'); } });
  await assert.rejects(flow.advance('123456', profile));
  assert.equal(flow.forgetRejectedVerification(), true);
  assert.equal(flow.hasSaved(), false);
  const accepted = createRemittanceFlow(f.storage, 'tenant', f.api);
  await accepted.advance('123456', profile);
  assert.equal(accepted.forgetRejectedVerification(), false);
  assert.equal(accepted.hasSaved(), true);
});
