CREATE TABLE IF NOT EXISTS mail_stats_daily (
  day_key TEXT PRIMARY KEY,
  received_count INTEGER NOT NULL DEFAULT 0
);
