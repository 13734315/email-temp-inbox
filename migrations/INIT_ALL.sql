CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  box TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_box_created
ON emails(box, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_emails_expires_at
ON emails(expires_at);

ALTER TABLE emails ADD COLUMN html_content TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS mail_stats_daily (
  day_key TEXT PRIMARY KEY,
  received_count INTEGER NOT NULL DEFAULT 0
);
