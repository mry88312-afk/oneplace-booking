## ADDED Requirements

### Requirement: Phone-Not-Found Self Registration

When phone verification on the public booking page finds no tenant record, the page SHALL offer the user the existing registration view instead of only showing an error message. The registration form SHALL collect name, phone, move-in address, and room number. On successful registration the user SHALL continue the original booking flow without restarting, and when a LINE UID is available in the session it SHALL be stored with the new record.

#### Scenario: Unknown phone leads to registration and booking continues

- **WHEN** a user enters a phone that matches no tenant record
- **THEN** the page SHALL present the registration view with fields name, phone, move-in address, and room number, and after submitting the user SHALL proceed to slot selection of the same booking flow

#### Scenario: LINE UID captured on registration

- **WHEN** the registering user opened the page inside LINE and a UID is available
- **THEN** the new record SHALL include that UID so the tenant is bound from day one
