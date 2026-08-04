## ADDED Requirements

### Requirement: Batch Schedule Operations

The admin schedule board SHALL allow selecting multiple schedule entries and applying one action — confirm, skip, or send-now — to all selected entries in a single request. The system SHALL process each selected entry independently and SHALL return a per-entry result indicating success or the failure reason. A failure on one entry SHALL NOT abort processing of the remaining selected entries. Batch send-now SHALL apply the same send-time suppression check and test-mode redirect as a single send.

#### Scenario: Batch confirm with one ineligible entry

- **WHEN** an admin selects three entries — two in "pending" status and one already in "sent" status — and applies the confirm action
- **THEN** the two pending entries SHALL become "confirmed" and the already-sent entry SHALL return a per-entry result with ok=false and a reason, without affecting the other two

#### Scenario: Batch send-now honors suppression

- **WHEN** an admin selects multiple confirmed entries and applies send-now
- **THEN** each entry SHALL pass through the send-time suppression check before sending, and any entry whose tenant has a confirmed renewal or move-out booking SHALL be marked "suppressed" rather than sent

### Requirement: Per-Entry Card Preview To Test Recipient

The board SHALL provide a per-entry preview that renders the entry's rule card with the entry's actual variable values and pushes the rendered card only to the configured test recipient (the test_redirect_uid in outreach.settings). A preview SHALL NOT send to the tenant, SHALL NOT change the entry status, and SHALL NOT run the dispatch flow. When no test recipient is configured, the preview SHALL fail with an explicit message instructing the admin to set a test recipient first.

#### Scenario: Preview sends only to the test recipient

- **WHEN** an admin previews a schedule entry and a test recipient is configured
- **THEN** the rendered card SHALL be pushed to the test recipient, the tenant SHALL NOT receive it, and the entry status SHALL remain unchanged

#### Scenario: Preview without a test recipient

- **WHEN** an admin previews an entry and no test recipient is configured
- **THEN** the system SHALL return an error instructing the admin to configure a test recipient and SHALL NOT push any card

### Requirement: Today And Property-Grouped Schedule Views

The board SHALL provide a quick filter that limits the schedule list to entries whose scheduled_date equals the current date, and SHALL support grouping the listed entries by property_name with a count of entries per property.

#### Scenario: Today quick filter

- **WHEN** an admin selects the "today" quick filter
- **THEN** the list SHALL show only entries whose scheduled_date equals the current date

#### Scenario: Group by property with counts

- **WHEN** an admin enables property grouping
- **THEN** entries SHALL be grouped by property_name and each group SHALL display its entry count

##### Example: property grouping counts

| property_name | entries listed | count shown |
| ------------- | -------------- | ----------- |
| Property A    | 3              | 3           |
| Property B    | 1              | 1           |

### Requirement: Send Failure Tracking And Retry

The schedule table SHALL record send-failure metadata in three fields: last_error (the failure message), last_attempt_at (the timestamp of the most recent send attempt), and attempt_count (the number of send attempts). When a send attempt fails, the system SHALL set last_error, set last_attempt_at, increment attempt_count, and leave the entry status unchanged so the entry remains eligible for retry. When a send succeeds, the system SHALL set status to "sent", record sent_at, and clear last_error. The board SHALL provide a view listing entries that have a recorded failure and SHALL allow retrying a failed entry, which re-runs the same send path.

#### Scenario: Failed send records error and preserves status

- **WHEN** a send attempt for a confirmed entry fails
- **THEN** last_error SHALL be set, last_attempt_at SHALL be set, attempt_count SHALL increase by one, and the entry status SHALL remain "confirmed"

#### Scenario: Retry from the failed list

- **WHEN** an admin retries an entry shown in the failed list
- **THEN** the system SHALL re-run the send path for that entry, and on success SHALL set status to "sent", record sent_at, and clear last_error

##### Example: attempt_count progression

| event                | attempt_count | status    | last_error          |
| -------------------- | ------------- | --------- | ------------------- |
| before first send    | 0             | confirmed | (empty)             |
| after failed send    | 1             | confirmed | LINE API 400: ...   |
| after retry fails    | 2             | confirmed | LINE API 400: ...   |
| after retry succeeds | 2             | sent      | (cleared)           |

### Requirement: Schedule And History CSV Export

The board SHALL allow exporting the currently listed entries — in either the upcoming-schedule view or the history view — to a CSV file. The CSV SHALL be encoded as UTF-8 with a byte-order mark so that spreadsheet software displays Chinese text correctly. The CSV SHALL include the columns scheduled_date, tenant_name, room, property_name, rule_key, status, sent_at, attempt_count, and last_error.

#### Scenario: Export current rows to CSV

