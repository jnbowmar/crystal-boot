"""Match football-data.co.uk result CSVs to the matches /admin is waiting on.

Usage:
  python3 -I scripts/fdcuk-scores.py pending.json E0.csv SP1.csv > scores.json

pending.json is the body of GET /api/admin/pending. The CSVs come from
https://www.football-data.co.uk/mmz4281/2627/{E0,SP1}.csv. Output is
{"scores": [...]} for POST /api/admin/scores, plus a report on stderr of
pending matches the CSVs have no result for. Every CSV team name must be in
the map below, so a promoted club stops the script instead of being skipped.
"""

import csv
import json
import sys

DIVISIONS = {"E0": "en.1", "SP1": "es.1"}

NAMES = {
    "en.1": {
        "Arsenal": "Arsenal FC",
        "Aston Villa": "Aston Villa FC",
        "Bournemouth": "AFC Bournemouth",
        "Brentford": "Brentford FC",
        "Brighton": "Brighton & Hove Albion FC",
        "Chelsea": "Chelsea FC",
        "Coventry": "Coventry City FC",
        "Crystal Palace": "Crystal Palace FC",
        "Everton": "Everton FC",
        "Fulham": "Fulham FC",
        "Hull": "Hull City AFC",
        "Ipswich": "Ipswich Town FC",
        "Leeds": "Leeds United FC",
        "Liverpool": "Liverpool FC",
        "Man City": "Manchester City FC",
        "Man United": "Manchester United FC",
        "Newcastle": "Newcastle United FC",
        "Nott'm Forest": "Nottingham Forest FC",
        "Sunderland": "Sunderland AFC",
        "Tottenham": "Tottenham Hotspur FC",
    },
    "es.1": {
        "Alaves": "Deportivo Alavés",
        "Ath Bilbao": "Athletic Club",
        "Ath Madrid": "Club Atlético de Madrid",
        "Barcelona": "FC Barcelona",
        "Betis": "Real Betis Balompié",
        "Celta": "RC Celta de Vigo",
        "Elche": "Elche CF",
        "Espanol": "RCD Espanyol de Barcelona",
        "Getafe": "Getafe CF",
        "La Coruna": "RC Deportivo La Coruña",
        "Levante": "Levante UD",
        "Malaga": "Málaga CF",
        "Osasuna": "CA Osasuna",
        "Real Madrid": "Real Madrid CF",
        "Santander": "Real Racing Club de Santander",
        "Sevilla": "Sevilla FC",
        "Sociedad": "Real Sociedad de Fútbol",
        "Valencia": "Valencia CF",
        "Vallecano": "Rayo Vallecano de Madrid",
        "Villarreal": "Villarreal CF",
    },
}


def main(pending_path, *csv_paths):
    with open(pending_path, encoding="utf-8") as f:
        pending = {m["id"]: m for m in json.load(f)["matches"]}
    results = {}
    for path in csv_paths:
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                league = DIVISIONS[row["Div"]]
                home = NAMES[league][row["HomeTeam"]]
                away = NAMES[league][row["AwayTeam"]]
                if row["FTHG"] == "" or row["FTAG"] == "":
                    continue
                mid = f"{league}|2026-27|{home}|{away}"
                results[mid] = (int(row["FTHG"]), int(row["FTAG"]), row["Date"])
    scores, missing = [], []
    for mid, m in pending.items():
        if mid in results:
            hg, ag, _ = results[mid]
            scores.append({"matchId": mid, "home": hg, "away": ag})
        else:
            missing.append(f"{m['date']} {m['league']} {m['home']} v {m['away']}")
    json.dump({"scores": scores}, sys.stdout, ensure_ascii=False, indent=1)
    print(f"{len(scores)} matched, {len(missing)} pending with no CSV result", file=sys.stderr)
    for line in missing:
        print("  no result:", line, file=sys.stderr)


if __name__ == "__main__":
    main(*sys.argv[1:])
