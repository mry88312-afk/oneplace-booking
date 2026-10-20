-- ONE-707: additive migration. Activation is a separate, verified release step.
create table outreach.rent_reminder_settings (
  id integer primary key check (id=1),
  enabled boolean not null default false,
  start_date date not null default '2026-10-21',
  updated_at timestamptz not null default now()
);
insert into outreach.rent_reminder_settings(id) values (1);
create table outreach.rent_reminder_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null unique,
  status text not null default 'running' check (status in ('running','complete','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source_at timestamptz,
  source_digest text,
  source_count integer not null default 0,
  eligible_count integer not null default 0,
  sent_count integer not null default 0,
  error text,
  decisions jsonb not null default '[]'::jsonb check (jsonb_typeof(decisions)='array')
);
alter table outreach.rent_reminder_settings enable row level security;
alter table outreach.rent_reminder_runs enable row level security;
revoke all on outreach.rent_reminder_settings, outreach.rent_reminder_runs from anon, authenticated;
grant all on outreach.rent_reminder_settings, outreach.rent_reminder_runs to service_role;

create function outreach.trigger_rent_reminders()
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_url text; v_secret text;
begin
  if not exists (
    select 1 from outreach.rent_reminder_settings where id=1 and enabled
      and start_date <= (now() at time zone 'Asia/Taipei')::date
  ) then return; end if;
  select run_endpoint_url, run_secret into v_url, v_secret from outreach.settings where id=1;
  if v_url is null or v_url not like 'https://%/api/outreach/run' or coalesce(v_secret,'')='' then
    raise warning 'ONE-707 outreach endpoint or secret missing'; return;
  end if;
  perform net.http_post(
    url := regexp_replace(v_url, '/run$', '/rent-reminders'),
    headers := jsonb_build_object('Content-Type','application/json','x-outreach-secret',v_secret),
    body := '{}'::jsonb, timeout_milliseconds := 600000
  );
end $$;
revoke all on function outreach.trigger_rent_reminders() from public, anon, authenticated;
-- pg_cron uses UTC: 04:00 UTC = 12:00 Asia/Taipei.
select cron.schedule('one707-rent-reminders-noon', '0 4 * * *', 'select outreach.trigger_rent_reminders()');
