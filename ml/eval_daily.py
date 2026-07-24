"""
DAILY-resolution forecasting engine on real Chicago data, with exogenous covariate
fusion (weather, holidays, calendar) and near-repeat spatial-contagion features.
This is where near-repeat and weather actually fire — the scientifically right setting.

Baselines: persistence(lag1), seasonal_naive(lag7 = same weekday last week),
           ma7, historical_dow (per-unit weekday mean).
Engine:    GBM (HistGradientBoosting) with temporal lags + rolling + calendar +
           weather + near-repeat neighbour lags; NNLS-stacked ensemble; conformal PIs.

Metrics:   MAE / RMSE / MASE(vs lag7) ; PAI/PEI curve ; 90% interval coverage.
Rigor:     expanding-window walk-forward daily origins; ensemble weights + conformal
           fit on a separate tuning window; GBM retrained every RETRAIN days; leak-free.

Usage: python eval_daily.py --unit grid --grid-m 700 --test-days 120
"""
import argparse, json, sys
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.optimize import nnls
from scipy.sparse import csr_matrix


def build_panel(df, unit="beat", grid_m=700, min_events=400):
    df = df.copy()
    df["day"] = df["date"].dt.floor("D")
    if unit == "grid":
        lat0 = df["latitude"].median()
        mlat, mlon = 111132.0, 111320.0 * np.cos(np.radians(lat0))
        gx = np.floor((df["longitude"] - df["longitude"].min()) * mlon / grid_m).astype(int)
        gy = np.floor((df["latitude"] - df["latitude"].min()) * mlat / grid_m).astype(int)
        df["cell"] = gx.astype(str) + "_" + gy.astype(str)
        keep = df["cell"].value_counts()
        df = df[df["cell"].isin(keep[keep >= min_events].index)]
        col = "cell"
    else:
        col = "beat"
    days = pd.date_range(df["day"].min(), df["day"].max(), freq="D")
    units = sorted(df[col].unique())
    uidx = {u: i for i, u in enumerate(units)}
    didx = {d: i for i, d in enumerate(days)}
    M = np.zeros((len(units), len(days)), dtype=float)
    g = df.groupby([col, "day"]).size()
    for (u, d), n in g.items():
        M[uidx[u], didx[d]] = n
    return M, units, days


def adjacency(units):
    try:
        coords = [tuple(map(int, u.split("_"))) for u in units]
    except Exception:
        return None
    pos = {c: i for i, c in enumerate(coords)}
    rows, cols = [], []
    for i, (x, y) in enumerate(coords):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0: continue
                j = pos.get((x + dx, y + dy))
                if j is not None: rows.append(i); cols.append(j)
    return csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(units), len(units)))


def cov_matrix(days, cov):
    c = cov.set_index("date").reindex(days)
    dow = c["dow"].values
    doy = c["doy"].values
    feats = {
        "dow_sin": np.sin(2*np.pi*dow/7), "dow_cos": np.cos(2*np.pi*dow/7),
        "doy_sin": np.sin(2*np.pi*doy/365), "doy_cos": np.cos(2*np.pi*doy/365),
        "is_weekend": c["is_weekend"].values, "is_holiday": c["is_holiday"].values,
        "is_payday": c["is_payday"].values, "tmax": c["temperature_2m_max"].values,
        "precip": c["precipitation_sum"].values, "snow": c["snowfall_sum"].values,
        "wind": c["wind_speed_10m_max"].values,
    }
    names = list(feats.keys())
    return np.stack([feats[n] for n in names], axis=1), names  # (T, ncov)


def feats_at(M, C, t, umean, Adj):
    B = M.shape[0]
    lag1 = M[:, t-1]; lag7 = M[:, t-7]; lag14 = M[:, t-14]; lag28 = M[:, t-28]
    roll7 = M[:, t-7:t].mean(axis=1); roll28 = M[:, t-28:t].mean(axis=1)
    cols = [lag1, lag7, lag14, lag28, roll7, roll28, umean]
    if Adj is not None:
        cols += [Adj @ lag1, Adj @ roll7]
    base = np.stack(cols, axis=1)
    cov = np.tile(C[t], (B, 1))
    return np.hstack([base, cov])


def build_train(M, C, t_lo, t_hi, umean, Adj):
    X, Y = [], []
    for t in range(t_lo, t_hi):
        X.append(feats_at(M, C, t, umean, Adj)); Y.append(M[:, t])
    return np.vstack(X), np.concatenate(Y)


def pai_curve(pred, actual, budgets):
    B = len(pred); tot = actual.sum()
    if tot <= 0: return {b: (np.nan, np.nan) for b in budgets}
    o = np.argsort(-pred); oo = np.argsort(-actual); out = {}
    for bud in budgets:
        k = max(1, int(round(bud*B)))
        hit = actual[o[:k]].sum()/tot; orc = actual[oo[:k]].sum()/tot; area = k/B
        out[bud] = (hit/area, (hit/orc) if orc > 0 else np.nan)
    return out


