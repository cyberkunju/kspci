#!/usr/bin/env python3
"""Score the live forecast with the pooled national model, offline, and upload the snapshot.

Why not score it inside Catalyst. Assembling the national district-month panel from the Data
Store and scoring it takes about 45 seconds, past a Function's execution ceiling. The in-Catalyst
refresh works around that by scoring one state at a time — but that discards the thing that makes
the gradient-boosted model strong, which is pooling across all 640 districts. Measured on the same
data: per-state scoring reaches MASE 0.95, the pooled model 0.79. The police historical-pattern
baseline is around 0.99, so per-state scoring is barely better than the wall map it replaces.

Nothing requires the scoring to happen in Catalyst. This builds the panel from the same CSV rows
that were loaded, runs the same ``engine`` package, and uploads the result. The write is a few
hundred rows; the compute is free.

The panel must match what the Data Store holds, or the forecast would describe data the app does
not have — hence --max-rows, which mirrors the loader's ceiling.

Usage:
    ADMIN_KEY=... ml/.venv/bin/python ml/score_live.py --max-rows 1016380
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Panel, forecast_next  # noqa: E402

SEED = Path(__file__).resolve().parent.parent / "datastore" / "seed" / "Cases.csv"
SEASON = 12


def build_panel(csv: Path, max_rows: int) -> Panel:
    """District x month counts, from the same rows the loader sent."""
    import csv as csvmod

    counts: dict[str, dict[str, int]] = {}
    months: set[str] = set()
    with open(csv, newline="", encoding="utf-8") as fh:
        rdr = csvmod.reader(fh)
        header = next(rdr)
        ix = {name: i for i, name in enumerate(header)}
        need = ("CrimeRegisteredDate", "StateName", "DistrictName", "latitude", "longitude")
        missing = [n for n in need if n not in ix]
        if missing:
            raise SystemExit(f"{csv} is missing {missing}")
        coords: dict[str, tuple[float, float, int]] = {}
        for n, row in enumerate(rdr, start=1):
            if max_rows and n > max_rows:
                break
            date = row[ix["CrimeRegisteredDate"]]
            unit = f'{row[ix["StateName"]]}|{row[ix["DistrictName"]]}'
            ym = date[:7]
            months.add(ym)
            counts.setdefault(unit, {})
            counts[unit][ym] = counts[unit].get(ym, 0) + 1
            try:
                la, lo = float(row[ix["latitude"]]), float(row[ix["longitude"]])
            except ValueError:
                continue
            s = coords.get(unit)
            coords[unit] = (s[0] + la, s[1] + lo, s[2] + 1) if s else (la, lo, 1)

    labels = sorted(months)
    units = sorted(counts)
    mat = np.array([[counts[u].get(m, 0) for m in labels] for u in units], dtype=np.float32)
    lat = np.array([coords[u][0] / coords[u][2] if u in coords else np.nan for u in units])
    lng = np.array([coords[u][1] / coords[u][2] if u in coords else np.nan for u in units])
    month = np.array([int(m[5:7]) for m in labels], dtype=np.int16)
    return Panel(units=units, counts=mat, period="month", season=SEASON, labels=labels,
                 month=month, lat=lat, lng=lng,
                 meta={"level": "district", "source": "datastore-seed-prefix"})


def to_payload(res: dict) -> dict:
    """Shape the engine result like the API's forecast payload."""
    acc = res.get("accuracy") or {}
    out = {
        "horizon": res.get("horizon"),
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat(),
        "servedBy": f'offline pooled: {res.get("engine")} [{(res.get("backends") or {}).get("point")}]',
        "weights": res.get("weights"),
        "conformal": {"method": res.get("intervalMethod"), "level": res.get("intervalLevel"),
                      "chosen": acc.get("intervalChosen")},
        "accuracy": {
            "mae": acc.get("mae"),
            "mase": (acc.get("mase") or {}).get("ENSEMBLE"),
            "policeBaselineMase": (acc.get("mase") or {}).get("historical_pattern"),
            "coverage90": round((acc.get("coverage") or 0) * 100, 1),
            "achievability": acc.get("achievability"),
            "spatial": acc.get("spatial"),
            "window": acc.get("window"),
        },
        # The dashboard header reads statewide.predicted; without it the card renders a blank.
        "statewide": {"predicted": round(sum(f["predicted"] for f in res["forecasts"]))},
        "coverageTarget": 90,
        "units": res.get("units"),
        "periods": res.get("periods"),
        "caveat": res.get("caveat"),
        "forecasts": [],
    }
    for f in res["forecasts"]:
        sigma = None
        out["forecasts"].append({
            "unit": f["unit"], "state": f["state"], "district": f["district"], "name": f["name"],
            "predicted": f["predicted"], "low": f["low"], "high": f["high"],
            "baseline": f["baseline"], "trendPct": f["trendPct"], "band": f["band"],
            "lat": f["lat"], "lng": f["lng"],
            # z against the interval half-width, so severity is scaled by the model's own
            # uncertainty for that unit rather than by a panel-wide constant.
            "z": round((f["predicted"] - f["baseline"]) / max(1e-9, (f["high"] - f["low"]) / 3.29), 2)
            if sigma is None else sigma,
        })
    return out