- **WHEN** an admin exports the current schedule list
- **THEN** a UTF-8 byte-order-mark CSV file SHALL be produced containing one row per listed entry with the columns scheduled_date, tenant_name, room, property_name, rule_key, status, sent_at, attempt_count, and last_error

### Requirement: Per-Rule Auto-Confirmation

Each outreach rule SHALL carry an auto_confirm flag that defaults to false. During schedule recomputation, a newly inserted entry SHALL be created with status "confirmed" when its rule's auto_confirm is true, and with status "pending" otherwise. Auto-confirmation SHALL apply only to newly inserted entries and SHALL NOT overwrite any existing entry or any entry whose manually_edited flag is true. An auto-confirmed entry SHALL remain subject to the send-time suppression check and to the test-mode redirect.

#### Scenario: Auto-confirm rule creates confirmed entries

- **WHEN** recomputation inserts a new entry for a rule whose auto_confirm is true
- **THEN** the new entry SHALL be created with status "confirmed"

#### Scenario: Default rule still requires confirmation

- **WHEN** recomputation inserts a new entry for a rule whose auto_confirm is false
- **THEN** the new entry SHALL be created with status "pending" and SHALL NOT be dispatched until an admin confirms it

#### Scenario: Auto-confirm does not bypass test mode

- **WHEN** a test recipient is configured and an auto-confirmed entry becomes due
- **THEN** the send SHALL be redirected to the test recipient and the tenant SHALL NOT receive it

##### Example: initial status by auto_confirm

| rule auto_confirm | new entry status |
| ----------------- | ---------------- |
| true              | confirmed        |
| false             | pending          |

### Requirement: Send Outcome Statistics

The system SHALL provide aggregate send statistics grouped by month over a configurable number of recent months. For each month the statistics SHALL count entries by status (sent, suppressed, failed, pending, confirmed, skipped), bucketed by sent_at when present and otherwise by last_attempt_at. A failed entry SHALL be defined as an entry whose status is not "sent" AND whose attempt_count is greater than zero AND whose last_error is non-empty. The statistics SHALL compute a failed ratio equal to failed divided by the sum of sent and failed, and SHALL set a warning flag on a month whose failed ratio exceeds a configured threshold (default 20%).

#### Scenario: Monthly counts and failed-ratio warning

- **WHEN** an admin opens the statistics view for the recent months
- **THEN** each month SHALL show counts by status, and a warning flag SHALL be set on any month whose failed ratio exceeds the configured threshold

##### Example: failed ratio and warning

| month   | sent | failed | ratio | warn (threshold 20%) |
| ------- | ---- | ------ | ----- | -------------------- |
| 2026-05 | 90   | 10     | 0.10  | false                |
| 2026-06 | 60   | 40     | 0.40  | true                 |

### Requirement: Interactive Card Feedback via Link

The card's two interactive buttons SHALL be LINE link (URI) actions that open a feedback page hosted by this system, carrying the originating schedule entry's identifier as an unguessable token. They SHALL NOT use LINE postback or any LINE inbound webhook, so the flow does not depend on which service owns the LINE channel webhook. The positive button SHALL record a "satisfied" feedback entry to Ragic and show a thank-you page. The help button SHALL open an admin-editable short survey (multi-select dissatisfaction items plus an optional note); on submit the system SHALL record a "needs help" feedback entry to Ragic AND send a LINE notification to every recipient id configured in admin settings (comma-separated). Ragic writes SHALL set the contract number with link-load enabled (doLinkLoad) so Ragic auto-fills the tenant phone, name, and room, plus card type, send date, reply time, feedback type, dissatisfaction items, and note.

#### Scenario: Tenant taps the positive button

- **WHEN** a tenant taps the "satisfied" button
- **THEN** the system SHALL write a feedback entry to Ragic with feedback type "satisfied" (tenant phone, name, and room auto-filled from the contract number via link-load) and SHALL show a thank-you page, and SHALL NOT send any staff notification

#### Scenario: Tenant asks for help and submits the survey

- **WHEN** a tenant taps the "needs help" button, selects dissatisfaction items, and submits
- **THEN** the system SHALL write a feedback entry to Ragic with feedback type "needs help" plus the selected items and note, AND SHALL send a LINE notification to each configured recipient id

#### Scenario: Survey content and recipients are admin-editable

- **WHEN** an admin edits the survey items or the notification recipient ids in settings
- **THEN** subsequent feedback pages SHALL use the updated survey and subsequent notifications SHALL be sent to the updated recipient ids

#### Scenario: Unknown or missing token

- **WHEN** the feedback link carries no token matching an existing schedule entry
- **THEN** the system SHALL show a generic thank-you page and SHALL NOT write a feedback entry
