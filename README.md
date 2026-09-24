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

## Run the tests

```bash
npm install
npm test
```

The suite includes a 693-case parity check against the Python Brier function I already use to score my own Fed forecasts. `scripts/parity.py` generated the fixture in `src/scoring/__fixtures__/`. It reads that private scorer, so the committed fixture is what CI checks against.

## Status

| Milestone | What | State |
|---|---|---|
| M0 | Base rates and kickoff timezones from openfootball | done |
| M1 | Scoring module and tests | done |
| M2 | Cloudflare Worker, D1 database, scheduled settlement | next |
| M3 | React pick flow and Pi sign-in in the Pi Browser | |
| M4 | Private leagues paid in testnet Pi | |
| M5 | Hackathon submission | |

## Data

Fixtures and results come from [openfootball/football.json](https://github.com/openfootball/football.json), which is public domain (CC0). The app shows team names only, since crests, photos and player data are licensed.

## License

MIT
