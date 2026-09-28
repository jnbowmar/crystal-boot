-- Banker: once a week, one pick counts double. banker_week is the week key
-- (the day number of the Tuesday that starts the week, see weekKey() in
-- scoring.ts) when the pick is the player's banker, and null otherwise.
-- picks.points stores the doubled score for a banker, so tables and averages
-- need no special case.
ALTER TABLE picks ADD COLUMN banker_week INTEGER;
CREATE UNIQUE INDEX picks_banker ON picks (user_id, banker_week) WHERE banker_week IS NOT NULL;
