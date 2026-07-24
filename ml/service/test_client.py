"""Validate the AppSail forecast service: build a real beat x month panel from the
Chicago data and POST it to the running service."""
import json, requests, pandas as pd

df = pd.read_parquet("../data/chicago.parquet")
df["ym"] = df["date"].dt.to_period("M").dt.start_time
g = df.groupby(["beat", "ym"]).size().rename("n").reset_index()
months = sorted(g["ym"].unique())
mi = {m: i for i, m in enumerate(months)}
series = {}
for b, sub in g.groupby("beat"):
    arr = [0] * len(months)
    for m, n in zip(sub["ym"], sub["n"]):
        arr[mi[m]] = int(n)
    series[str(b)] = arr

payload = {"series": series, "period": 12, "horizonLabel": "next-month", "budgets": [0.05, 0.1, 0.2]}
r = requests.post("http://127.0.0.1:9000/forecast", json=payload, timeout=120)
d = r.json()
print("status", r.status_code)
print("units", d.get("units"), "periods", d.get("periods"),
      "fitOrigins", d.get("fitOrigins"), "evalOrigins", d.get("evalOrigins"))
print("weights", d.get("weights"))
print("accuracy", json.dumps(d.get("accuracy"), indent=2))
print("spatial", json.dumps(d.get("spatial"), indent=2))
print("top forecasts:", json.dumps(d.get("forecasts", [])[:5], indent=2))
