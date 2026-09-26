-- M2 schema: users, matches, picks. Leagues, payments and entitlements come in M4.
-- Times are ms since epoch (UTC), from the server clock.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,        -- 'pi:<uid>', or 'fake:<username>' in dev
  -- Not unique: a fake dev user and a Pi user can share a name.
  username   TEXT NOT NULL,
  country    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE matches (
  id           TEXT PRIMARY KEY,      -- league|season|home|away
  league       TEXT NOT NULL,
  season       TEXT NOT NULL,
  round        TEXT,
  home         TEXT NOT NULL,
  away         TEXT NOT NULL,
  date         TEXT NOT NULL,         -- league-local YYYY-MM-DD
  time         TEXT,                  -- league-local HH:MM, null until announced
  kickoff_at   INTEGER NOT NULL,      -- picks lock here
  home_goals   INTEGER,
  away_goals   INTEGER,
  score_source TEXT CHECK (score_source IN ('feed', 'admin')),
  status       TEXT NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'settled', 'void')),
  result       TEXT CHECK (result IN ('H', 'D', 'A')),
  -- Crowd forecast (mean of all picks, fractional percentages), fixed at settlement.
  crowd_h      REAL,
  crowd_d      REAL,
  crowd_a      REAL,
  crowd_n      INTEGER,
  settled_at   INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX matches_league_kickoff ON matches (league, kickoff_at);
CREATE INDEX matches_status ON matches (status);

CREATE TABLE picks (
  user_id    TEXT NOT NULL REFERENCES users (id),
  match_id   TEXT NOT NULL REFERENCES matches (id),
  h          INTEGER NOT NULL CHECK (h BETWEEN 0 AND 100),
  d          INTEGER NOT NULL CHECK (d BETWEEN 0 AND 100),
  a          INTEGER NOT NULL CHECK (a BETWEEN 0 AND 100),
  points     INTEGER,                 -- null until the match settles
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id),
  CHECK (h + d + a = 100)
);
CREATE INDEX picks_match ON picks (match_id);
