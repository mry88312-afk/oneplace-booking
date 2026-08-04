## ADDED Requirements

### Requirement: Define rich menus and tappable areas as data

The system SHALL store rich menu definitions in Supabase as the source of truth, including menu metadata, the source image asset, and the tappable areas. Each area SHALL carry bounds and an action whose type is one of uri or richmenuswitch.

#### Scenario: Create a rich menu with tappable areas

- **WHEN** an administrator creates a rich menu with a name, a size, an image asset, and one or more areas using uri or richmenuswitch actions
- **THEN** the system persists the menu and its areas and marks the menu as draft

#### Scenario: Reject an unsupported area action type

- **WHEN** an administrator defines an area with an action type other than uri or richmenuswitch
- **THEN** the system rejects the definition and names the unsupported action type

### Requirement: Publish a rich menu to LINE idempotently

The system SHALL publish a stored rich menu to LINE by creating the menu via the Messaging API, uploading its image bytes from the hosted public URL, and pointing the menu's stable alias at the newly created LINE rich menu id. Re-publishing SHALL repoint the alias to the new menu and remove the superseded menu so no orphan remains.

#### Scenario: First publish creates and aliases the menu

- **WHEN** an administrator publishes a draft rich menu
- **THEN** the system creates the menu on LINE, uploads its image, points the alias at the new LINE rich menu id, records the id, and marks the menu published

#### Scenario: Re-publish repoints alias and removes the old menu

- **WHEN** an administrator edits a published menu and publishes again
- **THEN** the system creates a new LINE rich menu, repoints the alias to it, and deletes the previously published LINE rich menu
- **AND** no orphan rich menu tracked by that alias remains on LINE

#### Scenario: Publish surfaces LINE failures

- **WHEN** the LINE API returns an error during publish
- **THEN** the system surfaces an error containing the HTTP status and message, retains the previously working menu, and allows retry

### Requirement: Multi-page switching via alias and richmenuswitch

The system SHALL support multi-page rich menus where an area on one page switches the displayed menu to another page using a richmenuswitch action that references the target page's alias.

#### Scenario: Tapping a switch area changes the displayed page

- **WHEN** a user taps an area whose action is richmenuswitch referencing another page's alias
- **THEN** the displayed rich menu changes to the referenced page without a server round-trip

##### Example: two-page switch

- **GIVEN** menu A has a switch area referencing alias "menu-b", and menu B has a switch area referencing alias "menu-a"
- **WHEN** a user on page A taps the switch area, then taps the switch area on page B
- **THEN** the user sees page B, then returns to page A

### Requirement: Default menu and per-tenant assignment

The system SHALL set a default rich menu shown to users, and SHALL assign a specific rich menu to an individual tenant identified by LINE UID, overriding the default for that tenant.

#### Scenario: Set a default menu

- **WHEN** an administrator marks a published menu as default
- **THEN** the system sets it as the default rich menu on LINE for users without a specific assignment

#### Scenario: Assign a menu to one tenant

- **WHEN** an administrator assigns a published menu to a tenant UID
- **THEN** the system links that menu to the tenant on LINE, and that tenant sees the assigned menu instead of the default

### Requirement: Preview the menu payload before publishing

The system SHALL return the exact rich menu payload that would be sent to LINE so an administrator can review it before publishing.

#### Scenario: Preview returns the payload

- **WHEN** an administrator requests a preview of a stored rich menu
- **THEN** the system returns the LINE rich menu JSON containing size, areas, and actions without creating anything on LINE

### Requirement: Management and publish operations require administrator authorization

The system SHALL require valid administrator credentials for all rich menu create, update, delete, publish, assignment, and reconcile operations.

#### Scenario: Unauthorized publish is rejected

- **WHEN** a request to publish or modify a rich menu lacks valid admin credentials
- **THEN** the system rejects it and makes no change on LINE or in the database

### Requirement: Reconcile removes orphan rich menus

The system SHALL provide a reconcile operation that compares rich menus on LINE against those tracked in the database and removes LINE rich menus that the database no longer tracks.

#### Scenario: Reconcile deletes untracked menus

- **WHEN** an administrator runs reconcile and LINE has rich menus not referenced by any tracked alias or menu record
- **THEN** the system deletes those untracked LINE rich menus and reports what was removed
