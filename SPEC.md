# Crystal Boot — spec

**Name: Crystal Boot** (was working name Forecast League; screened 2026-09-23, see open question 4). Written 2026-09-23. **Target: the November 2026 #PiHackathon.**

## One line

A free football forecasting game: for each match you say how likely a home win, draw or away win is, get scored on accuracy, and climb leaderboards with friends. Pi pays for leagues, stats and status. **Nobody wins or loses Pi on a result.**

## Why this one

- **Audience fit.** Pi's user base is heavily Nigeria, Vietnam, the Philippines, Indonesia and India, all football-first. The club season runs Aug–May, so there are matches to forecast every week.
- **Proper scoring.** The Brier score is what professional forecasters are judged on, so the game rewards calibration rather than lucky streaks.
- **Pi KYC is a feature.** Pi usernames belong to verified humans, so "one person, one account" (the usual cheat in prediction games) comes free.
- **A real backend:** auth, a database, scheduled settlement and payments.
- **Portable.** One backend, with the Pi front end first and other front ends later if wanted.

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

**Price against mining, not dollars (2026-09-23).** Base mining is ~0.0023 Pi/hr = ~0.055 Pi/day = ~20 Pi/yr, so 5 Pi is ~90 days of a typical pioneer's mining. Re-price before M4 in the range of 0.5 Pi (league) / 0.3 Pi (stats pack) / 0.1 Pi (badge), and check current mining rates when M4 starts.

Pi's standard flow: `Pi.createPayment` → Worker `/approve` → user signs → Worker `/complete` → unlock only after a 200. `onIncompletePaymentFound` resumes on next load. Testnet sandbox first.

## Architecture

