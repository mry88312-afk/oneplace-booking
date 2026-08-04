## ADDED Requirements

### Requirement: Time-Based Outreach Rules

The system SHALL compute outreach schedule entries from each tenant's active contract dates for four rule types: onboarding_d15 (contract start_date plus 15 days), and expiry_d60 / expiry_d30 / expiry_d15 (contract end_date minus 60 / 30 / 15 days).

#### Scenario: Onboarding greeting at day 15

- **WHEN** a tenant's active contract has a start_date
- **THEN** an onboarding_d15 entry SHALL be scheduled with scheduled_date equal to start_date plus 15 days

#### Scenario: Expiry reminders before contract end

- **WHEN** a tenant's active contract has an end_date
- **THEN** expiry_d60, expiry_d30, and expiry_d15 entries SHALL be scheduled at end_date minus 60, 30, and 15 days respectively

##### Example: Expiry reminder dates

- **GIVEN** a contract with end_date 2026-12-31
- **WHEN** the schedule is computed
- **THEN** expiry_d60 = 2026-11-01, expiry_d30 = 2026-12-01, expiry_d15 = 2026-12-16

### Requirement: Tenant Filtering

The system SHALL schedule outreach only for tenants whose property passes two independent property-level filters AND whose contract status is "active". The two property filters mirror the two Ragic filter fields and combine with AND:

1. **Case attribution (案件歸屬 / ownership_region)** — the property's ownership_region MUST be within a configured include set (default exactly ["總公司"]). Values outside the set (for example "加盟", "台中", "高雄", "代管", "非案場") SHALL NOT qualify.
2. **Headquarters internal category (總公司內分類 / hq_internal_category)** — the property's hq_internal_category MUST NOT be within a configured exclude set (default exactly ["靠行"]). This filter excludes ONLY the listed categories; every other value — including null, "總公司", "總部", "小虎個人簽", and "AIRBNB" — SHALL pass.

The ownership_region include set and the hq_internal_category exclude set SHALL each be configurable without code changes. A tenant qualifies only when ownership_region is in the include set AND hq_internal_category is not in the exclude set AND the contract status is "active".

#### Scenario: Exclude only 靠行 on internal category

- **GIVEN** the property ownership_region is "總公司"
- **WHEN** the property hq_internal_category is "靠行"
- **THEN** no outreach entry SHALL be created for that tenant

#### Scenario: Non-excluded categories still qualify

- **GIVEN** the property ownership_region is "總公司"
- **WHEN** the property hq_internal_category is null, "總部", "小虎個人簽", or "AIRBNB"
- **THEN** an outreach entry SHALL be created, because these categories are not in the exclude set ["靠行"]

#### Scenario: Case attribution outside include set excluded

- **WHEN** a tenant's property ownership_region is "加盟" (not in the default include set ["總公司"])
- **THEN** no outreach entry SHALL be created for that tenant, even when hq_internal_category is not "靠行"

#### Scenario: Only active contracts qualify

- **WHEN** a contract status is "cancelled"
- **THEN** no outreach entry SHALL be created from that contract

### Requirement: Exclude Already-Processed Tenants

The system SHALL NOT send outreach to a tenant who has already renewed or moved out, enforced in two layers. At schedule computation, the system SHALL exclude a contract that has a renewal child (another contract whose renewal_parent_id equals this contract id), or whose status is "cancelled", or whose termination_reason is non-empty. At send time, the Zeabur sender SHALL re-check local booking_records and suppress the send when the tenant has a confirmed renewal or move-out booking.

#### Scenario: Renewal child excluded at computation

- **WHEN** a contract already has a renewal child via renewal_parent_id
- **THEN** no expiry rule entry SHALL be created for that contract

#### Scenario: Send-time suppression via booking_records

- **WHEN** a due entry's tenant has a confirmed renewal or move-out booking in booking_records
- **THEN** the sender SHALL set the entry status to "suppressed" and SHALL NOT send the card

### Requirement: Idempotent Schedule

The schedule table SHALL enforce uniqueness on the combination of tenant_uid, rule_type, and contract_no. Daily recomputation SHALL insert only missing entries and SHALL NOT overwrite any entry whose status is not "pending" or whose manually_edited flag is true.

