import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const base = process.argv[2];
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(base || ''), 'Only an explicit loopback trial tunnel is accepted');
const health = await fetch(`${base}/healthz`).then(r => r.json());
assert.equal(health.migrationTrial, true, 'Never run negative probes against production');
const query = async (origin: string, path: string, input: unknown) => {
  const result = await fetch(`${origin}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`);
  assert.equal(result.status, 200, path);
  return (await result.json()).result.data.json;
};
const comparisons: Array<{ projectId: string; templateMatches: boolean; sevenDayAvailabilityMatches: boolean; oldWritesEnabled: boolean }> = [];
for (const projectId of ['renewal', 'checkout']) {
  const current = await query('https://oneplace-booking.zeabur.app', 'booking.getPublicTemplate', { projectId });
  const trial = await query(base, 'booking.getPublicTemplate', { projectId });
  assert.equal(trial.migrationTrial, true);
  assert.equal(trial.writesEnabled, false);
  assert.equal(trial.liffId, null);
  for (const key of ['datasetId', 'name', 'slotDurationMinutes', 'bookableDaysAhead', 'fields', 'routingDays']) assert.deepEqual(trial[key], current[key], key);
  const dates = [1,2,3,4,5,6,7].map(offset => new Date(Date.now() + (offset * 24 + 8) * 3600_000).toISOString().slice(0, 10));
  const oldSlots = await query('https://oneplace-booking.zeabur.app', 'booking.getAvailableSlotsMultiDay', { projectId, dates });
  const newSlots = await query(base, 'booking.getAvailableSlotsMultiDay', { projectId, dates });
  assert.deepEqual(newSlots, oldSlots, `${projectId} availability`);
  comparisons.push({ projectId, templateMatches: true, sevenDayAvailabilityMatches: true, oldWritesEnabled: current.writesEnabled });
}
const blocked: string[] = [];
for (const path of ['booking.confirmBooking', 'booking.cancelBookingPublic', 'booking.rescheduleBooking', 'booking.verifyTenantUid', 'booking.verifyByPhone', 'booking.registerTenantByPhone', 'booking.writeRenewalVirtualAccount', 'booking.submitRenewalRemittance', 'booking.completeRenewalRemittance']) {
  const result = await fetch(`${base}/api/trpc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"json":{}}' });
  assert.equal(result.status, 403, path);
  blocked.push(path);
}
for (const path of ['/api/outreach/run', '/api/outreach/test-send', '/api/line/inbound', '/f/trial?r=ok']) {
  const response = await fetch(base + path, { method: path.startsWith('/f/') ? 'GET' : 'POST' });
  assert.equal(response.status, 403, path);
  blocked.push(path);
}
const html = await fetch(`${base}/book/renewal`);
assert.equal(html.status, 200);
assert.match(html.headers.get('content-security-policy')!, /connect-src 'self'/);
const evidence = { checkedAt: new Date().toISOString(), comparisons, blocked, browserExternalCallsBlockedByCsp: true };
writeFileSync('.cache/trial-http-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
