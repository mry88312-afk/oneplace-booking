import assert from 'node:assert/strict';

// Read-only integration check against the deployed handlers and Google Calendar.
// Never calls verification, OTP, booking, Ragic writes or LINE notification APIs.
const origin = process.env.BOOKING_VERIFY_ORIGIN || 'https://oneplace-booking.zeabur.app';
async function query(name: string, input: object) {
  const response = await fetch(`${origin}/api/trpc/booking.${name}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const body = await response.json();
  assert.ok(body.result?.data?.json, `${name}: missing tRPC data`);
  return body.result.data.json;
}

const template = await query('getPublicTemplate', { projectId: 'renewal' });
assert.equal(template.projectId, 'renewal');
assert.equal(template.slotDurationMinutes, 90);
assert.equal(template.bookableDaysAhead, 90);
assert.equal(template.minLeadDays, 6);
assert.equal(template.liffId, '2006833424-znZYKjip');
assert.equal(template.writesEnabled, true);
assert.deepEqual([...template.routingDays].sort(), [0, 1, 2, 3, 5]);
assert.deepEqual(template.fields.map((f: any) => [f.fieldType, f.label, f.isRequired, f.ragicFieldId, f.sortOrder]), [
  ['select', '繳費方式', true, '1013721', 0],
  ['text', '入住人數', true, null, 1],
  ['text', '續約備註', false, null, 2],
  ['inbox_url', '', false, '1022936', 3],
]);
assert.deepEqual(template.fields[0].options, ['月繳', '半年繳', '年繳']);

const hours: Record<number, [string, string] | null> = {
  0: ['13:00', '20:30'], 1: ['10:00', '18:30'], 2: ['16:00', '18:30'],
  3: ['13:00', '20:30'], 4: null, 5: ['10:00', '18:30'], 6: null,
};
const taipeiNow = new Date(Date.now() + 8 * 3600_000);
const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(
  taipeiNow.getUTCFullYear(), taipeiNow.getUTCMonth(), taipeiNow.getUTCDate() + 7 + i,
)).toISOString().slice(0, 10));
const multi = await query('getAvailableSlotsMultiDay', { projectId: 'renewal', dates });
const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(11, 16);
let total = 0;
let presetChecked = false;
for (const date of dates) {
  const single = await query('getAvailableSlots', { projectId: 'renewal', date });
  const cap = hours[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const slots = single.slots.filter((s: any) => s.available);
  const batch = multi.slotsByDate[date] || [];
  if (!cap) assert.deepEqual([slots, batch], [[], []], `${date}: closed day`);
  for (const slot of [...slots, ...batch]) {
    assert.ok(cap);
    assert.equal(Date.parse(slot.endTime) - Date.parse(slot.startTime), 90 * 60_000);
    assert.ok(localTime(slot.startTime) >= cap[0] && localTime(slot.endTime) <= cap[1], `${date}: outside approved hours`);
    assert.equal(slot.calendarOwner, '謝依蒨');
    if (slot.calendarId) assert.equal(slot.calendarId, 'chantel.oneplace@gmail.com');
  }
  assert.deepEqual(slots.map((s: any) => s.startTime), batch.map((s: any) => s.startTime), `${date}: single/multi disagree`);
  total += slots.length;
  if (!presetChecked && slots.length) {
    const t = date.replaceAll('-', '') + localTime(slots[0].startTime).replace(':', '');
    const preset = await query('resolvePresetSlot', { projectId: 'renewal', t });
    assert.equal(preset.assigneeName, '謝依蒨');
    assert.equal(preset.calendarId, 'chantel.oneplace@gmail.com');
    assert.equal(Date.parse(preset.endTime) - Date.parse(preset.startTime), 90 * 60_000);
    presetChecked = true;
  }
  console.log(JSON.stringify({ date, open: !!cap, available: slots.length }));
}
assert.ok(total > 0 && presetChecked, 'No available slots to verify; inspect Calendar without assuming a configuration failure');
console.log(JSON.stringify({ origin, templateId: template.id, fields: 4, daysChecked: 7, availableSlotsChecked: total, presetChecked, result: 'PASS' }));
