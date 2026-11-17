import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ragicGet } from '../routers/property/bookingHelpers';
import { verificationFetch } from '../../client/src/lib/verificationFetch';

test('外部一直不回應時，兩次讀取都會取消且最後結束', async t => {
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      cancelled++;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }));
  await assert.rejects(ragicGet('for-system-use/2'), /資料查詢暫時無法完成/);
  assert.equal(cancelled, 2);
});

test('前端查詢十秒無回應後取消並提供可重試訊息，忽略晚到結果', async () => {
  let signal: AbortSignal | undefined;
  const response = await verificationFetch(s => {
    signal = s;
    return new Promise(() => {});
  });
  assert.equal(signal?.aborted, true);
  assert.equal(response.status, 408);
  assert.match(await response.text(), /系統忙碌，請稍後重試/);
});

test('Ragic 讀取必須傳入取消訊號且使用欄位 ID', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(init.signal, '外部無回應時必須能取消請求');
    assert.equal(new URL(url).searchParams.get('naming'), 'EID');
    return new Response('{}');
  });
  assert.deepEqual(await ragicGet('for-system-use/2'), {});
});

test('暫時性錯誤只重試一次，永久拒絕不重試', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: calls === 1 ? 503 : 200 });
  });
  assert.deepEqual(await ragicGet('for-system-use/2'), {});
  assert.equal(calls, 2);
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: 403 });
  });
  await assert.rejects(ragicGet('for-system-use/2'));
  assert.equal(calls, 1);
});
