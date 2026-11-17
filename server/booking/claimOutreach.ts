// Shared Postgres row is the authority across processes, GCP and Zeabur.
export async function claimOutreach(id: string, query: (sql: string, params: string[]) => Promise<object[]>): Promise<boolean> {
  const claim = await query(`update outreach.schedule set status='suppressed',
        vars=coalesce(vars,'{}'::jsonb) || '{"_hub_dispatch_started":true}'::jsonb,
        suppressed_reason='派送已開始，回應中斷時請核對，勿重送',
        last_error='派送回執待核對', last_attempt_at=now(),
        attempt_count=coalesce(attempt_count,0)+1, updated_at=now()
        where id=$1 and status in ('pending','confirmed') and sent_at is null
          and not (coalesce(vars,'{}'::jsonb) ? '_hub_dispatch_started')
          and not exists(select 1 from outreach.settings where id=1 and nullif(trim(test_redirect_uid),'') is not null)
        returning id`, [id]);
  return claim.length === 1;
}
