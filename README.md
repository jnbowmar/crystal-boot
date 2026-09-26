# Crystal Boot

[![test](https://github.com/jnbowmar/crystal-boot/actions/workflows/test.yml/badge.svg)](https://github.com/jnbowmar/crystal-boot/actions/workflows/test.yml)

A free football forecasting league for the Pi Browser. For each match you give a probability for a home win, a draw and an away win. After full time you're scored on how close you were, and you climb leaderboards against the crowd, your country and your friends.

It's free to play and there's no wagering. Pi pays only for extras that have nothing to do with results, like creating a private league or a season stats pack. Pi never pays out on a match.

Built for the monthly #PiHackathon, targeting November 2026. The full design is in [SPEC.md](SPEC.md).

## How scoring works

A pick is three whole percentages that add up to 100, like `{H: 65, D: 15, A: 20}`. The two-tap version picks an outcome and a confidence level (50, 65, 80 or 95%), then splits what's left between the other two outcomes by the league's historical base rates.

Each pick gets a three-outcome Brier score, which runs from 0 (perfect) to 2 (a 100% pick on the wrong result). Players see it as points:

```
points = round(100 - 50 × brier)
```

For Arsenal 3-0 Coventry:

| Pick (H/D/A) | Brier | Points |
|---|---|---|
| 95 / 2 / 3 | 0.0038 | 100 |
| 33 / 33 / 34 | 0.6734 | 66 |
| 5 / 15 / 80 | 1.565 | 22 |

A confident wrong pick costs the most, so calibration beats bravado. Leaderboards rank by average points with a minimum pick count, so skipping the hard matches doesn't help.

A small detail I liked: with whole percentages the raw score can never land on exactly .5, so rounding is never a judgment call. The proof is a comment in [`scoring.ts`](src/scoring/scoring.ts), and a test checks every possible pick.

## Base rates

From five finished seasons (2021-22 to 2025-26) of [openfootball](https://github.com/openfootball/football.json) data:

| League | Matches | Home | Draw | Away |
|---|---|---|---|---|
| Premier League | 1,900 | 44.2% | 23.9% | 31.9% |
| La Liga | 1,890 | 45.8% | 26.1% | 28.1% |

Reproduce with `python3 m0/base_rates.py`.

## The app

A React app (Vite + TypeScript) in [`web/`](web/), built for a 375px phone screen in the Pi Browser. You make a pick in two taps: choose Home, Draw or Away, then how sure you are. There's also an exact-percentage mode with three linked sliders. Before you save, it shows how many points you'd get for each result. Kickoff times show in your own timezone. It imports the same `scoring.ts` as the Worker, so its preview can't disagree with how a pick is actually scored.

Sign-in is Pi only. The app calls `Pi.authenticate(['username'])` and sends the access token to `POST /api/auth`. The Worker checks it against Pi's `/v2/me`, which is the source of truth, and returns its own 30-day session token. Only a SHA-256 hash of that token is stored.

## The backend

A Cloudflare Worker with a D1 (SQLite) database, in [`src/worker/`](src/worker/). It also serves the built app as static files, with `/api/*` going to the Worker. Every 6 hours a cron job pulls the openfootball feeds, upserts matches, settles the ones that have a score and scores their picks. Each step is a single SQL statement, so a run takes a handful of D1 queries however many picks there are.

| Route | What |
|---|---|
| `POST /api/auth` | `{accessToken}` from `Pi.authenticate` → session token |
| `GET /api/matches?league=en.1&from=&to=` | Fixtures with status, result, crowd forecast and your pick |
| `POST /api/picks` | `{matchId, pick: {H, D, A}}` or two-tap `{matchId, outcome, confidence}`. Refused from kickoff on |
| `GET /api/picks` | Your picks and points |
| `GET /api/leaderboard?league=all&period=week\|season&date=` | Average points, minimum pick count applies, plus your own line |
| `POST /api/admin/sync`, `POST /api/admin/score` | Run the cron now; enter a result by hand (bearer `ADMIN_TOKEN`) |

With `FAKE_USERS=1`, an `X-Fake-User: <name>` header works in place of Pi sign-in, and the sign-in screen offers a test-player box. That setting is for dev and testnet only.

Run it locally:

```bash
echo "ADMIN_TOKEN=dev-admin" > .dev.vars
npm run db:migrate:local
npm run dev                                   # builds the app, serves everything on http://localhost:8787
curl -X POST "localhost:8787/cdn-cgi/handler/scheduled?cron=0+*/6+*+*+*"   # run the cron once
```

For live reload while working on the app, also run `npm run dev:web` (Vite on :5173, proxying `/api` to :8787).

To deploy: `npx wrangler d1 create crystal-boot`, put the id in `wrangler.jsonc`, then `npm run db:migrate:remote`, `npx wrangler secret put ADMIN_TOKEN` and `npm run deploy`. To try it in the Pi sandbox, open `develop.pi` in the Pi Browser, register the app, set its development URL to the deployed Worker, and open the sandbox URL the portal gives you (see [Pi's docs](https://github.com/pi-apps/pi-platform-docs)).

## Run the tests

```bash
npm install
npm test
```

The app tests render the real React app on jsdom, wired straight into the Worker's handler and SQL, with only Pi stubbed. They cover sign-in, a two-tap pick, an exact pick, locking at kickoff, an expired session and test players.

The Worker tests run the real SQL and migrations on `node:sqlite`, against snapshots of the live 2026-27 feeds. They replay the weekend of 18-20 September: a dozen fake players pick all 20 matches, then the next sync settles them, and every pick's points, every crowd forecast and the weekly leaderboard must match `scoring.ts` exactly. Another test checks the SQL points formula against `points()` for every possible pick.

The suite also includes a 693-case parity check against the Python Brier function I already use to score my own Fed forecasts. `scripts/parity.py` generated the fixture in `src/scoring/__fixtures__/`. It reads that private scorer, so the committed fixture is what CI checks against.

## Status

| Milestone | What | State |
|---|---|---|
| M0 | Base rates and kickoff timezones from openfootball | done |
| M1 | Scoring module and tests | done |
| M2 | Cloudflare Worker, D1 database, scheduled settlement | done (runs locally; not deployed yet) |
| M3 | React pick flow and Pi sign-in in the Pi Browser | built; waiting on a Pi sandbox test |
| M4 | Private leagues paid in testnet Pi | |
| M5 | Hackathon submission | |

## Data

Fixtures and results come from [openfootball/football.json](https://github.com/openfootball/football.json), which is public domain (CC0). The app shows team names only, since crests, photos and player data are licensed.

## License

MIT
