import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingEntryParams, bookingLoginRedirect } from './bookingEntry';
for (const project of ['renewal', 'checkout']) {
  test(`${project} 保留直接與 LIFF 巢狀來源`, () => {
    for (const search of ['?src=d60', '?liff.state=' + encodeURIComponent('/?src=d30')]) {
      const params = bookingEntryParams(search);
      const result = new URL(bookingLoginRedirect('https://booking.oneplace.com.tw', project, params));
      assert.equal(result.searchParams.get('src'), params.get('src'));
      assert.equal(result.pathname, '/book/' + project);
    }
  });
}
test('拒絕不合法來源並保留改期參數', () => {
  const result = new URL(bookingLoginRedirect('https://booking.oneplace.com.tw', 'renewal', new URLSearchParams({src: '<bad>', reschedule: '123', dataset: 'live'})));
  assert.equal(result.searchParams.has('src'), false);
  assert.equal(result.searchParams.get('reschedule'), '123');
  assert.equal(result.searchParams.get('dataset'), 'live');
});