def early_warning(payload: dict) -> dict:
    """Derive the early-warning payload from the forecast, matching the API's thresholds."""
    alerts = []
    for f in payload["forecasts"]:
        z, tr = f.get("z") or 0, f.get("trendPct") or 0
        sev = "watch"
        if z >= 1.5 or tr >= 50:
            sev = "critical"
        elif z >= 0.8 or tr >= 25:
            sev = "elevated"
        if z >= 0.3 or tr >= 8:
            alerts.append({**f, "severity": sev})
    alerts.sort(key=lambda a: -(a.get("z") or 0))
    return {
        **{k: v for k, v in payload.items() if k != "forecasts"},
        "method": "Ensemble forecast vs 12-month control baseline (z-score / EWMA-style expectation)",
        "critical": sum(1 for a in alerts if a["severity"] == "critical"),
        "elevated": sum(1 for a in alerts if a["severity"] == "elevated"),
        "alerts": alerts,
    }


def put(base: str, key: str, route: str, payload: dict) -> dict:
    body = json.dumps({"route": route, "level": "district", "payload": payload}).encode()
    req = urllib.request.Request(f"{base.rstrip('/')}/admin/forecast/put", data=body,
                                 headers={"Content-Type": "application/json", "x-admin-key": key})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=str(SEED))
    ap.add_argument("--max-rows", type=int, default=int(os.environ.get("MAX_ROWS", 0)),
                    help="mirror the loader's ceiling so the panel matches the Data Store")
    ap.add_argument("--base", default=os.environ.get("KSP_API_BASE",
                                                     "https://ksp.cyberkunju.com/server/api"))
    ap.add_argument("--key", default=os.environ.get("ADMIN_KEY", ""))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    panel = build_panel(Path(args.csv), args.max_rows)
    print(panel.describe())

    res = forecast_next(panel)
    acc = res["accuracy"]
    print(f"\nbackends {res['backends']}  horizon {res['horizon']}  ({res['runtime_s']}s)")
    print(f"MASE ensemble {acc['mase']['ENSEMBLE']}  police baseline "
          f"{acc['mase']['historical_pattern']}  coverage {acc['coverage']}")
    print(f"interval {acc['intervalChosen']} {acc['intervals']}")
    print(f"PAI@1% {(acc['spatial'] or {}).get('0.010')}")

    payload = to_payload(res)
    ew = early_warning(payload)
    print(f"units {len(payload['forecasts'])}  alerts {len(ew['alerts'])} "
          f"({ew['critical']} critical, {ew['elevated']} elevated)")

    if args.dry_run:
        return 0
    if not args.key:
        raise SystemExit("ADMIN_KEY required to upload (or pass --dry-run)")
    print("forecast   ->", put(args.base, args.key, "forecast", payload)["result"])
    print("earlywarning ->", put(args.base, args.key, "earlywarning", ew)["result"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
