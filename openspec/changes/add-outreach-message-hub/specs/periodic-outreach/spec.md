## ADDED Requirements

### Requirement: Time-Precise Hourly Dispatch

Each schedule entry SHALL carry a send timestamp (send_at) specifying both date and hour. The dispatcher SHALL run hourly and SHALL dispatch only entries whose status is "confirmed" and whose send timestamp is in the past. Rule-derived entries SHALL default their send timestamp to 09:00 Taipei time on the scheduled date, preserving existing behavior. An entry whose send timestamp lies in the past when it is created SHALL be dispatched on the next hourly run exactly once.

#### Scenario: Entry sends at its hour

- **WHEN** a confirmed entry has send timestamp today 18:00 Taipei
- **THEN** the 17:00 hourly run SHALL NOT dispatch it and the 18:00 hourly run SHALL dispatch it

#### Scenario: Past send time dispatches once on next run

- **WHEN** an entry is enqueued with a send timestamp already in the past
- **THEN** the next hourly run SHALL dispatch it exactly once

### Requirement: Checkout Day-Before Reminder

A daily evening scan (17:00 Taipei) SHALL find this system's checkout bookings (contract action "退租", status "confirmed") whose booking time falls on the next day in Taipei time, and SHALL insert for each an auto-confirmed reminder entry with source "booking" and send timestamp 18:00 Taipei the same day. Insertion SHALL be idempotent per booking and booking date via a dedupe key, so re-running the scan SHALL NOT duplicate entries. At send time the system SHALL re-verify the booking still exists, is still "confirmed", and is still scheduled for the day after the send timestamp; otherwise the entry SHALL be marked "skipped" with the reason and nothing SHALL be sent. The reminder card template SHALL be stored as an editable rule (key checkout_d1) and SHALL NOT be processed by the contract-date recompute engine.

#### Scenario: Reminder created and sent day before checkout

- **WHEN** a confirmed checkout booking exists for tomorrow at the time of the evening scan
- **THEN** a reminder entry SHALL be created with send timestamp 18:00 Taipei today, auto-confirmed, and SHALL be dispatched at the 18:00 hourly run

#### Scenario: Cancelled after scan is not sent

- **WHEN** the booking is cancelled between the evening scan and the 18:00 send
- **THEN** the send-time re-verification SHALL mark the entry "skipped" with a cancellation reason and the tenant SHALL NOT receive the card

#### Scenario: Rescheduled booking reminds on the new date only

- **WHEN** a booking originally for tomorrow is rescheduled to a later date after the scan
- **THEN** the old entry SHALL be skipped at send time, and a new reminder entry SHALL be created by the evening scan on the day before the new date

##### Example: dedupe and reschedule

| event                          | entries for booking 123                  | sent              |
| ------------------------------ | ---------------------------------------- | ----------------- |
| scan (booking on 6/15)         | checkout_d1:123:2026-06-15               | pending dispatch  |
| scan re-run same day           | (same single entry — dedupe)             | —                 |
| rescheduled to 6/20, 18:00 run | entry 06-15 skipped (re-check)           | nothing           |
| scan on 6/19                   | + checkout_d1:123:2026-06-20             | sent 6/19 18:00   |

### Requirement: External Message Enqueue API

The system SHALL expose a secret-protected HTTP endpoint that accepts a message submission containing: a dedupe key (required), a full LINE card JSON (required; a bare bubble SHALL be auto-wrapped), an optional alt text, a recipient given as LINE UID or phone (exactly one required), a send timestamp (required), and a tag (required). A valid submission SHALL insert an auto-confirmed schedule entry with source "api" that appears on the admin board and dispatches at its send time. A submission whose dedupe key already exists SHALL NOT create a second entry and SHALL be answered with a deduped indicator. A request with an invalid secret SHALL be rejected with 401; a request missing a required field SHALL be rejected with 400 naming the field. Test-mode redirect SHALL apply to api-source entries the same as to all other sources.

