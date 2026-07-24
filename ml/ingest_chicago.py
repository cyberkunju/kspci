"""
Ingest real Chicago crime incidents (City of Chicago open data, dataset ijzp-q8t2)
via the Socrata API. Incident-level, geocoded, timestamped — the battle-testing corpus.

Saves a compact Parquet with only the fields we need for spatio-temporal forecasting.

Usage: python ingest_chicago.py --start 2015-01-01 --end 2024-01-01 --out data/chicago.parquet
"""
import argparse, time, sys, os
import requests
import pandas as pd

RES = "https://data.cityofchicago.org/resource/ijzp-q8t2.json"
FIELDS = ["id", "date", "primary_type", "latitude", "longitude", "beat", "district", "arrest", "domestic"]


def fetch(start, end, page=50000, app_token=None):
    sel = ",".join(FIELDS)
    where = f"date >= '{start}T00:00:00' AND date < '{end}T00:00:00' AND latitude IS NOT NULL"
    headers = {"X-App-Token": app_token} if app_token else {}
    offset, out = 0, []
    while True:
        params = {"$select": sel, "$where": where, "$order": "date", "$limit": page, "$offset": offset}
        for attempt in range(5):
            try:
                r = requests.get(RES, params=params, headers=headers, timeout=120)
                r.raise_for_status()
                batch = r.json()
                break
            except Exception as e:
                if attempt == 4:
                    raise
                time.sleep(3 * (attempt + 1))
        if not batch:
            break
        out.extend(batch)
        offset += page
        sys.stdout.write(f"\r  fetched {len(out):,} rows…")
        sys.stdout.flush()
        if len(batch) < page:
            break
    print()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2015-01-01")
    ap.add_argument("--end", default="2024-01-01")
    ap.add_argument("--out", default="data/chicago.parquet")
    ap.add_argument("--token", default=os.environ.get("SOCRATA_TOKEN"))
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    print(f"Pulling Chicago incidents {args.start} .. {args.end}")
    rows = fetch(args.start, args.end, app_token=args.token)
    df = pd.DataFrame(rows)
    if df.empty:
        print("No rows returned."); return
    # types
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    for c in ["latitude", "longitude"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["arrest"] = df["arrest"].astype(str).str.lower().isin(["true", "1"])
    df["domestic"] = df["domestic"].astype(str).str.lower().isin(["true", "1"])
    df = df.dropna(subset=["date", "latitude", "longitude", "beat"])
    df["beat"] = df["beat"].astype(str).str.zfill(4)
    df = df.sort_values("date").reset_index(drop=True)
    df.to_parquet(args.out, index=False)
    print(f"Saved {len(df):,} rows -> {args.out}")
    print(f"  span: {df['date'].min()} .. {df['date'].max()}")
    print(f"  beats: {df['beat'].nunique()}  districts: {df['district'].nunique()}  types: {df['primary_type'].nunique()}")
    print("  top types:")
    print(df["primary_type"].value_counts().head(8).to_string())


if __name__ == "__main__":
    main()
