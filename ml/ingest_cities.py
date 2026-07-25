#!/usr/bin/env python3
"""Pull real, incident-level, geocoded crime from several city open-data portals.

Why more than Chicago. A single-city validation shows the method works somewhere. It does not
show that the *conclusions* — grid resolution is where spatial value appears, the police
historical-pattern baseline is hard to beat, a third of the signal is unclaimed at coarse
resolution — hold outside one city's reporting culture. Five cities with different geography,
recording practice and offence mixes is the cheapest available test of that.

The output deliberately uses the **same column names as the synthetic Indian corpus**
(``date, state, district, taluk, latitude, longitude, head``) so ``build_panels.py`` and the
whole engine run against it unchanged. A separate city-specific panel path would be a second
mechanism for a problem already solved, and worse, it would mean the real-data numbers came
out of different code than the numbers they are supposed to validate.

    state    -> city
    district -> the portal's own area unit (district / borough / sector / precinct)
    taluk    -> the portal's finer unit (beat / reporting district)
    head     -> the portal's offence description

Usage:
    ml/.venv/bin/python ml/ingest_cities.py --city chicago --start 2015-01-01
    ml/.venv/bin/python ml/ingest_cities.py --all --start 2018-01-01
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import pandas as pd
import requests

# Socrata SoQL endpoints. Field names are the portal's own; they are validated against a
# one-row probe before the bulk pull so a renamed column fails immediately with the actual
# key list rather than producing a silently empty panel.
CITIES: dict[str, dict] = {
    "chicago": {
        "city": "Chicago",
        "url": "https://data.cityofchicago.org/resource/ijzp-q8t2.json",
        "date": "date", "lat": "latitude", "lng": "longitude",
        "area": "district", "sub": "beat", "type": "primary_type",
    },
    "losangeles": {
        "city": "Los Angeles",
        "url": "https://data.lacity.org/resource/2nrs-mtv8.json",
        "date": "date_occ", "lat": "lat", "lng": "lon",
        "area": "area_name", "sub": "rpt_dist_no", "type": "crm_cd_desc",
    },
    "newyork": {
        "city": "New York",
        "url": "https://data.cityofnewyork.us/resource/qgea-i56i.json",
        "date": "cmplnt_fr_dt", "lat": "latitude", "lng": "longitude",
        "area": "boro_nm", "sub": "addr_pct_cd", "type": "ofns_desc",
    },
    # Austin's crime-reports endpoint (fdj4-gpfu) was considered and rejected: it publishes
    # sector and council district but no coordinates, so it cannot support a grid panel,
    # which is the resolution the whole comparison turns on.
    "sanfrancisco": {
        "city": "San Francisco",
        "url": "https://data.sfgov.org/resource/wg3w-h783.json",
        "date": "incident_datetime", "lat": "latitude", "lng": "longitude",
        "area": "police_district", "sub": "analysis_neighborhood",
        "type": "incident_category",
    },
    # Dallas (qv6i-rri7) was considered and rejected: it exposes a Socrata point geometry and
    # state-plane x/y but no latitude/longitude scalars, so it would need a projection step
    # for no additional coverage that Seattle and San Francisco do not already give.
    "seattle": {
        "city": "Seattle",
        "url": "https://data.seattle.gov/resource/tazs-3rd5.json",
        "date": "offense_date", "lat": "latitude", "lng": "longitude",
        "area": "precinct", "sub": "beat", "type": "offense_category",
    },
}


def probe(spec: dict, start: str, end: str, token: str | None) -> None:
    """Fail fast if the portal renamed a field.

    Checking the keys of a sample row does not work: Socrata omits null fields per record, so
    an incident with no geocode simply has no ``latitude`` key and a present column looks
    absent. Instead we issue the real query for one row — a wrong column name comes back as
    an HTTP 400 that names the offending column, which is the unambiguous signal.
    """
    headers = {"X-App-Token": token} if token else {}
    fields = [spec[k] for k in ("date", "lat", "lng", "area", "sub", "type")]
    params = {
        "$select": ",".join(fields),
        "$where": (f"{spec['date']} >= '{start}T00:00:00' AND {spec['date']} < '{end}T00:00:00' "
                   f"AND {spec['lat']} IS NOT NULL"),
        "$limit": 1,
    }
    r = requests.get(spec["url"], params=params, headers=headers, timeout=60)
    if r.status_code == 400:
        cols = requests.get(spec["url"], params={"$limit": 50}, headers=headers, timeout=60)
        have: set[str] = set()
        if cols.ok:
            for row in cols.json():
                have |= set(row)
        # RuntimeError, not SystemExit: SystemExit derives from BaseException and would
        # escape the per-city handler, losing every city after the first bad portal.
        raise RuntimeError(f"{r.text.strip()[:300]}\ncolumns seen in sample: {sorted(have)}")
    r.raise_for_status()
    if not r.json():
        raise RuntimeError(f"no geocoded rows in {start}..{end}")


def fetch(spec: dict, start: str, end: str, page: int, token: str | None,
          limit: int | None) -> list[dict]:
    fields = [spec[k] for k in ("date", "lat", "lng", "area", "sub", "type")]
    where = (f"{spec['date']} >= '{start}T00:00:00' AND {spec['date']} < '{end}T00:00:00' "
             f"AND {spec['lat']} IS NOT NULL")
    headers = {"X-App-Token": token} if token else {}
    out: list[dict] = []
    offset = 0
    while True:
        params = {"$select": ",".join(fields), "$where": where,
                  "$order": spec["date"], "$limit": page, "$offset": offset}
        for attempt in range(5):
            try:
                r = requests.get(spec["url"], params=params, headers=headers, timeout=180)
                r.raise_for_status()
                batch = r.json()
                break
            except Exception:
                if attempt == 4:
                    raise
                # Socrata throttles unauthenticated clients hard; linear backoff is enough
                # and a retry framework here would be ceremony.
                time.sleep(4 * (attempt + 1))
        if not batch:
            break
        out.extend(batch)
        offset += page
        print(f"  {spec['city']}: {len(out):,} rows", flush=True)
        if len(batch) < page or (limit and len(out) >= limit):
            break
    return out[:limit] if limit else out


def normalise(rows: list[dict], spec: dict) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df = df.rename(columns={
        spec["date"]: "date", spec["lat"]: "latitude", spec["lng"]: "longitude",
        spec["area"]: "district", spec["sub"]: "taluk", spec["type"]: "head",
    })
    df["date"] = pd.to_datetime(df["date"], errors="coerce", format="mixed")
    for c in ("latitude", "longitude"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["date", "latitude", "longitude", "district", "taluk", "head"])
    # Coordinates of (0, 0) are the portals' unlocatable placeholder and would drag every
    # grid centroid into the Atlantic.
    df = df[(df.latitude.abs() > 0.01) & (df.longitude.abs() > 0.01)]
    df["state"] = spec["city"]
    df["district"] = df["district"].astype(str).str.strip().str.title()
    df["taluk"] = df["district"] + "-" + df["taluk"].astype(str).str.strip()
    df["head"] = df["head"].astype(str).str.strip().str.title()
    df["date"] = df["date"].dt.date
    return df[["date", "state", "district", "taluk", "latitude", "longitude", "head"]] \
        .sort_values("date").reset_index(drop=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", choices=sorted(CITIES))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--start", default="2018-01-01")
    ap.add_argument("--end", default="2024-01-01")
    ap.add_argument("--page", type=int, default=50000)
    ap.add_argument("--limit", type=int, default=None, help="cap rows per city")
    ap.add_argument("--out", default="datastore/train/cities")
    ap.add_argument("--token", default=os.environ.get("SOCRATA_TOKEN"))
    args = ap.parse_args()

    names = sorted(CITIES) if args.all else ([args.city] if args.city else [])
    if not names:
        raise SystemExit("pass --city <name> or --all")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    def one(name: str) -> str:
        spec = CITIES[name]
        dest = out / f"{name}.parquet"
        try:
            probe(spec, args.start, args.end, args.token)
            rows = fetch(spec, args.start, args.end, args.page, args.token, args.limit)
        except Exception as e:
            # One unreachable or restructured portal must not lose the cities that did work.
            return f"{spec['city']}: FAILED — {e}"
        df = normalise(rows, spec)
        if df.empty:
            return f"{spec['city']}: no usable rows after cleaning"
        df.to_parquet(dest, index=False)
        # Bracket access throughout: the offence column is called "head" to match the Indian
        # corpus, and df.head is DataFrame.head.
        return (f"{spec['city']}: {len(df):,} incidents -> {dest}\n"
                f"  span {df['date'].min()} .. {df['date'].max()}  "
                f"areas {df['district'].nunique()}  sub-areas {df['taluk'].nunique()}  "
                f"offence types {df['head'].nunique()}")

    # Each city is a few million rows fetched 50k at a time over a throttled HTTP API, so the
    # wall clock is almost entirely waiting on someone else's server. Running the cities
    # concurrently turns five serial waits into one.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        for msg in pool.map(one, names):
            print(msg, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