#### Scenario: Valid submission enqueues and sends

- **WHEN** an external system posts a valid submission with a future send timestamp
- **THEN** an auto-confirmed entry with source "api" and the given tag SHALL appear on the board and SHALL be dispatched at that hour

#### Scenario: Duplicate dedupe key

- **WHEN** the same dedupe key is submitted twice
- **THEN** exactly one entry SHALL exist and the second response SHALL indicate deduped

#### Scenario: Invalid secret rejected

- **WHEN** a submission carries a wrong or missing secret
- **THEN** the endpoint SHALL respond 401 and SHALL NOT create any entry

### Requirement: Phone-To-UID Resolution At Send Time

A schedule entry whose recipient is a phone number without a LINE UID SHALL be resolved at send time by looking up the mirror tenants table by unique phone. When a UID is found, the entry SHALL be updated with it and sent normally. When no tenant or no UID is found, the system SHALL record a send failure ("no LINE UID for phone") on the entry, leave its status unchanged so it remains retryable after the tenant binds, and SHALL NOT send anything.

#### Scenario: Phone resolves and sends

- **WHEN** an api-source entry has only a phone and the mirror has a tenant with that phone and a LINE UID
- **THEN** the entry SHALL be sent to that UID and the UID SHALL be stored on the entry

#### Scenario: Unresolvable phone is retryable

- **WHEN** the phone matches no tenant or the tenant has no LINE UID
- **THEN** the entry SHALL record the failure reason, increment its attempt count, keep its status, and appear in the failed list for retry

### Requirement: Source And Tag Classification On Board

Every schedule entry SHALL carry a source — "rule" (contract rules), "booking" (checkout reminders), or "api" (external submissions) — and MAY carry a free-text tag. The admin board SHALL allow filtering by source and by tag, and SHALL display each entry's source, tag, and send time.

#### Scenario: Filter by source

- **WHEN** an admin filters the board by source "api"
- **THEN** only entries created via the enqueue endpoint SHALL be listed

#### Scenario: Tag display and filter

- **WHEN** entries exist with tag "帳務通知"
- **THEN** selecting that tag SHALL list only those entries and each row SHALL display the tag

### Requirement: Unbound-UID Tenant List

The admin backend SHALL provide a list of tenants who have an active contract but no LINE UID in the mirror, showing name, phone, property, and room, with CSV export encoded as UTF-8 with a byte-order mark. The list SHALL reflect the mirror state at query time so that a tenant disappears from it after binding.

#### Scenario: Unbound tenant listed until bound

- **WHEN** a tenant with an active contract has no LINE UID
- **THEN** the tenant SHALL appear in the unbound list with name, phone, property, and room, and SHALL no longer appear after a UID is recorded

### Requirement: Expiring Unbound Tenant Visibility

The unbound-tenant list SHALL include each tenant's contract end date and SHALL support filtering to tenants whose contract end date falls within the next 60 days, so staff can manually contact expiring tenants the dispatcher cannot reach (a tenant without a LINE UID never receives a schedule entry).

#### Scenario: Expiring-soon filter for manual outreach

- **WHEN** staff applies the expiring-within-60-days filter on the unbound list
- **THEN** only unbound tenants whose contract end date falls within the next 60 days SHALL be listed, each row showing the contract end date, and the CSV export SHALL include the contract end date column

### Requirement: Enqueue Integration Example

The admin board SHALL display a copyable integration example for the enqueue endpoint, showing the endpoint URL, the secret header name, the request body schema with field explanations, and one complete sample request, so an external system such as Ragic or MANUS can integrate without reading source code.

#### Scenario: Copy the integration example

- **WHEN** an admin opens the integration example card on the board
- **THEN** it SHALL show the endpoint URL, the secret header name, the body schema, and a complete sample request sufficient to submit a valid enqueue request
