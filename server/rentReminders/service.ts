import { sbQuery } from "../db/supabaseClient";
import { relayPushOnce } from "../routers/property/bookingConfirmHandler";
import { Bill, Identity, TAG, PREFIX, buildFlex, decide, inSendWindow, overdueDays, taipeiDate } from "./domain";
import { fetchCurrentBills } from "./source";

export async function loadIdentities(ids: string[]): Promise<Identity[]> {
  if (!ids.length) return [];
  return sbQuery<Identity>(`
    select c.id as contract_id,c.jgb_id::text, nullif(trim(c.legacy_snapshot->>'1007543'),'') as raw_jgb_id,
      c.contract_no,to_char(c.end_date,'YYYY-MM-DD') as end_date,
      to_char(c.move_out_date,'YYYY-MM-DD') as move_out_date,c.status,
      p.ownership_region,p.hq_internal_category,p.short_name as property_name,p.deleted_at::text as property_deleted,
      t.id as tenant_id,t.primary_name as tenant_name,t.line_uid as uid,
      (exists(select 1 from contract.tenants other where other.id<>t.id and other.deleted_at is null and other.line_uid=t.line_uid)
       or exists(select 1 from communication.line_bindings lb where lb.tenant_id=t.id and lb.scope='tenant'
         and lb.active and lb.line_uid is distinct from t.line_uid)) as uid_conflict
    from contract.tenant_contracts c
    left join property.properties p on p.id=c.property_id
    left join contract.tenant_contract_parties cp on cp.tenant_contract_id=c.id and cp.role='primary'
    left join contract.tenants t on t.id=cp.tenant_id and t.deleted_at is null
    where c.deleted_at is null and
      (trim(c.jgb_id::text)=any($1::text[]) or trim(c.legacy_snapshot->>'1007543')=any($1::text[]))`, [ids]);
}
export type Decision = {
  billId: string; billName: string; room: string; tenantName: string; contractNo: string;
  total: number; days: number | null; eligible: boolean; reason: string; uidMask: string | null;
};
function assess(bills: Bill[], identities: Identity[], today: string): Decision[] {
  return bills.map(b => {
    const d = decide(b, identities, today);
    const days = overdueDays(b.due, today);
    return { billId: b.id, billName: b.name, room: b.room, tenantName: d.identity?.tenant_name ?? "",
      contractNo: d.identity?.contract_no ?? "", total: b.total, days: Number.isFinite(days) ? days : null,
      eligible: d.eligible, reason: d.reason, uidMask: d.identity?.uid ? `${d.identity.uid.slice(0, 5)}…${d.identity.uid.slice(-6)}` : null };
  });
}
export async function previewRentReminders() {
  const source = await fetchCurrentBills();
  const identities = await loadIdentities(source.bills.map(b => b.contractId));
  return { sourceAt: source.fetchedAt.toISOString(), decisions: assess(source.bills, identities, taipeiDate()) };
}
export async function rentSettings() {
  return (await sbQuery<{ enabled: boolean; start_date: string; test_mode: boolean }>(`
    select r.enabled,to_char(r.start_date,'YYYY-MM-DD') as start_date,
      exists(select 1 from outreach.settings where id=1 and nullif(trim(test_redirect_uid),'') is not null) as test_mode
    from outreach.rent_reminder_settings r where r.id=1`))[0];
}
export async function rentHistory() {
  const [settings, runs, messages] = await Promise.all([
    rentSettings(),
    sbQuery(`select id,to_char(run_date,'YYYY-MM-DD') as run_date,status,started_at,finished_at,
      source_at,source_count,eligible_count,sent_count,error,decisions
      from outreach.rent_reminder_runs order by run_date desc limit 14`),
    sbQuery(`select id,tenant_name,room,contract_no,status,suppressed_reason,sent_at,last_attempt_at,last_error,
      to_char(scheduled_date,'YYYY-MM-DD') as scheduled_date,vars
      from outreach.schedule where dedupe_key like 'jgb-rent:%' order by created_at desc limit 500`),
  ]);
  return { settings, runs, messages };
}
export async function setRentEnabled(enabled: boolean) {
  await sbQuery("update outreach.rent_reminder_settings set enabled=$1,updated_at=now() where id=1", [enabled]);
  return rentSettings();
}

