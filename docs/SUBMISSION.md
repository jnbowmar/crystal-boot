# #PiHackathon submission

What a #PiHackathon entry needs, from Pi's hackathon pages (checked 26 September 2026 — re-read the current rules in the Brainstorm app before submitting):

- a link to a **demo app on Testnet or Mainnet**
- a **video of 3 minutes or less**, public on YouTube or a similar site
- a **description** of the app
- submitted through the **Brainstorm** app in the Pi Browser

## Checklist

| | Item | State |
|---|---|---|
| ☐ | Deploy to Cloudflare (steps in the README): D1 database, migrations, `ADMIN_TOKEN` and `PI_API_KEY` secrets | not done |
| ☐ | Register the app in the Pi Developer Portal (`develop.pi` in the Pi Browser), set the development URL to the deployed Worker | not done |
| ☐ | M3 proof: sign in and make real picks in the Pi sandbox | not done |
| ☐ | M4 proof: start a league with testnet Pi, and cancel one partway through | not done |
| ☐ | Set `FAKE_USERS` to `"0"` in `wrangler.jsonc` for the demo deploy, so judges only see Pi sign-in | not done |
| ☐ | Re-check the league price against current mining rates (`LEAGUE_PRICE_PI`, 0.5 now) | not done |
| ☐ | Review the privacy page (`web/public/privacy.html`), especially the deletion promise | draft written |
| ☐ | Record the real sandbox video (shot list below), upload it, and link it here and in the README | local demo recorded |
| ☑ | Public repo, MIT licence | done (public since 24 Sept) |
| ☑ | README for judges: what it is, how it uses Pi, screenshots, how to run and test it | done |
| ☐ | Submit in Brainstorm, by the last day of the month | not done |

## Description (paste into Brainstorm)

**Crystal Boot: free football forecasting for Pioneers.**

For every Premier League and La Liga match, give your odds for a home win, a draw and an away win in two taps. After full time you're scored on how close you were, using the Brier score that professional forecasters use. A confident wrong call costs the most, so calibration beats bravado. See whether you beat the crowd, and climb the global table and private leagues with your friends, office or group chat.

It's free to play, with no wagering. Pi is used only for extras that have nothing to do with results: starting a private league costs a small one-off Pi payment, and joining one is free. Pi is never paid out on a match.

Built for Pi: Pi sign-in only (one verified person, one account), Pi payments verified server-side through the full approve → sign → complete flow, prices in Pi only, and made for a phone screen with kickoff times in your own timezone. Real fixtures and results come from openfootball (public domain). Open source under MIT: github.com/jnbowmar/crystal-boot

## The video

There's a narration-free, captioned walkthrough (1:21, 720×1558 MP4) recorded from a **local build**, with made-up demo players and a stand-in for Pi's SDK. It says so on screen. It covers:
- sign-in
- fixtures
- a two-tap pick with its points preview
- an exact pick with the sliders
- scored picks against the crowd
- the season table
- joining a league by code
- paying for a new league

Pi's own wallet sheet doesn't appear in it.

For the entry, re-record the same flow **in the Pi sandbox with testnet Pi**, so the real Pi sign-in and payment sheet are on screen. Suggested shots (about 2 minutes):

1. **0:00** Title: what it is, in one line, and "free to play, no wagering".
2. **0:10** Open the app in the sandbox. Pi sign-in, then the fixture list.
3. **0:25** Two-tap pick on a real upcoming match. Pause on the "points if it happens" table.
4. **0:45** Exact % with the sliders on another match.
5. **1:00** My picks and the table (Season): average points, beating the crowd.
6. **1:15** Leagues: start a league, **the Pi payment sheet**, sign with testnet Pi, then the new league with its invite code.
7. **1:40** A second account joins with the code, and the league table shows both.
8. **1:55** End card: "Free to play. No wagering." and the repo link.

To rebuild the local demo database for practice runs: `npm run db:migrate:local`, start `npm run dev`, run the cron once, then `npm run demo:seed`.
