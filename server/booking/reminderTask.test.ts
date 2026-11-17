import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderTaskExists } from './reminderTask';

test('有效任務通過且以欄位 ID 查詢', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(new URL(url).searchParams.get('naming'), 'EID');
    return Response.json({ _ragicId: 1046 });
  });
  assert.equal(await reminderTaskExists('go-back/1', '1046'), true);
});
test('不存在的任務需同表正向對照才略過', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls === 1 ? {} : { '1053': { _ragicId: 1053 } }));
  assert.equal(await reminderTaskExists('go-back/1', '1046'), false);
  assert.equal(calls, 2);
});
test('明確 404 可略過', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.equal(await reminderTaskExists('go-back/1', '1046'), false);
});
test('空表與權限不明不可視為已刪除', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(reminderTaskExists('go-back/1', '1046'), /權限無法確認/);
});
for (const status of [403, 503]) test(`查詢 ${status} 保留失敗且不誤判刪除`, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
  await assert.rejects(reminderTaskExists('go-back/1', '1046'));
});
for (const payload of [{ status: 'ERROR' }, { _ragicId: 99 }, []]) test(`異常內容 ${JSON.stringify(payload)} 保留待查`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  await assert.rejects(reminderTaskExists('go-back/1', '1046'), /無法確認/);
});