// The run-date unique constraint and per-bill dedupe key are durable across processes/restarts.
// A run is never retried automatically, including after an uncertain delivery or process crash.
const production = {
  query: sbQuery, fetchBills: fetchCurrentBills, identities: loadIdentities,
  settings: rentSettings, send: relayPushOnce, now: () => new Date(),
};
export async function runRentReminders(deps = production) {
  const { query, fetchBills, identities: readIdentities, settings: readSettings, send, now } = deps;
  const today = taipeiDate(now());
  const settings = await readSettings();
  if (!settings?.enabled || settings.test_mode || !inSendWindow(now(), settings.start_date))
    return { skipped: true, reason: "未啟用、測試模式或不在中午執行時段" };
  const created = await query<{ id: string }>(`
    insert into outreach.rent_reminder_runs(run_date) values($1)
    on conflict(run_date) do nothing returning id`, [today]);
  if (!created.length) return { skipped: true, reason: "今日已執行或執行中，不重跑" };
  const runId = created[0].id;
  let sent = 0;
  try {
    const source = await fetchBills();
    const identities = await readIdentities(source.bills.map(b => b.contractId));
    const decisions = assess(source.bills, identities, today);
    await query(`update outreach.rent_reminder_runs set source_at=$2,source_digest=$3,
      source_count=$4,eligible_count=$5,decisions=$6::jsonb where id=$1`,
    [runId, source.fetchedAt, source.digest, source.bills.length, decisions.filter(d => d.eligible).length, JSON.stringify(decisions)]);
    for (const bill of source.bills) {
      const initial = decide(bill, identities, today);
      if (!initial.eligible) continue;
      // Re-read identity, ownership, lease, pause/test mode and known receipt immediately before each send.
      const current = await readSettings();
      if (!current?.enabled || current.test_mode || !inSendWindow(now(), current.start_date) ||
          +now() - +source.fetchedAt > 15 * 60000) throw new Error("已暫停、超出時段或來源逾時，剩餘帳單不發送");
      const fresh = decide(bill, await readIdentities([bill.contractId]), today);
      const knownPaid = await query<{ paid: boolean }>(`select exists(
        select 1 from income_integration.jgb_bill_status_index
        where bill_id=$1 and last_seen_at >= $2 and bill_status <> 'unreceived'
      ) as paid`, [bill.id, source.fetchedAt]);
      let reason = fresh.eligible ? null : fresh.reason;
      if (knownPaid[0]?.paid) reason = "取得匯出後帳單狀態已變更";
      if (fresh.identity?.tenant_id !== initial.identity.tenant_id || fresh.identity?.uid !== initial.identity.uid)
        reason = "發送前收件人對應變更，待核對";
      const flex = buildFlex(bill, initial.identity, today);
      const rows = await query<{ id: string }>(`insert into outreach.schedule
        (tenant_uid,tenant_name,room,property_name,contract_id,contract_no,scheduled_date,send_at,
         status,suppressed_reason,source,tag,card_override,alt_text,vars,dedupe_key)
        values($1,$2,$3,$4,$5,$6,$7,($7::date + time '12:00') at time zone 'Asia/Taipei',
          'suppressed',$8,'api',$9,$10::jsonb,$11,$12::jsonb,$13)
        on conflict(dedupe_key) where dedupe_key is not null do nothing returning id`,
      [initial.identity.uid, initial.identity.tenant_name, bill.room, initial.identity.property_name,
        initial.identity.contract_id, initial.identity.contract_no, today, reason ?? "租金專用派送待處理",
        TAG, JSON.stringify(flex.contents), flex.altText,
        JSON.stringify({ rent_reminder: true, run_id: runId, bill_id: bill.id, bill_name: bill.name,
          total: bill.total, overdue_days: overdueDays(bill.due, today), due_date: bill.due }),
        `${PREFIX}${today}:${bill.id}`]);
      if (!rows.length || reason) continue;
      const id = rows[0].id;
      // Keep status outside generic dispatcher's pending/confirmed set, including on old application versions.
      const claim = await query(`update outreach.schedule set
          attempt_count=1,last_attempt_at=now(),suppressed_reason='發送中／中斷後待核對',updated_at=now()
        where id=$1 and coalesce(attempt_count,0)=0 and status='suppressed'
          and suppressed_reason='租金專用派送待處理'
          and exists(select 1 from outreach.rent_reminder_settings where id=1 and enabled)
          and not exists(select 1 from outreach.settings where id=1 and nullif(trim(test_redirect_uid),'') is not null)
          returning id`, [id]);
      if (!claim.length) continue;
      const result = await send(initial.identity.uid!, flex);
      await query(`update outreach.schedule set status=$2,sent_at=case when $2='sent' then now() else null end,
        suppressed_reason=$3,last_error=$4,vars=vars || $5::jsonb,updated_at=now() where id=$1`,
      [id, result.accepted ? "sent" : "suppressed", result.accepted ? null : "發送結果待核對，當日不重送",
        result.error ?? null, JSON.stringify({ line_message_id: result.messageId ?? null })]);
      if (result.accepted) {
        sent++;
        await query("update outreach.rent_reminder_runs set sent_count=$2 where id=$1", [runId, sent]);
      }
    }
    await query("update outreach.rent_reminder_runs set status='complete',finished_at=now() where id=$1", [runId]);
    return { runId, sent };
  } catch (e) {
    // Only controlled operational messages are shown; no raw response bodies, URLs or credentials.
    const message = e instanceof Error && /^(JGB|已暫停)/.test(e.message)
      ? e.message.slice(0, 300) : "資料讀寫或執行異常，請查服務紀錄；當日不自動重送";
    await query("update outreach.rent_reminder_runs set status='failed',error=$2,finished_at=now() where id=$1", [runId, message]);
    return { runId, sent, error: message };
  }
}
