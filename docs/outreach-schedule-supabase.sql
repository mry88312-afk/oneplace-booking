-- ============================================================================
-- 週期詢問／合約到期提醒 — Supabase 端函式（正式庫 dwoahbduwzfzqmwpvadj）
-- 這些函式只存在 Supabase，repo 不會自動同步；此檔為「變更留底＋可重放」用。
-- 若在 Supabase 直接改了函式，請把新定義貼回這裡一起 commit。
-- ============================================================================

-- P91（2026-07）到期判斷改用「退租日 move_out_date」，不看 Ragic 存在/取消 --------
--
-- 病根：Ragic 的「取消」是公式，合約「過期」或「退租」都會變取消；而「退租原因
-- (termination_reason)」幾乎沒人填。舊邏輯用 status='active' / termination_reason 判斷，
-- 造成兩個相反的錯：
--   1) 漏發：續住租客一過到期日就自動變取消 → 掉出到期名單（例：游佩恩 A03364）。
--   2) 誤發：已退租者退租原因常空、且排程排下去後不會回收 → 續約卡照發（例：魏廷樺 A01934，
--      退租 6/22 卻 7/3 仍發 d60）。
-- 修法：一律改用「退租日(move_out_date)有無填」當「是否真的搬走」的訊號。

-- 一次性止血（已於 2026-07-10 於正式庫執行；此處留底，可重放且冪等）：
-- (1) 把「合約已填退租日、卻還排著 confirmed/pending」的 rule 卡改 suppressed。
update outreach.schedule s
   set status='suppressed',
       suppressed_reason='退租止血：合約 move_out_date 已填（audit 2026-07-10）',
       updated_at=now()
 where s.status in ('confirmed','pending')
   and coalesce(s.source,'rule')='rule'
   and exists (select 1 from contract.tenant_contracts tc
               where tc.contract_no = s.contract_no and tc.move_out_date is not null);

-- (2) P93：把「同房已有更晚開始的新合約（續約/接手）、舊約卻還排著」的 rule 卡改 suppressed。
update outreach.schedule s
   set status='suppressed',
       suppressed_reason='房間已有更新合約（續約/接手），舊約到期卡回收（audit 2026-07-10）',
       updated_at=now()
  from contract.tenant_contracts tc
 where s.status in ('pending','confirmed')
   and coalesce(s.source,'rule')='rule'
   and tc.contract_no = s.contract_no
   and exists (
     select 1 from contract.tenant_contracts c2
      where c2.deleted_at is null
        and c2.property_id is not distinct from tc.property_id
        and coalesce(nullif(c2.legacy_snapshot->>'1014736',''), c2.unit_id::text, 'c:'||c2.contract_no)
          = coalesce(nullif(tc.legacy_snapshot->>'1014736',''), tc.unit_id::text, 'c:'||tc.contract_no)
        and c2.start_date > tc.start_date);

-- 排程重算：候選加 `tc.move_out_date is null`；並在每晚 recompute 尾端自動止血
-- （排後才退租者 → 現有 pending/confirmed 的 rule 卡改 suppressed）。
CREATE OR REPLACE FUNCTION outreach.recompute_schedule()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_include text[];
  v_exclude text[];
  v_count int := 0;
