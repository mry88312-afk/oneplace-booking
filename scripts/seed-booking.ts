import assert from 'node:assert/strict';
import { sql, getTableColumns } from 'drizzle-orm';
import type { getDb } from '../server/db';
import { bookingTemplates, bookingFormFields, calendarRoutingRules } from '../drizzle/schema';
import { getLockedBundle } from '../server/config/lockedTemplates';

/** Configuration only. Numeric IDs are frozen configuration keys used by lockedTemplates. */
export async function seedBooking(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  const bundles = ['checkout', 'contract'].map(id => {
    const bundle = getLockedBundle(id);
    assert.ok(bundle);
    return bundle;
  });
  const templates = bundles.map(b => b.template);
  const fields = bundles.flatMap(b => b.fields);
  const rules = bundles.flatMap(b => b.rules);
  await db.transaction(async tx => {
    await tx.execute(sql`LOCK TABLE booking.booking_templates, booking.booking_form_fields, booking.calendar_routing_rules IN EXCLUSIVE MODE`);
    const existing = await tx.select().from(bookingTemplates);
    if (existing.length === 0) {
      await tx.insert(bookingTemplates).values(templates);
      await tx.insert(bookingFormFields).values(fields);
      await tx.insert(calendarRoutingRules).values(rules);
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('booking.booking_templates','bt_id'), (SELECT max(bt_id) FROM booking.booking_templates))`);
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('booking.booking_form_fields','bff_id'), (SELECT max(bff_id) FROM booking.booking_form_fields))`);
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('booking.calendar_routing_rules','crr_id'), (SELECT max(crr_id) FROM booking.calendar_routing_rules))`);
    }
    const normal = (rows: object[], columns: string[]) => JSON.parse(JSON.stringify(rows.map(row => Object.fromEntries(
      columns.map(key => [key, Reflect.get(row, key)]),
    )).sort((a, b) => Number(a.id) - Number(b.id))));
    assert.deepEqual(normal(await tx.select().from(bookingTemplates), Object.keys(getTableColumns(bookingTemplates))), normal(templates, Object.keys(getTableColumns(bookingTemplates))));
    assert.deepEqual(normal(await tx.select().from(bookingFormFields), Object.keys(getTableColumns(bookingFormFields))), normal(fields, Object.keys(getTableColumns(bookingFormFields))));
    assert.deepEqual(normal(await tx.select().from(calendarRoutingRules), Object.keys(getTableColumns(calendarRoutingRules))), normal(rules, Object.keys(getTableColumns(calendarRoutingRules))));
  });
  return { templates: templates.length, fields: fields.length, rules: rules.length, allColumnsVerified: true };
}
