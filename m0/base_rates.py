"""M0: home/draw/away base rates from openfootball, last 5 finished seasons.
Run: python3 m0/base_rates.py   (re-downloads into m0/data/)"""
import json, pathlib, urllib.request

LEAGUES = ["en.1", "es.1"]
SEASONS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"]
URL = "https://raw.githubusercontent.com/openfootball/football.json/master/{s}/{l}.json"
DATA = pathlib.Path(__file__).parent / "data"


def full_time(match):
    # openfootball is inconsistent: score is {"ft": [h, a], ...} in most seasons
    # but a bare [h, a] list in 2025-26 EPL. Future matches have no score.
    s = match.get("score")
    if isinstance(s, dict):
        return s.get("ft")
    if isinstance(s, list) and len(s) == 2:
        return s
    return None


def load(season, league):
    path = DATA / f"{season}-{league}.json"
    if not path.exists():
        DATA.mkdir(exist_ok=True)
        urllib.request.urlretrieve(URL.format(s=season, l=league), path)
    return json.loads(path.read_text())["matches"]


for league in LEAGUES:
    total = [0, 0, 0]
    for season in SEASONS:
        for m in load(season, league):
            ft = full_time(m)
            if ft:
                total[0 if ft[0] > ft[1] else 1 if ft[0] == ft[1] else 2] += 1
    n = sum(total)
    print(f"{league}  n={n}  H {total[0]/n:.3f}  D {total[1]/n:.3f}  A {total[2]/n:.3f}")