begin
  select include_ownership_regions, exclude_hq_categories into v_include, v_exclude
  from outreach.settings where id = 1;

  insert into outreach.schedule
    (tenant_uid, tenant_name, room, property_name, contract_id, contract_no, contract_end_date, rule_key, scheduled_date, status, send_at, source)
  select
    t.line_uid, t.primary_name, coalesce(u.unit_no, u.room_code), p.short_name,
    tc.id, tc.contract_no,
    case when r.trigger_basis = 'contract_end' then tc.end_date else null end,
    r.key,
    (case when r.trigger_basis = 'contract_start' then tc.start_date else tc.end_date end) + r.offset_days,
    case when r.auto_confirm then 'confirmed' else 'pending' end,
    (((case when r.trigger_basis = 'contract_start' then tc.start_date else tc.end_date end) + r.offset_days)::timestamp + coalesce(r.send_time,'09:00'::time)) at time zone 'Asia/Taipei',
    'rule'
  from contract.tenant_contracts tc
  join property.properties p              on p.id = tc.property_id
  join contract.tenant_contract_parties tcp on tcp.tenant_contract_id = tc.id
  join contract.tenants t                 on t.id = tcp.tenant_id
  left join property.units u              on u.id = tc.unit_id
  cross join outreach.rule r
  where r.enabled = true
    and r.trigger_basis in ('contract_start','contract_end')
    and tc.status = 'active'
    and tc.deleted_at is null
    and tc.contract_no is not null
    and t.line_uid is not null and t.line_uid <> ''
    and p.ownership_region = any (v_include)
    and (p.hq_internal_category is null or not (p.hq_internal_category = any (v_exclude)))
    and not exists (select 1 from contract.tenant_contracts c2 where c2.renewal_parent_id = tc.id)
    and coalesce(tc.termination_reason,'') = ''
    and tc.move_out_date is null   -- P91：退租日有值＝已搬走，不排（Ragic「取消」不可靠）
    and not (
      r.trigger_basis = 'contract_end'
      and exists (
        select 1 from contract.tenant_contract_parties tcp2
        join contract.tenant_contracts c2 on c2.id = tcp2.tenant_contract_id
        where tcp2.tenant_id = tcp.tenant_id and c2.id <> tc.id
          and c2.status='active' and c2.deleted_at is null and c2.end_date > tc.end_date
      )
    )
    and not (
      r.trigger_basis = 'contract_start'
      and exists (
        select 1 from contract.tenant_contract_parties tcp2
        join contract.tenant_contracts c2 on c2.id = tcp2.tenant_contract_id
        where tcp2.tenant_id = tcp.tenant_id and c2.id <> tc.id
          and c2.deleted_at is null and c2.start_date < tc.start_date
      )
    )
    and (case when r.trigger_basis = 'contract_start' then tc.start_date else tc.end_date end) is not null
    and (case when r.trigger_basis = 'contract_start' then tc.start_date else tc.end_date end) + r.offset_days >= current_date
  on conflict (tenant_uid, rule_key, contract_no) do nothing;

  get diagnostics v_count = row_count;

  -- P91 自動止血：排後才退租者（合約填了退租日）→ 現有 pending/confirmed 的 rule 卡改 suppressed。
  update outreach.schedule s
     set status = 'suppressed',
         suppressed_reason = '合約已退租（move_out_date 已填，recompute 自動止血）',
         updated_at = now()
   where s.status in ('pending','confirmed')
     and coalesce(s.source,'rule') = 'rule'
     and exists (
       select 1 from contract.tenant_contracts tc
        where tc.contract_no = s.contract_no and tc.move_out_date is not null);

  -- P93 續約/接手後回收舊約殘存排程：同房已有「更晚開始的合約」→ 舊約到期卡改 suppressed。
  -- 房間鍵：房號(1014736) → 無房號用 unit_id → 再無則合約自成一房（整租 fallback）。
  update outreach.schedule s
     set status = 'suppressed',
         suppressed_reason = '房間已有更新合約（續約/接手），舊約到期卡回收',
         updated_at = now()
    from contract.tenant_contracts tc
   where s.status in ('pending','confirmed')
     and coalesce(s.source,'rule') = 'rule'
     and tc.contract_no = s.contract_no
     and exists (
       select 1 from contract.tenant_contracts c2
        where c2.deleted_at is null
          and c2.property_id is not distinct from tc.property_id
          and coalesce(nullif(c2.legacy_snapshot->>'1014736',''), c2.unit_id::text, 'c:'||c2.contract_no)
            = coalesce(nullif(tc.legacy_snapshot->>'1014736',''), tc.unit_id::text, 'c:'||tc.contract_no)
          and c2.start_date > tc.start_date);

  return v_count;
end;
$function$;

-- 註：發送前的即時退租查核在程式端 runOutreach()（server/routers/property/outreachHandlers.ts），
-- 對 rule 卡在 push 前再查一次 move_out_date，涵蓋「排程與 recompute 之間才退租」的同日空窗。
