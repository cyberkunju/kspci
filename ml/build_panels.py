#!/usr/bin/env python3
"""Build forecasting panels from an incident table, at any spatial and temporal resolution.

Aggregation runs in DuckDB against the CSV on disk. A 27M-row incident table will not fit
in memory as a dataframe on this machine, and more importantly the same code then works
unchanged on the real city datasets, which are larger still.

Spatial levels:
    state | district | taluk | grid
Temporal levels:
    month | week | day

Grid cells are indexed on an equirectangular projection about the region's mean latitude —
accurate enough for assigning incidents to cells over a country, without a projection
dependency.

Examples:
    # national district x week
    build_panels.py --level district --period week --out out/panels

    # 1 km grid x week for one metropolitan district, the configuration where a model can
    # actually beat "patrol where crime usually is"
    build_panels.py --level grid --grid-m 1000 --period week \
        --district Ahmadabad --min-total 40 --out out/panels

    # per crime group, to separate victim-reported offences from enforcement-discovered
    build_panels.py --level district --period week --split-head --out out/panels
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import duckdb

M_PER_DEG_LAT = 110574.0

# Enforcement-discovered groups. Recorded volume here is largely a record of where officers
# went, so forecasting it and then deploying against the forecast closes a feedback loop:
# the model sends patrols where patrols already were, and the resulting records confirm the
# model. These are forecast separately and must never drive deployment on their own.
ENFORCEMENT_LED = {
    "Liquor & Excise",
    "Narcotics",
    "Regulatory & Local Acts",
    "Arms & Explosives",
    "Environment & Wildlife",
}


def period_expr(period: str) -> str:
    if period == "month":
        return "date_trunc('month', CAST(date AS DATE))"
    if period == "week":
        return "date_trunc('week', CAST(date AS DATE))"
    if period == "day":
        return "CAST(date AS DATE)"
    raise ValueError(f"unknown period {period}")


def unit_expr(level: str, grid_m: float, mean_lat: float) -> tuple[str, str]:
    """Returns (unit key expression, centroid source)."""
    if level == "state":
        return "state", "avg"
    if level == "district":
        return "state || '|' || district", "avg"
    if level == "taluk":
        return "state || '|' || district || '|' || taluk", "avg"
    if level == "grid":
        d_lat = grid_m / M_PER_DEG_LAT
        d_lng = grid_m / (M_PER_DEG_LAT * math.cos(math.radians(mean_lat)))
        return (
            f"'G' || CAST(floor(latitude / {d_lat:.10f}) AS BIGINT) || '_' "
            f"|| CAST(floor(longitude / {d_lng:.10f}) AS BIGINT)",
            "avg",
        )
    raise ValueError(f"unknown level {level}")


def source_expr(events: str) -> str:
    """DuckDB scan expression for the incident table.

    Parquet is worth converting to once: the CSV is re-parsed in full on every scan, while
    Parquet is columnar, so a panel that needs five of eleven columns reads only those and
    skips the rest. On the 27M-row table that is the difference between a container spending
    most of its life in the CSV parser and spending it on the aggregation.
    """
    if events.endswith((".parquet", ".pq")):
        return f"read_parquet('{events}')"
    return f"read_csv_auto('{events}', header=true)"


def build(
    con: duckdb.DuckDBPyConnection,
    events: str,
    level: str,
    period: str,
    grid_m: float,
    where: list[str],
    min_total: int,
    source: str = "ksp-synthetic-all-india",
) -> dict:
    src = source_expr(events)
    filt = (" WHERE " + " AND ".join(where)) if where else ""

    mean_lat = con.execute(f"SELECT avg(latitude) FROM {src}{filt}").fetchone()[0] or 22.0
    ukey, _ = unit_expr(level, grid_m, mean_lat)
    pkey = period_expr(period)

    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE agg AS
        SELECT {ukey} AS unit, {pkey} AS p, COUNT(*) AS n,
               avg(latitude) AS lat, avg(longitude) AS lng,
               any_value(state) AS state
        FROM {src}{filt}
        GROUP BY 1, 2
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE units AS
        SELECT unit, SUM(n) AS total,
               SUM(n * lat) / SUM(n) AS lat, SUM(n * lng) / SUM(n) AS lng,
               any_value(state) AS state
        FROM agg GROUP BY 1
        HAVING SUM(n) >= {int(min_total)}
        ORDER BY unit
        """
    )
    n_all = con.execute("SELECT count(*) FROM (SELECT DISTINCT unit FROM agg)").fetchone()[0]
    units = con.execute("SELECT unit, total, lat, lng, state FROM units").fetchall()
    if not units:
        raise SystemExit("no units survived the min-total filter")

    periods = [r[0] for r in con.execute("SELECT DISTINCT p FROM agg ORDER BY p").fetchall()]
    pidx = {p: i for i, p in enumerate(periods)}
    uidx = {u[0]: i for i, u in enumerate(units)}

    series = [[0] * len(periods) for _ in units]
    for u, p, n in con.execute(
        "SELECT a.unit, a.p, SUM(a.n) FROM agg a JOIN units USING (unit) GROUP BY 1,2"
    ).fetchall():
        series[uidx[u]][pidx[p]] = int(n)

    timeline = []
    for p in periods:
        timeline.append({
            "year": p.year, "month": p.month, "dow": p.weekday(),
            "label": p.isoformat(), "idx": len(timeline),
        })
    unit_meta = {
        u[0]: {"name": u[0], "state": u[4], "lat": None if u[2] is None else round(u[2], 5),
               "lng": None if u[3] is None else round(u[3], 5), "pop": 0.0}
        for u in units
    }
    return {
        "source": source,
        "level": level, "period": period, "grid_m": grid_m if level == "grid" else None,
        "filters": where, "min_total": min_total,
        "units_before_filter": n_all,
        "units": [u[0] for u in units],
        "timeline": timeline,
        "series": {u[0]: series[uidx[u[0]]] for u in units},
        "unitMeta": unit_meta,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--events", default="datastore/train/events.csv")
    ap.add_argument("--level", default="district", choices=["state", "district", "taluk", "grid"])
    ap.add_argument("--period", default="week", choices=["month", "week", "day"])
    ap.add_argument("--grid-m", type=float, default=1000.0)
    ap.add_argument("--state", default=None)
    ap.add_argument("--district", default=None)
    ap.add_argument("--head", default=None, help="restrict to one crime group")
    ap.add_argument("--split-head", action="store_true",
                    help="one panel per crime group, plus victim-reported and enforcement-led aggregates")
    ap.add_argument("--min-total", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--out", default="out/panels")
    # Real city corpora go through this same builder — see ingest_cities.py, which writes them
    # with these column names precisely so no second panel path is needed. The prefix and
    # source keep the resulting panels distinguishable from the synthetic ones, which matters
    # because the whole point of the real data is to be reported separately.
    ap.add_argument("--prefix", default="india", help="filename prefix for built panels")
    ap.add_argument("--source", default="ksp-synthetic-all-india",
                    help="provenance string recorded in the panel")
    args = ap.parse_args()

    con = duckdb.connect()
    if args.threads:
        con.execute(f"SET threads={args.threads}")
    con.execute("SET memory_limit='6GB'")

    base_where = []
    if args.state:
        base_where.append(f"state = '{args.state}'")
    if args.district:
        base_where.append(f"district = '{args.district}'")

    jobs: list[tuple[str, list[str]]] = []
    if args.split_head:
        groups = [r[0] for r in con.execute(
            f"SELECT DISTINCT head FROM {source_expr(args.events)} ORDER BY 1"
        ).fetchall()]
        enf = sorted(g for g in groups if g in ENFORCEMENT_LED)
        vic = sorted(g for g in groups if g not in ENFORCEMENT_LED)
        in_list = lambda gs: "head IN (" + ",".join(f"'{g}'" for g in gs) + ")"  # noqa: E731
        jobs.append(("victim_reported", base_where + [in_list(vic)]))
        jobs.append(("enforcement_led", base_where + [in_list(enf)]))
        for g in groups:
            jobs.append((g.lower().replace(" & ", "_").replace(" ", "_"), base_where + [f"head = '{g}'"]))
    elif args.head:
        jobs.append((args.head.lower().replace(" & ", "_").replace(" ", "_"),
                     base_where + [f"head = '{args.head}'"]))
    else:
        jobs.append(("all", base_where))

    Path(args.out).mkdir(parents=True, exist_ok=True)
    for tag, where in jobs:
        panel = build(con, args.events, args.level, args.period, args.grid_m, where,
                      args.min_total, args.source)
        bits = [args.prefix, args.level]
        if args.level == "grid":
            bits.append(f"{int(args.grid_m)}m")
        bits.append(args.period)
        if args.state:
            bits.append(args.state.lower().replace(" ", ""))
        if args.district:
            bits.append(args.district.lower().replace(" ", ""))
        if tag != "all":
            bits.append(tag)
        path = os.path.join(args.out, "_".join(bits) + ".json")
        with open(path, "w") as fh:
            json.dump(panel, fh)
        B, T = len(panel["units"]), len(panel["timeline"])
        tot = sum(sum(v) for v in panel["series"].values())
        nz = sum(1 for v in panel["series"].values() for x in v if x == 0)
        print(
            f"{path}\n"
            f"  {B:,} units x {T} {args.period}s = {B * T:,} cells, {tot:,} events "
            f"({panel['units_before_filter']:,} units before min-total={args.min_total})\n"
            f"  zero cells {100.0 * nz / max(1, B * T):.1f}%  "
            f"median events/unit/period {tot / max(1, B * T):.2f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
