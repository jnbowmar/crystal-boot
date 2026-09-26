-- M4: private leagues, paid for in Pi.
--
-- An order is made before the Pi payment starts; its id goes into the
-- payment's metadata. Nothing is delivered until Pi's /complete returns 200
-- and Pi's own record shows a verified transaction (see payments.ts).

CREATE TABLE orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  kind        TEXT NOT NULL CHECK (kind IN ('league')),
  amount      REAL NOT NULL,          -- Pi
  memo        TEXT NOT NULL,
  payload     TEXT NOT NULL,          -- JSON, e.g. {"name": "Office league"}
  -- pending: created. paying: bound to a Pi payment and approved.
  -- completed: Pi confirmed, item delivered. cancelled: no transaction was made.
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'paying', 'completed', 'cancelled')),
  payment_id  TEXT UNIQUE,
  txid        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX orders_user ON orders (user_id, created_at);

CREATE TABLE leagues (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id    TEXT NOT NULL REFERENCES users (id),
  order_id    TEXT UNIQUE REFERENCES orders (id), -- one league per paid order
  created_at  INTEGER NOT NULL
);

CREATE TABLE league_members (
  league_id  TEXT NOT NULL REFERENCES leagues (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX league_members_user ON league_members (user_id);