```
Pi Browser ── React app (Vite + TS)
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
- **Scoring code:** a pure TS module (`scoring.ts`), unit-tested against an existing Python Brier scorer extended to three outcomes (a parity test).

## Milestones

| # | What | Proof |
|---|---|---|
| M0 | ~~Data spike~~ **DONE 2026-09-23**, see "M0 results" below | `m0/base_rates.py` |
| M1 | ~~`scoring.ts` + tests~~ **DONE 2026-09-23**: `src/scoring/scoring.ts`, 21 vitest tests incl. 693-case parity with a Python Brier scorer (`npm test`, `npm run parity`) | green tests, including a worked example |
| M2 | ~~Worker + D1 + cron settlement, no auth (fake users)~~ **DONE 2026-09-26**, see "M2 results" below. Runs locally; deploying needs a Cloudflare account | matches from 9/20 settle and score correctly |
| M3 | React pick flow at 375px + Pi auth in the Pi Browser sandbox. **Built 2026-09-26**, see "M3 results"; the proof needs a deploy and the Pi sandbox | James makes real picks for next weekend's EPL (10/10 at the earliest) |
| M4 | Private leagues + testnet Pi payment for creating one. **Built 2026-09-26**, see "M4 results"; the real-Pi run needs the sandbox | full approve→sign→complete loop, cancel handled |
| M5 | #PiHackathon entry: video, README, public repo (MIT, decided 2026-09-23). **In progress 2026-09-26**, checklist in `docs/SUBMISSION.md` | submitted by the last day of the month |

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

## M2 results (2026-09-26)

`src/worker/` + `migrations/0001_init.sql`. The proof is `src/worker/settle.test.ts`: it replays the real feeds (snapshotted 9/26) as of Friday 9/18. Twelve fake users pick all 20 matches from 9/18 to 9/20, half two-tap and half exact. A sync on Tuesday 9/22 then settles them, and every pick's points, each crowd forecast and the week's leaderboard match `scoring.ts` exactly. `wrangler dev` against the live feed synced 380 + 380 fixtures and settled 119 (50 EPL, 69 La Liga), which is everything through 9/20.

**Decisions made in M2:**
- **Match ID is `league|season|home|away`, not `league|date|home|away`.** Each ordered pair meets once per league season, so the ID survives a reschedule; with the date in it, a postponed match would become a new match and orphan its picks. When a match moves, the lock moves with it, and picks stay editable until the new kickoff.
- **Void after 14 days without a result.** Voided picks don't count. If a score turns up later, the match settles normally.
- **Score corrections re-settle** only when the result (H/D/A) changes, since points depend on nothing else. A score that disappears from the feed is kept.
- **An admin score beats the feed for good** and can only be entered after kickoff.
- **Weeks run Tuesday 00:00 to Tuesday 00:00 UTC**, so Monday night matches count with their weekend.
- **Scoring runs in SQL** (`POINTS_SQL`), one statement per cron run, because D1 caps queries per invocation. A test checks it against `points()` on all 5,151 picks × 3 results.
- **Timezones use `Intl`** (the runtime's tz database), not a date library. Tests cover the BST/CET changes.

**Found in the feed:** every bare `score: [h, a]` in 2026-27 (5 EPL, 5 La Liga) is a 0-0 with no half-time score. **No EPL matches between 9/20 and 10/10**, so M3's "next weekend's EPL" is 10/10 at the earliest (La Liga plays in between).

## M3 results (2026-09-26)

The app is in `web/` (Vite + React 19); Pi sign-in is in `src/worker/auth.ts`, with a `sessions` table in `migrations/0002_sessions.sql`. The Worker serves the built app as static files, with `/api/*` going to the Worker, so the app and API share one origin and one deploy.

- **Checked:** `web/src/App.test.tsx` renders the real app against the real Worker handler and SQL, with only Pi stubbed. It covers sign-in, a two-tap pick whose preview and stored value match `quickPick`/`points`, an exact pick, the lock error at kickoff, and an expired session going back to sign-in. I also walked through it in Chromium at 375×812 against `wrangler dev` and the live feed, with no horizontal scroll.
- **Not checked:** real Pi sign-in. `sdk.minepi.com` is blocked from the build environment, so the SDK wrapper (`web/src/pi.ts`) follows the pi-platform-docs reference but hasn't run against Pi yet. That's what the M3 proof is for.

**Decisions made in M3:**
- **Only the `username` scope for now.** `payments` gets added in M4, when there's a backend to complete payments. Adding it means users have to consent again.
- **Our own session token after one `/v2/me` check,** valid for 30 days, rather than calling Pi on every request. Only its SHA-256 is stored. A bad or expired session is a 401 on every route, and the app goes back to sign-in.
- **User IDs are `pi:<uid>`.** Usernames aren't unique in the table, and they update on each sign-in. I edited `0001_init.sql` to drop that constraint; it's safe because nothing has been deployed yet.
- **Pick screen:** quick mode gives the chosen outcome the confidence level and splits the rest by the league's base rates. Exact mode has three linked sliders that keep the other two in proportion. Both show the points you'd get for each result before you save.
- **No external links** in the app (listing rule), and the palette is pitch green and ice (no Pi purple or gold).
- **`FAKE_USERS` and `PI_SANDBOX` are Worker vars read by the app at runtime** (`GET /api/config`), so one build works for dev, sandbox and mainnet. **Set `FAKE_USERS` to "0" before mainnet.**

## M4 results (2026-09-26)

Private leagues are in `src/worker/leagues.ts`, payments in `src/worker/payments.ts`, and the schema in `migrations/0003_leagues_payments.sql` (orders, leagues, league_members). The app has a fourth tab, Leagues.

- **Checked:**
  - `src/worker/payments.test.ts` runs the full approve → sign → complete loop against `FakePi`, a stateful fake of Pi's Platform API, plus the cancel cases and each way a tampered client could try to cheat.
  - `web/src/Leagues.test.tsx` runs the same loop through the React app with a fake SDK, including cancelling in the wallet, an invite link, and an unfinished payment finished at the next sign-in.
  - I ran it under `wrangler dev` (workerd) with a stub Pi server and Chromium at 375px: a cancelled payment (approved, then backed out: nothing delivered), a paid one (GET → approve → GET → complete → league) and a second player joining by link.
- **Found by the real-runtime run:** calling the global `fetch` as a method (`this.fetcher(...)`) throws "Illegal invocation" in workerd but not in Node, so every approval would have failed in production. `src/worker/index.ts` now wraps `fetch`, and `index.test.ts` would catch it coming back.
- **Not checked:** real Pi. The SDK host is blocked from the build environment, so the proof ("full approve→sign→complete loop, cancel handled") still needs one run in the Pi sandbox with testnet Pi.

**Decisions made in M4:**
- **Price: 0.5 Pi** (the low end of the 2026-09-23 re-price), set by `LEAGUE_PRICE_PI`. I couldn't check current mining rates from here, so **re-check them before mainnet**. The price shows in Pi only, never in dollars.
- **Deliver only on Pi's word.** A league is created only when Pi's own record of the payment is developer-completed with a verified transaction and the matching txid. Delivery is keyed on the order (`leagues.order_id` is UNIQUE), so SDK retries and resumed payments can't create a second league.
- **Every payment check reads Pi's record, not the client's:** the user, the order (`metadata.orderId`), the exact amount, the direction and the network (`PI_NETWORK`, "Pi Testnet" now). One order takes one payment.
- **A cancel only counts while there's no transaction.** If Pi shows a signed transaction, the order is completed and delivered even if the app had reported a cancel, because we were paid.
- **Pi sign-in now asks for `payments` as well as `username`**, so players approve once more. Before paying, the app runs `Pi.authenticate` again, because Pi needs it in the same page load as `createPayment`. That's also when an unfinished payment gets reported.
- **Test players can join leagues but can't pay.** With no `PI_API_KEY` set, the server refuses orders (503), and the app says payments aren't switched on.
- **League rules:** names are 3-40 characters. Invite codes are 8 characters from an alphabet without 0/O/1/I, and typing them is forgiving about case, spaces and dashes. There are at most 500 players per league (enforced inside the insert). The creator can't leave. League tables are members only.

## M5 progress (2026-09-26)

- **Entry requirements** (from Pi's hackathon pages, via search; minepi.com is blocked from the build environment): a Testnet or Mainnet demo app link, a public video of 3 minutes or less, and a description, submitted in Brainstorm.
- **Done:**
  - The repo was already public (since 9/24).
  - The README now has screenshots, a "How it uses Pi" section and demo-data instructions.
  - `docs/SUBMISSION.md` has the checklist, the Brainstorm description and a shot list for the sandbox video.
  - There's a draft privacy page (`web/public/privacy.html`), linked from the app footer.
  - `npm run demo:seed` fills a local database with made-up players on the real results. They're tuned to average 68-74 points, which is where real forecasters land.
  - A captioned 1:21 local walkthrough video is recorded (not committed).
- **App change:** the Table and league tables now open on Season when the current week has no scores (international breaks), instead of an empty week.
- **Left, all needing James or real Pi:** deploy, the M3 and M4 sandbox proofs, `FAKE_USERS=0` for the demo deploy, a price check, a privacy review, the real sandbox video, and the Brainstorm submission.

## Open questions

1. ~~Pi's developer terms on prediction/sports apps.~~ **CHECKED 2026-09-23: allowed as designed.** No rule bans sports or forecasting apps. The one hard rule is in the App Studio Community Guidelines: no "offering or facilitating gambling, betting, or lottery-related services involving Pi tokens, either directly or indirectly." The Developer Terms (2023-01-09) and the main ToS (2025-02-19) say nothing about gambling. Our design has Pi in only for non-outcome extras and never out on results, so it clears the rule. "Indirectly" means never adding performance-linked Pi tips, rewards or prizes later either. Other rules that apply:
   - **Don't talk about Pi's value.** The guidelines ban "material discussions, representations or misrepresentations regarding the value or valuation of Pi." So there are **no USD prices anywhere in the app**, and prices are in Pi only.
   - **Mainnet listing requirements:** the developer must be KYC'd; **Pi login only** (no email or other sign-in); **Pi-only transactions** (a version taking other currencies has to be a separate deployment); **no external redirects** (fetch openfootball server-side, no links out to match sites); minimal data; **the domain can't start with "pi"** and can't use Pi's logo or colors.
2. ~~Does `Pi.authenticate` expose country?~~ **CHECKED 2026-09-26: no.** `/v2/me` returns only `uid`, `username` (with the `username` scope) and the granted scopes. Country will be self-chosen when country leaderboards land. Also, `uid` is specific to each app and **changes if the user revokes the app's permissions**, which makes them a new player.
3. ~~The openfootball timezone question.~~ **Settled in M0** (see above).
4. ~~Name.~~ **Crystal Boot, screened 2026-09-23 (not legal clearance):** USPTO: no live or dead mark for CRYSTAL BOOT or CRYSTALBOOT (relevance-ranked search surfaced only single-word BOOT/CRYSTAL marks). App Store: no app by that name. Web: no football product, just crystal trophies. crystalboot.com is registered (GoDaddy, to 2028) to a dead Shopify store; **crystalboot.app and crystalbootfc.com are open**. YouTube @crystalboot and TikTok @crystalboot are taken by unrelated people; **@crystalbootfc is free on YouTube, TikTok and GitHub** (X and Instagram hide behind a login, so check those by hand). Pundit FC was rejected: a football prediction app called "PunditFC" already exists, plus Pundit (punditapp.uk) and The Pundit.
5. Does the app need a version for another platform at all, or is that just scope creep? Decide after M5.

## Not doing

- Wagering in any form (see the gambling line).
- Player stats, fantasy, crests or photos (licensing).
- Bookmaker odds or affiliate links.
- Buying PI. Revenue is earned Pi only.
