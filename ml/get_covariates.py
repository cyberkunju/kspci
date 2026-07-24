"""
Pull exogenous daily covariates for Chicago 2014-2023:
  - weather (Open-Meteo historical archive, free, no key): tmax, tmin, precip, snow, wind
  - US federal holidays + day-of-week / month calendar features
Saved to data/covariates.parquet keyed by date.
"""
import requests, pandas as pd, numpy as np, holidays as hol

LAT, LON = 41.8781, -87.6298
START, END = "2014-01-01", "2023-12-31"


def weather():
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": LAT, "longitude": LON, "start_date": START, "end_date": END,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,wind_speed_10m_max",
        "timezone": "America/Chicago",
    }
    r = requests.get(url, params=params, timeout=120)
    r.raise_for_status()
    d = r.json()["daily"]
    df = pd.DataFrame(d)
    df["date"] = pd.to_datetime(df["time"])
    df = df.drop(columns=["time"])
    return df


def main():
    w = weather()
    print(f"weather rows: {len(w)}  {w['date'].min().date()}..{w['date'].max().date()}")
    days = pd.date_range(START, END, freq="D")
    us = hol.US(years=range(2014, 2024))
    cal = pd.DataFrame({"date": days})
    cal["dow"] = cal["date"].dt.dayofweek
    cal["month"] = cal["date"].dt.month
    cal["doy"] = cal["date"].dt.dayofyear
    cal["is_weekend"] = (cal["dow"] >= 5).astype(int)
    cal["is_holiday"] = cal["date"].isin(pd.to_datetime(list(us.keys()))).astype(int)
    # payday proxy: 1st and 15th
    cal["is_payday"] = cal["date"].dt.day.isin([1, 15]).astype(int)
    out = cal.merge(w, on="date", how="left")
    # fill any missing weather
    for c in ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "snowfall_sum", "wind_speed_10m_max"]:
        out[c] = out[c].interpolate().bfill().ffill()
    out.to_parquet("data/covariates.parquet", index=False)
    print(f"Saved {len(out)} daily covariate rows -> data/covariates.parquet")
    print(out.head(3).to_string())


if __name__ == "__main__":
    main()
