import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { forwardOldBooking, legacyDestination } from './legacyBookingForward';

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

test('GCP hands off old LIFF state once and leaves the final SPA and feedback routes alone', async t => {
  const app = express().use(forwardOldBooking).use((_req, res) => res.sendStatus(200));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const get = (path: string) => new Promise<IncomingMessage>((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port: address.port, path, headers: { Host: 'booking.oneplace.com.tw' } }, res => {
      res.resume();
      resolve(res);
    }).on('error', reject);
  });
  for (const type of ['renewal', 'checkout']) {
    for (const action of ['cancel', 'reschedule']) {
      const state = `?${action}=16&dataset=booking-20261028-one772`;
      const response = await get(`/book/${type}?code=discard&liff.state=${encodeURIComponent(state)}`);
      assert.equal(response.statusCode, 307);
      assert.equal(response.headers.location, `https://liff.line.me/2006833424-kPq8efDV?type=${type}&${state.slice(1)}`);
      assert.equal((await get(`/book/${type}${state}`)).statusCode, 200);
    }
  }
  assert.equal((await get('/f/123?r=help')).statusCode, 200);
});
