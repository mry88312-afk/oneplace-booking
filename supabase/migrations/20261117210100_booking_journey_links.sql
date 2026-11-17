BEGIN;
CREATE TABLE booking.journey_links (
  id uuid PRIMARY KEY,
  line_uid text NOT NULL CHECK(line_uid ~ '^U[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journey_links_created_idx ON booking.journey_links(created_at);
ALTER TABLE booking.journey_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking.journey_links FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON booking.journey_links TO oneplace_booking;
CREATE POLICY booking_backend ON booking.journey_links TO oneplace_booking USING(true) WITH CHECK(true);
COMMIT;
