"""Generate the Brier parity fixture from fed_calls/score.py.

fed_calls scores binary calls with brier(p, outcome) = (p - outcome)^2. The
three-outcome version is that same function summed over home, draw and away.
This script does exactly that, in exact fractions, for every pick on a 5%
grid and every result, and writes the answers for vitest to check scoring.ts
against.

    python3 scripts/parity.py
"""
import importlib.util
import json
import math
import os
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "scoring", "__fixtures__", "brier.expected.json")
SCORE = os.path.expanduser("~/Claude/fed_calls/score.py")

spec = importlib.util.spec_from_file_location("fed_score", SCORE)
fed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fed)


cases = []
for h in range(0, 101, 5):
    for d in range(0, 101 - h, 5):
        pick = {"H": h, "D": d, "A": 100 - h - d}
        for actual in "HDA":
            b = sum(fed.brier(Fraction(pick[o], 100), 1 if o == actual else 0) for o in "HDA")
            raw = 100 - 50 * b
            # With whole percentages raw never ends in exactly .5 (scoring.ts
            # explains why), so plain round-half-up is unambiguous here.
            assert raw.denominator != 2
            cases.append({"pick": pick, "actual": actual, "brier": float(b),
                          "points": math.floor(raw + Fraction(1, 2))})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump({"source": "fed_calls/score.py brier(), summed over H/D/A", "cases": cases}, f)
print("%d cases -> %s" % (len(cases), os.path.relpath(OUT, ROOT)))
