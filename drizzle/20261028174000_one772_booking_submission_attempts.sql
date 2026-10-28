-- ONE-772: apply to the VERIFIED booking database before merging/deploying code.
-- No existing booking/Ragic/Calendar rows are changed. Never expire a pending attempt.
CREATE TABLE IF NOT EXISTS booking_submission_attempts (
  request_key VARCHAR(64) NOT NULL PRIMARY KEY,
  payload_hash VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL,
  ragic_record_id VARCHAR(64) NULL,
  booking_id INT NULL,
  failure_stage VARCHAR(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