#### Scenario: Recompute does not duplicate

- **WHEN** recomputation runs more than once for the same contract
- **THEN** exactly one entry per combination of tenant_uid, rule_type, and contract_no SHALL exist

#### Scenario: Manual edits preserved

- **WHEN** an entry has manually_edited equal to true or a status other than "pending"
- **THEN** recomputation SHALL leave that entry unchanged

### Requirement: Sending And Status Writeback

Sending SHALL occur only via the Zeabur outreach run endpoint, which SHALL require a valid shared secret. For each due, confirmed, non-suppressed entry, the system SHALL build the rule-specific LINE Flex card, push it to the tenant, and set status to "sent" with sent_at recorded. A send that fails SHALL leave the entry status unchanged so it can be retried.

#### Scenario: Successful send marks sent

- **WHEN** a confirmed and non-suppressed entry is due and the request carries the valid shared secret
- **THEN** the matching LINE Flex card SHALL be pushed and the entry status SHALL become "sent" with sent_at recorded

#### Scenario: Missing secret rejected

- **WHEN** the run endpoint is called without the valid shared secret
- **THEN** the request SHALL be rejected and no card SHALL be sent

### Requirement: Admin Schedule Board With Manual Confirmation

The Zeabur admin backend SHALL provide a board listing upcoming schedule entries showing date, tenant, rule type, and status, and SHALL allow editing the scheduled date, skipping an entry, sending immediately, and confirming an entry. In v1 an entry SHALL be auto-dispatched only after it is set to "confirmed"; "pending" entries SHALL NOT be auto-sent.

#### Scenario: Confirmation required before auto-dispatch

- **WHEN** an entry remains in "pending" status
- **THEN** the daily dispatch SHALL NOT send it until an admin sets it to "confirmed"

#### Scenario: Send immediately

- **WHEN** an admin selects send-now on an entry
- **THEN** the card SHALL be sent immediately after the send-time suppression check, regardless of scheduled_date

### Requirement: Scheduled Trigger On Supabase

Schedule computation and dispatch SHALL run on Supabase via pg_cron, and dispatch SHALL invoke the Zeabur run endpoint via pg_net. No scheduling cron SHALL run inside the Zeabur service.

#### Scenario: Daily compute and dispatch

- **WHEN** the daily pg_cron job runs
- **THEN** the schedule SHALL be recomputed and due confirmed entries SHALL be dispatched to the Zeabur run endpoint

### Requirement: Configurable Rules And Card Templates

Outreach rules and their card content SHALL be configurable by administrators without code changes. Each rule SHALL define a unique key, a trigger basis (contract_start or contract_end), an integer offset_days, an enabled flag, and a card_template holding the LINE Flex JSON to send. Schedule computation SHALL use each enabled rule's trigger basis and offset_days to set scheduled_date. The card_template SHALL support variable placeholders — at minimum tenant_name, room, contract_end_date, and days_until_expiry — which the sender SHALL substitute with the entry's actual values before sending. Administrators SHALL be able to edit a rule's offset_days, edit the card_template JSON, and enable or disable the rule from the admin backend. The default rules SHALL be onboarding (contract_start, +15) and three expiry rules (contract_end, −60 / −30 / −15).

#### Scenario: Editable offset days

- **WHEN** an administrator changes a rule's offset_days from 15 to 12
- **THEN** subsequent schedule computation SHALL place that rule's entries at the contract date offset by 12 days instead of 15

#### Scenario: Edit card via pasted Flex JSON

- **WHEN** an administrator pastes a new LINE Flex JSON into a rule's card_template and saves it
- **THEN** subsequent sends for that rule SHALL use the new card_template

#### Scenario: Variable substitution before send

- **WHEN** a card_template contains the placeholder {{tenant_name}} and the entry's tenant name is "王小明"
- **THEN** the sent card SHALL contain "王小明" in place of {{tenant_name}}

#### Scenario: Disabled rule produces no entries

- **WHEN** a rule's enabled flag is false
- **THEN** schedule computation SHALL NOT create any entry for that rule
