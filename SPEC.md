# Crystal Boot — spec

**Name: Crystal Boot** (was working name Forecast League; screened 2026-09-23, see open question 4). Written 2026-09-23. **Not started; queued behind Nimiq Cycle III (submission Oct 30). Target: November build for the monthly #PiHackathon.**

## One line

A free football forecasting game: for each match you say how likely a home win, draw or away win is, get scored on accuracy, and climb leaderboards with friends. Pi pays for leagues, stats and status. **Nobody wins or loses Pi on a result.**

## Why this one

- **Audience fit.** Pi's user base is heavily Nigeria, Vietnam, the Philippines, Indonesia and India, all football-first. The club season runs Aug–May, so there are matches to forecast every week.
- **It's your edge.** It's the same scoring as `~/Claude/fed_calls/score.py` (Brier), the same concepts as Foresight, and a live demo for *Prediction Markets for Regular People*.
- **Pi KYC is a feature.** Pi usernames belong to verified humans, so "one person, one account" (the usual cheat in prediction games) comes free.
- **It's a real backend build:** auth, a database, scheduled settlement, payments. That's the developer-growth step up from Premium Scan.
- **Portable.** One backend, with the Pi front end first and a Nimiq mini-app front end later if wanted.

## The gambling line (non-negotiable)

- Pi goes **in** only for things unrelated to how a match turns out: creating a private league, a stats pack, cosmetic badges.
- Pi **never** comes out based on results. No prize pools, no paid entries into anything with a payout, no "stake Pi on your pick."
- No bookmaker odds, no betting links or affiliate deals, no "tips" language.
- Say it on screen: "Free to play. No wagering. Scores are for bragging rights."

## Gameplay

**Pick flow (mobile, two taps):**
1. Tap an outcome: **Home / Draw / Away**.
2. Tap a confidence level: **Lean 50% · Likely 65% · Confident 80% · Lock 95%**. The remaining probability splits between the other two outcomes in base-rate proportion.
3. Optional "Advanced": drag a three-way slider for exact probabilities.

Picks **lock at kickoff** using server time, and can be changed until then.

**Scoring per match** (three-outcome Brier, turned into points so bigger is better):

```
brier = Σ over {H, D, A} of (p_outcome − actual_outcome)²     # 0 (perfect) … 2 (worst)
points = round(100 − 50 × brier)                              # 100 perfect, 67 for a lazy 1/3-1/3-1/3, 0 worst
```

- **Picks are stored as whole percentages summing to 100** (`{H: 65, D: 15, A: 20}`). Points are computed in integer math, and with whole percentages a score can never land on exactly .5, so rounding is never ambiguous (proof in `scoring.ts`). A "lazy" 33/33/34 scores 66 or 67 depending on which outcome got the 34.
- **Worked example (Arsenal 3-0 Coventry):** Lock on Arsenal `95/2/3` → Brier 0.0038 → **100**. No opinion `33/33/34` → 0.6734 → **66**. Confident Coventry `5/15/80` → 1.565 → **22**.
- A confident wrong pick hurts. That's the lesson of the game and the book: calibration beats bravado.
- No pick = no score, not zero. Leaderboards rank by **average points with a minimum pick count** (e.g. ≥ 10 picks for the week, ≥ 50 for the season), so skipping hard matches doesn't win.

**Baselines shown next to your score (what makes it feel smart):**
- **Crowd:** the average probability of all app users on that match, frozen at kickoff. "You beat the crowd on 7 of 10."
- **Base rate:** a home/draw/away split calculated from the league's openfootball history. A flat 45/27/28 is only a placeholder until M0 computes the real one.
- No bookmaker odds (licensing, plus the gambling line).

**Leagues:**
- **Global:** per competition and overall, weekly plus season.
- **Country:** from the Pi profile if available, otherwise self-chosen. "Top forecaster in Nigeria" is the status hook.
- **Private:** invite code, friends or office or WhatsApp group. **Creating one costs Pi**, and joining is free.

## Data