def run(M, days, C, Adj, test_days=120, tune_days=90, retrain=30, warm=400,
        budgets=(0.01, 0.02, 0.05, 0.10, 0.20)):
    B, T = M.shape
    test_start = T - test_days; tune_start = test_start - tune_days
    MODELS = ["persistence", "seasonal_naive", "ma7", "historical_dow", "gbm", "ensemble"]
    abs_err = {m: [] for m in MODELS}; sq_err = {m: [] for m in MODELS}; naive = []
    pai = {m: {b: [] for b in budgets} for m in ["historical_dow", "gbm", "ensemble"]}
    pei = {m: {b: [] for b in budgets} for m in ["historical_dow", "gbm", "ensemble"]}
    cov_hit, cov_n, pin = 0, 0, []
    gbm = ens_w = conf_q = None
    dow_all = C[:, 0]  # placeholder; dow computed below via days

    dow = np.array([d.dayofweek for d in days])

    def dow_mean(t):
        # per-unit mean for this weekday over strictly-past data
        mask = np.where(dow[:t] == dow[t])[0]
        return M[:, mask].mean(axis=1) if len(mask) else M[:, :t].mean(axis=1)

    def simple(t):
        return {"persistence": M[:, t-1].copy(),
                "seasonal_naive": M[:, t-7].copy(),
                "ma7": M[:, t-7:t].mean(axis=1),
                "historical_dow": dow_mean(t)}

    for i, t in enumerate(range(test_start, T)):
        if gbm is None or (i % retrain == 0):
            umean = M[:, :tune_start].mean(axis=1)
            Xtr, Ytr = build_train(M, C, warm, tune_start, umean, Adj)
            gbm = HistGradientBoostingRegressor(max_depth=5, learning_rate=0.06,
                    max_iter=400, l2_regularization=1.0, min_samples_leaf=60)
            gbm.fit(Xtr, Ytr)
            comp = {m: [] for m in ["seasonal_naive", "ma7", "historical_dow", "gbm"]}
            ya = []
            for tt in range(tune_start, test_start):
                s = simple(tt)
                s["gbm"] = gbm.predict(feats_at(M, C, tt, umean, Adj))
                for m in comp: comp[m].append(s[m])
                ya.append(M[:, tt])
            for m in comp: comp[m] = np.concatenate(comp[m])
            ya = np.concatenate(ya)
            cand = ["seasonal_naive", "ma7", "historical_dow", "gbm"]
            A = np.stack([comp[m] for m in cand], axis=1)
            w, _ = nnls(A, ya)
            if w.sum() <= 1e-9: w = np.ones(len(cand))/len(cand)
            ens_w = dict(zip(cand, w))
            n = len(ya); lvl = min(1.0, np.ceil((n+1)*0.9)/n)
            conf_q = np.quantile(np.abs(A @ w - ya), lvl)

        s = simple(t)
        umean = M[:, :tune_start].mean(axis=1)
        s["gbm"] = gbm.predict(feats_at(M, C, t, umean, Adj))
        cand = list(ens_w.keys())
        s["ensemble"] = sum(ens_w[m]*s[m] for m in cand)
        actual = M[:, t]
        naive.append(np.abs(actual - s["seasonal_naive"]))
        for m in MODELS:
            abs_err[m].append(np.abs(s[m]-actual)); sq_err[m].append((s[m]-actual)**2)
        for m in ["historical_dow", "gbm", "ensemble"]:
            pc = pai_curve(s[m], actual, budgets)
            for b in budgets: pai[m][b].append(pc[b][0]); pei[m][b].append(pc[b][1])
        lo = np.maximum(0, s["ensemble"]-conf_q); hi = s["ensemble"]+conf_q
        cov_hit += int(((actual >= lo) & (actual <= hi)).sum()); cov_n += B
        sys.stdout.write(f"\r  daily backtest {i+1}/{test_days}"); sys.stdout.flush()
    print()
    nmae = np.mean(np.concatenate(naive))
    rep = {"config": {"units": B, "days": T, "test_days": test_days, "retrain": retrain,
                      "span": [str(days[0].date()), str(days[-1].date())]},
           "point": {}, "spatial": {}, "calibration": {}}
    for m in MODELS:
        mae = np.mean(np.concatenate(abs_err[m])); rmse = np.sqrt(np.mean(np.concatenate(sq_err[m])))
        rep["point"][m] = {"MAE": round(mae, 4), "RMSE": round(rmse, 4), "MASE": round(mae/nmae, 4)}
    for m in ["historical_dow", "gbm", "ensemble"]:
        rep["spatial"][m] = {f"{int(b*100)}%": {"PAI": round(float(np.nanmean(pai[m][b])), 3),
                             "PEI": round(float(np.nanmean(pei[m][b])), 3)} for b in budgets}
    rep["calibration"] = {"target": 0.9, "empirical_coverage": round(cov_hit/cov_n, 4),
                          "conformal_q90": round(float(conf_q), 3)}
    rep["ensemble_weights"] = {k: round(float(v), 3) for k, v in ens_w.items()}
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/chicago.parquet")
    ap.add_argument("--cov", default="data/covariates.parquet")
    ap.add_argument("--unit", default="beat", choices=["beat", "grid"])
    ap.add_argument("--grid-m", type=int, default=700)
    ap.add_argument("--test-days", type=int, default=120)
    ap.add_argument("--out", default="data/eval_daily.json")
    args = ap.parse_args()
    df = pd.read_parquet(args.data); cov = pd.read_parquet(args.cov)
    print(f"Loaded {len(df):,} incidents; covariates {len(cov)} days")
    M, units, days = build_panel(df, args.unit, args.grid_m)
    Adj = adjacency(units) if args.unit == "grid" else None
    C, cov_names = cov_matrix(days, cov)
    print(f"Daily panel: {M.shape[0]} {args.unit}s x {M.shape[1]} days (mean {M.mean():.3f}/cell-day)"
          + (f"; near-repeat ON ({Adj.nnz} links)" if Adj is not None else ""))
    print(f"Covariates: {cov_names}")
    rep = run(M, days, C, Adj, test_days=args.test_days)
    json.dump(rep, open(args.out, "w"), indent=2)
    print("\n============ DAILY REAL-DATA EVAL (Chicago) ============")
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
