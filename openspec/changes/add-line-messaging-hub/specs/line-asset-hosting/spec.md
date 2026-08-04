## ADDED Requirements

### Requirement: Image upload to managed public storage

The system SHALL provide an endpoint that accepts a PNG or JPEG image and stores it in a Supabase Storage public bucket, returning a stable public URL and persisting an asset record that captures the bucket path, public URL, kind, and dimensions.

#### Scenario: Successful upload returns a stable public URL

- **WHEN** an administrator uploads a PNG or JPEG image with valid admin credentials
- **THEN** the system stores the file in the public bucket, inserts an asset record, and returns a JSON object containing the asset id and a public URL
- **AND** the returned URL renders the image when used as a LINE Flex message image source

#### Scenario: Public URL persists across redeploys

- **WHEN** the server is redeployed after an image was uploaded
- **THEN** the previously returned public URL still resolves to the same image

### Requirement: Upload endpoint requires administrator authorization

The system SHALL reject any upload request that does not present valid administrator credentials, and SHALL store nothing for rejected requests.

#### Scenario: Unauthorized upload is rejected

- **WHEN** a request reaches the upload endpoint without valid admin credentials
- **THEN** the system responds with an authorization error and persists no file or asset record

### Requirement: Uploaded assets are listable for reuse

The system SHALL expose the tracked assets so an administrator can reuse an existing image without re-uploading it.

#### Scenario: List returns previously uploaded assets

- **WHEN** an administrator requests the asset list
- **THEN** the system returns the previously uploaded assets with their public URLs and kinds
