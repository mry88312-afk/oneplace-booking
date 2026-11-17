import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenewalProfile, renewalProfileChanges } from './renewalProfile';

const uid = 'U' + 'a'.repeat(32);
function fixture(row: Record<string, unknown>, duplicate = false) {
  const writes: Record<string, string>[] = [];
  const profile = createRenewalProfile({
    lookup: async subject => {
      assert.equal(subject, uid);
      return duplicate ? { '1': row, '2': { ...row, _ragicId: 2 } } : { '1': row };
    },
    update: async (id, fields) => {
      assert.equal(id, 1);
      writes.push(fields);
      Object.assign(row, fields);
    },
  });
  return { profile, writes };
}

test('bound tenant without an account can save just the job; retry performs no second write', async () => {
  const { profile, writes } = fixture({ _ragicId: 1, '1007383': uid, '1007377': '', '1007542': 'original@example.org' });
  await assert.rejects(profile.save(uid, {}), /請填寫職業/);
  await profile.save(uid, { job: '工程師' });
  await profile.save(uid, { job: '工程師' });
  assert.deepEqual(writes, [{ '1007377': '工程師' }]);
  assert.equal(await profile.existingAccount(uid), undefined);
});
test('only the bound account already stored on the tenant row can appear on a card', async () => {
  const { profile, writes } = fixture({ _ragicId: 1, '1007383': uid, '1007377': '工程師', '1021087': '01234567890123' });
  await profile.save(uid, {});
  assert.deepEqual(writes, []);
  assert.equal(await profile.existingAccount(uid), '01234567890123');
  assert.equal(renewalProfileChanges.safeParse({ uid, virtualAccount: '1111111111' }).success, false);
});
test('wrong or ambiguous binding blocks profile writes and account lookup', async () => {
  for (const subject of ['', 'U' + 'b'.repeat(32), uid]) {
    const { profile, writes } = fixture({ _ragicId: 1, '1007383': subject }, subject === uid);
    await assert.rejects(profile.save(uid, { job: '測試' }), /客服/);
    await assert.rejects(profile.existingAccount(uid), /客服/);
    assert.deepEqual(writes, []);
  }
});
