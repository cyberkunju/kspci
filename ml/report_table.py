#!/usr/bin/env python3
"""Collate evaluation reports into one comparable table.

Ranks by achievability efficiency rather than by MASE. MASE alone is not comparable across
panels — a panel of small counts has a large seasonal-naive error, so its MASE flatters the
model — whereas efficiency says how much of the *available* signal each configuration
actually captured, which is the question that decides where to spend more effort.

Usage:
    ml/.venv/bin/python ml/report_table.py ml/out/reports
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def _informative(ach: dict) -> bool:
    if "dispersion_informative" in ach:
        return bool(ach["dispersion_informative"])
    b = ach.get("dispersion_bracket")
    return True if not b else b[1] / max(b[0], 1e-9) <= 3.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?", default="ml/out/reports")
    ap.add_argument("--sort", default="eff", choices=["eff", "mase", "pai", "name"])
    ap.add_argument("--real", action="store_true", help="only real open-data corpora")
    ap.add_argument("--synthetic", action="store_true", help="only the synthetic corpus")
    args = ap.parse_args()

    rows = []
    for f in sorted(Path(args.dir).glob("*.json")):
        if f.name.startswith(("noise_floor", "hierarchical")):
            continue
        r = json.loads(f.read_text())
        if "skipped" in r:
            print(f"skipped {r.get('dataset', f.stem)}: {r['skipped']}")
            continue
        pt = r.get("point") or {}
        ens = pt.get("ENSEMBLE") or {}
        pol = pt.get("historical_pattern") or {}
        ach = r.get("achievability") or {}
        sp = (r.get("spatial") or {}).get("0.010") or {}
        sp10 = (r.get("spatial") or {}).get("0.100") or {}
        base_sp = ((r.get("diagnostics") or {}).get("spatial_baseline_historical_pattern") or {}).get("0.010") or {}
        cov = ((r.get("distribution") or {}).get("intervals") or {})
        mond = cov.get("mondrian-conformal (by band)") or {}
        rows.append({
            "name": r.get("dataset", f.stem),
            "units": (r.get("panel") or {}).get("units", 0),
            "periods": (r.get("panel") or {}).get("periods", 0),
            "events": (r.get("panel") or {}).get("events", 0),
            "mase": ens.get("mase"),
            "police": pol.get("mase"),
            "edge": (None if not (ens.get("mase") and pol.get("mase"))
                     else 100.0 * (pol["mase"] - ens["mase"]) / pol["mase"]),
            "eff": ach.get("efficiency"),
            "head": ach.get("headroom_pct"),
            # Headroom after correcting the floor for over-dispersion, as a range. The
            # Poisson-based "left%" beside it is a bound, not an estimate, and on every panel
            # measured so far it is the looser of the two by a wide margin.
            "dhead": ach.get("dispersion_headroom_pct"),
            # Derived from the bracket when the report predates the flag, so older reports
            # still get the caveat rather than silently reading as a measurement.
            "dok": _informative(ach),
            "source": (r.get("panel") or {}).get("source") or "",
            "pai1": sp.get("pai"),
            "pai1_base": base_sp.get("pai"),
            "pai10": sp10.get("pai"),
            "pei1": sp.get("pei"),
            "cov": mond.get("coverage"),
        })

    if args.real:
        rows = [x for x in rows if x["source"].startswith("real-")]
    if args.synthetic:
        rows = [x for x in rows if not x["source"].startswith("real-")]

    keys = {"eff": lambda x: -(x["eff"] or 0), "mase": lambda x: x["mase"] or 9,
            "pai": lambda x: -(x["pai1"] or 0), "name": lambda x: x["name"]}
    rows.sort(key=keys[args.sort])

    hdr = (f"{'panel':<46}{'units':>6}{'periods':>8}{'events':>11}"
           f"{'MASE':>7}{'police':>8}{'edge%':>7}{'eff':>6}{'left%':>7}"
           f"{'real left%':>12}{'PAI@1':>7}{'base':>6}{'PEI':>6}{'cov90':>7}")
    print(hdr)
    print("-" * len(hdr))
    for x in rows:
        def f(v, p=3, w=7):
            return f"{v:>{w}.{p}f}" if isinstance(v, (int, float)) else f"{'-':>{w}}"

        d = x["dhead"]
        drange = "-" if not d else (f"{d[0]:.1f}-{d[1]:.1f}" if x["dok"] else "n/a")
        print(f"{x['name'][:45]:<46}{x['units']:>6}{x['periods']:>8}{x['events']:>11,}"
              f"{f(x['mase'], 3, 7)}{f(x['police'], 3, 8)}{f(x['edge'], 1, 7)}"
              f"{f(x['eff'], 3, 6)}{f(x['head'], 1, 7)}{drange:>12}"
              f"{f(x['pai1'], 2, 7)}{f(x['pai1_base'], 2, 6)}{f(x['pei1'], 2, 6)}"
              f"{f(x['cov'], 3, 7)}")

    print(f"\n{len(rows)} panels."
          "\n  eff        = achieved MAE against the Poisson noise floor; 1.0 is the limit."
          "\n  left%      = unclaimed error reduction against that floor. The floor assumes"
          "\n               variance = mean, so this is a bound and it is a loose one."
          "\n  real left% = the same after correcting the floor for over-dispersion, as a"
          "\n               range. This is the number to act on. 'n/a' means the dispersion"
          "\n               bracket was too wide to conclude anything — see"
          "\n               Panel.dispersion_is_informative."
          "\n  edge%      = improvement over the historical-pattern police baseline."
          "\n  base       = that baseline's own PAI@1%, so spatial gains read against it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
