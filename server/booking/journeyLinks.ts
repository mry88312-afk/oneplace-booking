import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { sbQuery } from '../db/supabaseClient';

export async function createJourneyLink(uid: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({code:'SERVICE_UNAVAILABLE'});
  const id = randomUUID();
  await db.execute(sql`INSERT INTO booking.journey_links(id,line_uid) VALUES(${id}::uuid,${uid})`);
  return { id };
}

/** 只能由 adminProcedure 呼叫；代碼本身不提供登入權限。 */
export async function readJourneyTenant(id: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({code:'SERVICE_UNAVAILABLE'});
  const result = await db.execute(sql`SELECT line_uid FROM booking.journey_links WHERE id=${id}::uuid AND created_at>now()-interval '180 days'`);
  const uid = result.rows[0]?.line_uid;
  if (typeof uid !== 'string') return [];
  return sbQuery<{name:string;property:string|null;room:string|null;end_date:string|null}>(`
    SELECT DISTINCT t.primary_name AS name,p.short_name AS property,u.unit_no AS room,c.end_date::text
    FROM contract.tenants t
    LEFT JOIN contract.tenant_contract_parties pa ON pa.tenant_id=t.id
    LEFT JOIN contract.tenant_contracts c ON c.id=pa.tenant_contract_id AND c.deleted_at IS NULL
    LEFT JOIN property.properties p ON p.id=c.property_id
    LEFT JOIN property.units u ON u.id=c.unit_id
    WHERE t.line_uid=$1 AND t.deleted_at IS NULL
    ORDER BY end_date DESC NULLS LAST LIMIT 30`,[uid]);
}
