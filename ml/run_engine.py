#!/usr/bin/env python3
"""Run the forecasting engine over one or more panels and print a comparable report.

Usage:
    ml/.venv/bin/python ml/run_engine.py /tmp/panel_state_month.json
    ml/.venv/bin/python ml/run_engine.py /tmp/*.json --json out/engine_report.json
    ml/.venv/bin/python ml/run_engine.py p.json --min-total 24 --test-frac 0.3

Panels are produced by `node ml/panel_from_seed.js --out <file>` for the synthetic
all-India corpus, and by the ingest scripts for real city datasets. The engine code is
identical across them by design: the accuracy claim is about the method, so the method has
to run unmodified.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Panel, evaluate  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("panels", nargs="+", help="panel JSON files")
    ap.add_argument("--min-total", type=int, default=0,
                    help="drop units with fewer total events (reported in the output)")
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--retrain-every", type=int, default=6)
    ap.add_argument("--neighbours", type=int, default=5)
    ap.add_argument("--no-quantiles", action="store_true")
    ap.add_argument("--json", default=None, help="write the full report as JSON")
    args = ap.parse_args()

    reports = []
    for path in args.panels:
        p = Panel.from_json(path)
        if args.min_total:
            p = p.drop_empty_units(args.min_total)
        name = Path(path).stem
        try:
            r = evaluate(
                p, dataset=name, test_frac=args.test_frac,
                retrain_every=args.retrain_every, n_neighbours=args.neighbours,
                with_quantiles=not args.no_quantiles,
            )
        except ValueError as e:
            print(f"── {name} ──\n  SKIPPED: {e}\n")
            continue
        print(r.summary())
        print(f"  weights: {r.weights}")
        print(f"  diagnostics: backend={r.diagnostics['gbm_backend']} "
              f"neighbours={r.diagnostics['neighbours']} "
              f"recapture={r.diagnostics['recapture_rate']} "
              f"runtime={r.runtime_s}s")
        sb = r.diagnostics.get("spatial_baseline_historical_pattern") or {}
        if sb:
            print("  police baseline (historical-pattern) PAI:",
                  {k: v["pai"] for k, v in sb.items()})
        print("  interval coverage by volume band:",
              r.conformal.get("coverage_by_band"))
        print()
        reports.append(r.__dict__)

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(reports, indent=2, default=str))
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
