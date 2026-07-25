#!/usr/bin/env python3
"""Does forecasting each crime group separately and summing beat forecasting the total?

The achievability bound said a third of the available signal is still unclaimed at district
resolution. This tests the most plausible reason. The aggregate series mixes offence types
with genuinely different dynamics — the generator gives Liquor & Excise a branching ratio of
0.58 and a four-day mean delay, Crime Against Women 0.28 over fifteen days — and summing
them first averages those signatures away before the model ever sees them.

The comparison is a standard hierarchical-forecasting question, run honestly:

    top-down    forecast the aggregate directly
    bottom-up   forecast each group, then sum the group forecasts

Both are scored on the same aggregate target over the same held-out window, so the
difference is attributable to the decomposition and nothing else.

Usage:
    ml/.venv/bin/python ml/hierarchical.py --panels out/panels/heads --aggregate out/panels/india_district_week.json
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Panel, evaluate  # noqa: E402
from engine import metrics as MT  # noqa: E402

# Aggregates written by build_panels.py --split-head. These are roll-ups of the groups, not
# groups themselves, so including them in a bottom-up sum would double count.
ROLLUPS = {"victim_reported", "enforcement_led"}


def align(results: dict[str, object], units: list[str], origins: list[str]) -> dict[str, np.ndarray]:
    """Sum group predictions onto a common (origin, unit) grid.

    Groups cover different unit and period sets — a rare offence simply does not occur in
    most districts — so alignment is by label, and anything missing contributes zero rather
    than being dropped. Dropping would quietly change the target.
    """
    uidx = {u: i for i, u in enumerate(units)}
    oidx = {o: i for i, o in enumerate(origins)}
    out = {k: np.zeros((len(origins), len(units)), dtype=np.float64)
           for k in ("ensemble", "poisson_gbm", "historical_pattern")}
    for name, r in results.items():
        p = r.predictions
        if not p:
            continue
        rows = [oidx[o] for o in p["origins"] if o in oidx]
        keep_o = [i for i, o in enumerate(p["origins"]) if o in oidx]
        cols = [uidx[u] for u in p["units"] if u in uidx]
        keep_u = [i for i, u in enumerate(p["units"]) if u in uidx]
        if not rows or not cols:
            continue
        for key in out:
            block = p[key][np.ix_(keep_o, keep_u)]
            out[key][np.ix_(rows, cols)] += block
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--panels", required=True, help="directory of per-group panels")
    ap.add_argument("--aggregate", required=True, help="panel of the same units, all groups")
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--retrain-every", type=int, default=8)
    ap.add_argument("--neighbours", type=int, default=5)
    ap.add_argument("--json", help="write the comparison table here")
    args = ap.parse_args()

    agg_panel = Panel.from_json(args.aggregate)
    print(f"aggregate: {agg_panel.describe()}\n")
    agg = evaluate(
        agg_panel, dataset="aggregate", test_frac=args.test_frac,
        retrain_every=args.retrain_every, n_neighbours=args.neighbours,
        with_quantiles=False, keep_predictions=True,
    )
    units = agg.predictions["units"]
    origins = agg.predictions["origins"]
    y = agg.predictions["actual"]
    naive = agg.predictions["seasonal_naive"]

    files = sorted(Path(args.panels).glob("*.json"))
    results = {}
    for f in files:
        tag = f.stem.split("_week_")[-1] if "_week_" in f.stem else f.stem
        if tag in ROLLUPS:
            continue
        p = Panel.from_json(str(f))
        if p.T < p.season + 12 or p.B < 2:
            print(f"  skip {tag}: {p.B} units x {p.T} periods — too little history")
            continue
        try:
            r = evaluate(
                p, dataset=tag, test_frac=args.test_frac, retrain_every=args.retrain_every,
                n_neighbours=args.neighbours, with_quantiles=False, keep_predictions=True,
            )
        except ValueError as e:
            print(f"  skip {tag}: {e}")
            continue
        results[tag] = r
        print(f"  {tag:<34} {p.B:>4} units  MASE {r.point['ENSEMBLE']['mase']:.3f}  "
              f"efficiency {r.achievability['efficiency']:.3f}  ({r.runtime_s:.0f}s)")

    if not results:
        print("no group panels evaluated")
        return 1

    bu = align(results, units, origins)

    print(f"\n{'':<26}{'MASE':>8}{'MAE':>10}{'efficiency':>12}{'headroom':>10}")
    rows = {
        "top-down (aggregate)": agg.predictions["ensemble"],
        "bottom-up (sum of groups)": bu["ensemble"],
        "bottom-up, GBM only": bu["poisson_gbm"],
        "police baseline (aggregate)": agg.predictions["historical_pattern"],
        "police baseline (bottom-up)": bu["historical_pattern"],
    }
    table = {}
    for name, pred in rows.items():
        a = MT.achievability(pred.ravel(), y.ravel(), naive.ravel())
        m = MT.mase(pred.ravel(), y.ravel(), naive.ravel())
        table[name] = {"mase": m, "mae": a["achieved_mae"],
                       "efficiency": a["efficiency"], "headroom_pct": a["headroom_pct"]}
        print(f"{name:<26}{m:>8.3f}{a['achieved_mae']:>10.2f}"
              f"{a['efficiency']:>12.3f}{a['headroom_pct']:>9.1f}%")

    # A simple combination of the two hierarchy levels. Bottom-up captures group-specific
    # dynamics; top-down is better conditioned because the aggregate series is smoother.
    # Neither dominates in general, so the blend is worth measuring rather than assuming.
    best = None
    for wgt in np.arange(0.0, 1.01, 0.1):
        blend = wgt * bu["ensemble"] + (1 - wgt) * agg.predictions["ensemble"]
        m = MT.mase(blend.ravel(), y.ravel(), naive.ravel())
        if best is None or m < best[1]:
            best = (float(wgt), m)
    blend = best[0] * bu["ensemble"] + (1 - best[0]) * agg.predictions["ensemble"]
    a = MT.achievability(blend.ravel(), y.ravel(), naive.ravel())
    print(f"{'blend (w_bottomup=' + f'{best[0]:.1f}' + ')':<26}{best[1]:>8.3f}"
          f"{a['achieved_mae']:>10.2f}{a['efficiency']:>12.3f}{a['headroom_pct']:>9.1f}%")
    print("\nNote: the blend weight is selected on the same window it is scored on, so it is an\n"
          "upper bound on what a properly held-out blend would deliver. Treat it as a ceiling,\n"
          "not as a result.")

    if args.json:
        import json
        table[f"blend (w_bottomup={best[0]:.1f}, in-sample weight)"] = {
            "mase": best[1], "mae": a["achieved_mae"],
            "efficiency": a["efficiency"], "headroom_pct": a["headroom_pct"],
            "weight_selected_on_test_window": True,
        }
        Path(args.json).write_text(json.dumps({
            "aggregate_panel": Path(args.aggregate).stem,
            "groups": {t: {"units": r.predictions["ensemble"].shape[1],
                           "mase": r.point["ENSEMBLE"]["mase"],
                           "efficiency": r.achievability["efficiency"]}
                       for t, r in results.items()},
            "comparison": table,
        }, indent=2, default=float))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
