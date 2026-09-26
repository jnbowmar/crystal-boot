-- M3: our own session tokens, issued after a Pi access token checks out
-- against the Platform API's /v2/me. Only a SHA-256 of the token is stored.

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
