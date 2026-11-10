import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyDestination } from './legacyBookingForward';

test('old LINE card keeps the action, dataset and booking type without carrying a login code', () => {
  const url = new URL(legacyDestination('/book/checkout', '?code=discard&liff.state=' + encodeURIComponent('/book/checkout?cancel=16&dataset=live')));
  assert.equal(url.hostname, 'liff.line.me');
  assert.equal(url.search, '?type=checkout&cancel=16&dataset=live');
});
test('old renewal preset, back office and feedback links retain their purpose', () => {
  assert.match(legacyDestination('/book/renewal', '?t=202611121500'), /type=renewal&t=202611121500$/);
  assert.equal(legacyDestination('/', ''), 'https://booking.oneplace.com.tw/admin');
  assert.equal(legacyDestination('/f/123', '?r=help'), 'https://booking.oneplace.com.tw/f/123?r=help');
  assert.equal(new URL(legacyDestination('//thirdparty.invalid/path', '')).host, 'booking.oneplace.com.tw');
});