**Fixtures + results:** [openfootball/football.json](https://github.com/openfootball/football.json), **CC0 public domain**, no key, CORS open (verified 2026-09-23).

```
https://raw.githubusercontent.com/openfootball/football.json/master/2026-27/en.1.json
{ "name": "English Premier League 2026/27", "matches": [
  { "round": "Matchday 1", "date": "2026-08-21", "time": "20:00",
    "team1": "Arsenal FC", "team2": "Coventry City FC",
    "score": { "ht": [2,0], "ft": [3,0] } } ] }
```

- **2026-27 coverage:** EPL (`en.1`), Championship (`en.2`), Bundesliga (`de.1`), La Liga (`es.1`), Ligue 1 (`fr.1`), Serie A (`it.1`), Eredivisie (`nl.1`), Primeira Liga (`pt.1`). **v1 = EPL + La Liga** (the biggest global following), add the rest once it works.
- **Not included:** Champions League, African/Asian leagues, internationals. For international tournaments (e.g. AFCON) check the calendar-year folders (`2026/`) or add fixtures manually.
- **Result lag ~1–2 days** (results through 9/20 were pushed 9/22). Settlement is "within 48h," with an admin override to enter a score by hand.
- **Kickoff times look local (e.g. "20:00") with no timezone field.** M0 must pin a timezone per league, because pick locking depends on it. If that's unreliable, lock at a conservative time (e.g. the start of match day, UTC).
- **Match ID** = `league|date|team1|team2`, since openfootball has no IDs.
- No player data, crests or photos (licensed). Team names as text only.

## Pi payments (the only money)

| Item | Price (placeholder) | Why someone pays |
|---|---|---|
| Create a private league | 5 Pi | Bragging rights with your group |
| Season stats pack | 3 Pi | Calibration chart ("when you say 80%, you're right 71%"), best/worst teams to call, streaks |
| Profile badge / flair | 1 Pi | Status on leaderboards |

Same flow as the Unlock Calendar: `Pi.createPayment` → Worker `/approve` → user signs → Worker `/complete` → unlock only after a 200. `onIncompletePaymentFound` resumes on next load. Testnet sandbox first.

## Architecture

```
Pi Browser ── React app (Vite + TS, Premium Scan stack)
   │  Pi.authenticate(['username','payments'])  → accessToken
   ▼
Cloudflare Worker (API)
   ├─ verify accessToken with Pi Platform API GET /v2/me → uid, username
   ├─ D1 (SQLite): users, matches, picks, leagues, league_members, payments, entitlements
   ├─ POST /picks   (rejects after lock time; server clock is the only clock)
   ├─ GET  /leaderboard?scope=global|country|league:<id>&period=week|season
   ├─ POST /approve, /complete  (Pi payments, PI_API_KEY secret)
   └─ Cron trigger every 6h: pull openfootball JSON → upsert matches → settle finished ones → score picks
```

- **Storage:** Pi `uid` + username, picks and league membership. No email, no wallet address, and no ads SDK for v1. A privacy page goes up before launch.
- **Scoring code:** a pure TS module (`scoring.ts`), unit-tested against a port of `fed_calls/score.py`'s `brier()` extended to three outcomes, the same parity-test pattern as Premium Scan.

## Milestones

| # | What | Proof |
|---|---|---|
| M0 | ~~Data spike~~ **DONE 2026-09-23**, see "M0 results" below | `m0/base_rates.py` |
| M1 | ~~`scoring.ts` + tests~~ **DONE 2026-09-23**: `src/scoring/scoring.ts`, 21 vitest tests incl. 693-case parity with `fed_calls/score.py` (`npm test`, `npm run parity`) | green tests, including a worked example |
| M2 | Worker + D1 + cron settlement, no auth (fake users) | matches from 9/20 settle and score correctly |
| M3 | React pick flow at 375px + Pi auth in the Pi Browser sandbox | James makes real picks for next weekend's EPL |
| M4 | Private leagues + testnet Pi payment for creating one | full approve→sign→complete loop, cancel handled |
| M5 | #PiHackathon entry: video, README, public repo (PiOS or MIT) | submitted by the last day of the month |

## M0 results (2026-09-23)

**Base rates, 5 finished seasons 2021-22 to 2025-26** (`python3 m0/base_rates.py`):

| League | Matches | Home | Draw | Away |
|---|---|---|---|---|
| EPL (`en.1`) | 1,900 | 44.2% | 23.9% | 31.9% |
| La Liga (`es.1`) | 1,890 | 45.8% | 26.1% | 28.1% |

These replace the 45/27/28 placeholder. The confidence-level split uses the league's row.

**Timezones.** Kickoff times are local to the league: EPL times (12:30, 15:00, 17:30, 20:00) = `Europe/London`; La Liga (14:00 to 21:30) = `Europe/Madrid`. Pin per league in config and convert with a real tz library so the BST/CET clock changes are handled.

**Gotchas found:**
- **La Liga times are mostly blank.** 290 of 380 2026-27 matches have `time: null` because La Liga announces kickoffs a few weeks out. Rule: when time is null, lock at 00:00 league-local on the match date; tighten the lock when a later cron pull brings the time.
- **Score format changes by season.** Usually `score: {ft: [h, a]}`, but 2025-26 EPL uses a bare `score: [h, a]`. The parser handles both (`full_time()` in `m0/base_rates.py`); port it to TS.
- **Gaps happen.** La Liga 2024-25 has only 370 of 380 results. Settlement must tolerate a match that never gets a score (admin override, or void after N days).
- **2026-27 status on 9/23:** EPL 45 settled, La Liga 64, both through 2026-09-20. Enough live data for M2.

## Open questions

1. ~~Pi's developer terms on prediction/sports apps.~~ **CHECKED 2026-09-23: allowed as designed.** No rule bans sports or forecasting apps. The one hard rule is in the App Studio Community Guidelines: no "offering or facilitating gambling, betting, or lottery-related services involving Pi tokens, either directly or indirectly." The Developer Terms (2023-01-09) and the main ToS (2025-02-19) say nothing about gambling. Our design has Pi in only for non-outcome extras and never out on results, so it clears the rule. "Indirectly" means never adding performance-linked Pi tips, rewards or prizes later either. Other rules that apply:
   - **Don't talk about Pi's value.** The guidelines ban "material discussions, representations or misrepresentations regarding the value or valuation of Pi." So there are **no USD prices anywhere in the app**, and prices are in Pi only.
   - **Mainnet listing requirements:** the developer must be KYC'd; **Pi login only** (no email or other sign-in); **Pi-only transactions** (a Nimiq/USDT version has to be a separate deployment); **no external redirects** (fetch openfootball server-side, no links out to match sites); minimal data; **the domain can't start with "pi"** and can't use Pi's logo or colors.
2. Does `Pi.authenticate` expose country? If not, users choose it themselves (and could lie about it; fine for v1).
3. ~~The openfootball timezone question.~~ **Settled in M0** (see above).
4. ~~Name.~~ **Crystal Boot, screened 2026-09-23 (not legal clearance):** USPTO: no live or dead mark for CRYSTAL BOOT or CRYSTALBOOT (relevance-ranked search surfaced only single-word BOOT/CRYSTAL marks). App Store: no app by that name. Web: no football product, just crystal trophies. crystalboot.com is registered (GoDaddy, to 2028) to a dead Shopify store; **crystalboot.app and crystalbootfc.com are open**. YouTube @crystalboot and TikTok @crystalboot are taken by unrelated people; **@crystalbootfc is free on YouTube, TikTok and GitHub** (X and Instagram hide behind a login, so check those by hand). Pundit FC was rejected: a football prediction app called "PunditFC" already exists, plus Pundit (punditapp.uk) and The Pundit.
5. Does a free league with Pi-paid extras need a Nimiq version at all, or is that just scope creep? Decide after M5.

## Not doing

- Wagering in any form (see the gambling line).
- Player stats, fantasy, crests or photos (licensing).
- Bookmaker odds or affiliate links.
- Buying PI. Revenue is earned Pi only.
