CREATE TABLE schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE otp_codes (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL COLLATE NOCASE,
  code_hash       TEXT NOT NULL,
  link_token_hash TEXT,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT
);
CREATE INDEX otp_email ON otp_codes(email);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE auth_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  key     TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX auth_events_key_at ON auth_events(kind, key, at);

CREATE TABLE plans (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  pin                TEXT NOT NULL,
  title              TEXT NOT NULL,
  doc                TEXT NOT NULL,
  server_rev         INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  UNIQUE (user_id, pin)
);
CREATE INDEX plans_user ON plans(user_id);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  kind        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  disk_path   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE webauthn_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL,
  transports    TEXT
);
