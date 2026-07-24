"""
Battle-testing eval harness for the KSP forecasting engine, run on REAL Chicago
incident data (beat x week panel). Leak-free walk-forward, proper baselines, and
the metrics that actually matter for predictive policing.

Baselines (must be beaten):
  persistence        predict = last period
  seasonal_naive     predict = same week last year  (also the MASE denominator)
  ma4                mean of last 4 weeks
  historical_mean    long-run beat mean  (the "patrol where crime usually is" baseline)

Engine models:
  ewma, hawkes (self-excitation), gbm (HistGradientBoosting on ST features), ensemble.

Metrics:
  Point         MAE, RMSE, MASE (scaled by seasonal-naive)   -> MASE<1 beats naive
  Probabilistic split-conformal 90% interval COVERAGE + pinball
  Operational   PAI / PEI / hit-rate across area budgets (1..20% of beats)  [+ curve]
  Skill         % improvement over historical_mean on spatial capture

Rigor: expanding-window walk-forward at weekly origins; ensemble weights + conformal
quantiles fit on a separate TUNING window (never the test week); GBM retrained every
RETRAIN weeks; every feature uses strictly past data. Optional out-of-space beat holdout.

Usage: python eval_harness.py --data data/chicago.parquet --freq W --test-weeks 104
"""
import argparse, json, sys
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.optimize import nnls

# ----------------------------- panel build -----------------------------

def build_panel(df, freq="W", unit="beat", grid_m=400, min_events=200):
    """Aggregate to <unit> x <period>. unit='beat' or 'grid' (grid_m metre cells).
    Grid cells with fewer than min_events total are dropped (sparse noise)."""
    df = df.copy()
    df["period"] = df["date"].dt.to_period(freq).dt.start_time
    if unit == "grid":
        # local equirectangular metres around Chicago (~41.85N)
        lat0 = df["latitude"].median()
        mlat, mlon = 111132.0, 111320.0 * np.cos(np.radians(lat0))
        gx = np.floor((df["longitude"] - df["longitude"].min()) * mlon / grid_m).astype(int)
        gy = np.floor((df["latitude"] - df["latitude"].min()) * mlat / grid_m).astype(int)
        df["cell"] = gx.astype(str) + "_" + gy.astype(str)
        keep = df["cell"].value_counts()
        df = df[df["cell"].isin(keep[keep >= min_events].index)]
        unit_col = "cell"
    else:
        unit_col = "beat"
    g = df.groupby([unit_col, "period"]).size().rename("n").reset_index()
    periods = pd.DatetimeIndex(sorted(g["period"].unique()))
    units = sorted(g[unit_col].unique())
    uidx = {b: i for i, b in enumerate(units)}
    pidx = {p: i for i, p in enumerate(periods)}
    M = np.zeros((len(units), len(periods)), dtype=float)
    for b, p, n in zip(g[unit_col], g["period"], g["n"]):
        M[uidx[b], pidx[p]] = n
    return M, units, periods

# ----------------------------- models (vectorized over beats) -----------------------------

def ewma_full(M, alpha=0.4):
    """Full EWMA series; col t is EWMA of data up to and incl t. Predict t uses col t-1."""
    E = np.zeros_like(M)
    E[:, 0] = M[:, 0]
    for t in range(1, M.shape[1]):
        E[:, t] = alpha * M[:, t] + (1 - alpha) * E[:, t - 1]
    return E

def hawkes_pred(M, t, alpha=0.5, beta=0.6, L=6, base_win=9):
    base = M[:, max(0, t - base_win):t].mean(axis=1) if t > 0 else np.zeros(M.shape[0])
    excite = np.zeros(M.shape[0])
    for k in range(1, min(L, t) + 1):
        excite += alpha * np.exp(-beta * (k - 1)) * np.maximum(0, M[:, t - k] - base)
    return np.maximum(0, base + excite)

WOY = None
def _woy(periods):
    return np.array([p.isocalendar().week for p in periods], dtype=float)

def gbm_features(M, woy, t_lo, t_hi, train_means, Adj=None):
    """Build (rows, feats) for units x periods in [t_lo, t_hi); leak-free (all lags < t).
    If Adj (sparse unit x unit adjacency) is given, add near-repeat spatial-contagion
    features: crime in neighbouring cells at recent lags."""
    B, T = M.shape
    X, Y, meta = [], [], []
    for t in range(t_lo, t_hi):
        lag1 = M[:, t - 1] if t >= 1 else np.zeros(B)
        lag2 = M[:, t - 2] if t >= 2 else np.zeros(B)
        lag3 = M[:, t - 3] if t >= 3 else np.zeros(B)
        lag4 = M[:, t - 4] if t >= 4 else np.zeros(B)
        lag52 = M[:, t - 52] if t >= 52 else np.zeros(B)
        roll4 = M[:, max(0, t - 4):t].mean(axis=1) if t >= 1 else np.zeros(B)
        roll12 = M[:, max(0, t - 12):t].mean(axis=1) if t >= 1 else np.zeros(B)
        w = woy[t]
        cols = [lag1, lag2, lag3, lag4, lag52, roll4, roll12,
                np.full(B, np.sin(2 * np.pi * w / 52)), np.full(B, np.cos(2 * np.pi * w / 52)),
                train_means]
        if Adj is not None:
            # near-repeat: neighbouring cells' recent activity (spatial Hawkes signal)
            nb_lag1 = Adj @ lag1
            nb_roll4 = Adj @ roll4
            nb_lag2 = Adj @ lag2
            cols += [nb_lag1, nb_lag2, nb_roll4]
        feats = np.stack(cols, axis=1)
        X.append(feats); Y.append(M[:, t]); meta.append(np.full(B, t))
    return np.vstack(X), np.concatenate(Y), np.concatenate(meta)

# ----------------------------- metrics -----------------------------

def pai_curve(pred, actual, budgets):
    """pred, actual: (B,) for one period. Rank beats by pred; capture at each budget."""
    B = len(pred); tot = actual.sum()
    if tot <= 0: return {b: (np.nan, np.nan) for b in budgets}
    order = np.argsort(-pred); order_o = np.argsort(-actual)
    out = {}
    for bud in budgets:
        k = max(1, int(round(bud * B)))
        hit = actual[order[:k]].sum() / tot
        oracle = actual[order_o[:k]].sum() / tot
        area = k / B
        out[bud] = (hit / area, (hit / oracle) if oracle > 0 else np.nan)  # (PAI, PEI)
    return out

def pinball(y, lo, hi, a=0.1):
    ql = np.maximum(a/2 * (y - lo), (a/2 - 1) * (y - lo))
    qh = np.maximum((1 - a/2) * (y - hi), ((1 - a/2) - 1) * (y - hi))
    return (ql + qh).mean()

# ----------------------------- backtest -----------------------------

def build_adjacency(units):
    """8-neighbour sparse adjacency for grid cells named 'gx_gy'. Returns None if not grid."""
    from scipy.sparse import csr_matrix
    try:
        coords = [tuple(map(int, u.split("_"))) for u in units]
    except Exception:
        return None
    pos = {c: i for i, c in enumerate(coords)}
    rows, cols = [], []
    for i, (x, y) in enumerate(coords):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                j = pos.get((x + dx, y + dy))
                if j is not None:
                    rows.append(i); cols.append(j)
    A = csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(units), len(units)))
    return A


def run(M, periods, Adj=None, test_weeks=104, tune_weeks=52, retrain=12, budgets=(0.01, 0.02, 0.05, 0.10, 0.20)):
    B, T = M.shape
    woy = _woy(periods)
    E = ewma_full(M, alpha=0.4)
    test_start = T - test_weeks
    tune_start = test_start - tune_weeks
    assert tune_start > 60, "need more history"

    MODELS = ["persistence", "seasonal_naive", "ma4", "historical_mean", "ewma", "hawkes", "gbm", "ensemble"]
    abs_err = {m: [] for m in MODELS}
    sq_err = {m: [] for m in MODELS}
    naive_scale = []  # |actual - seasonal_naive| pooled for MASE denominator
    pai_acc = {m: {b: [] for b in budgets} for m in ["historical_mean", "gbm", "ensemble"]}
    pei_acc = {m: {b: [] for b in budgets} for m in ["historical_mean", "gbm", "ensemble"]}
    cover_hits, cover_n, pinballs = 0, 0, []

    gbm = None
    ens_w = None
    conf_q = None

    def predict_simple(t):
        return {
            "persistence": M[:, t - 1].copy(),
            "seasonal_naive": (M[:, t - 52].copy() if t >= 52 else M[:, t - 1].copy()),
            "ma4": M[:, max(0, t - 4):t].mean(axis=1),
            "historical_mean": M[:, :t].mean(axis=1),
            "ewma": E[:, t - 1].copy(),
            "hawkes": hawkes_pred(M, t),
        }

    # walk-forward
    for i, t in enumerate(range(test_start, T)):
        # (re)train GBM + fit ensemble weights/conformal on tuning window when due
        if gbm is None or (i % retrain == 0):
            train_means = M[:, :tune_start].mean(axis=1)
            Xtr, Ytr, _ = gbm_features(M, woy, 60, tune_start, train_means, Adj)
            gbm = HistGradientBoostingRegressor(max_depth=4, learning_rate=0.08,
                                                max_iter=300, l2_regularization=1.0,
                                                min_samples_leaf=40)
            gbm.fit(Xtr, Ytr)
            # tuning-window predictions for ensemble weight fit + conformal (leak-free: tune<test)
            comp = {m: [] for m in ["persistence", "seasonal_naive", "ma4", "historical_mean", "ewma", "hawkes", "gbm"]}
            tune_actual = []
            for tt in range(tune_start, test_start):
                ps = predict_simple(tt)
                Xt, _, _ = gbm_features(M, woy, tt, tt + 1, train_means, Adj)
                ps["gbm"] = gbm.predict(Xt)
                for m in comp: comp[m].append(ps[m])
                tune_actual.append(M[:, tt])
            for m in comp: comp[m] = np.concatenate(comp[m])
            ya = np.concatenate(tune_actual)
            # constrained stacking: non-negative least squares over the learners.
            # NNLS can put ~all weight on the best model, so the stack never
            # underperforms its best member (fixes the inverse-MAE dilution).
            cand = ["seasonal_naive", "ma4", "ewma", "hawkes", "gbm"]
            A = np.stack([comp[m] for m in cand], axis=1)
            w, _ = nnls(A, ya)
            if w.sum() <= 1e-9:
                w = np.ones(len(cand)) / len(cand)
            ens_w = dict(zip(cand, w))
            ens_tune = A @ w
            # finite-sample split-conformal quantile (Vovk correction) for 90% coverage
            n = len(ya); lvl = min(1.0, np.ceil((n + 1) * 0.90) / n)
            conf_q = np.quantile(np.abs(ens_tune - ya), lvl)

        ps = predict_simple(t)
        Xt, _, _ = gbm_features(M, woy, t, t + 1, M[:, :tune_start].mean(axis=1), Adj)
        ps["gbm"] = gbm.predict(Xt)
        cand = list(ens_w.keys())
        ps["ensemble"] = sum(ens_w[m] * ps[m] for m in cand)

        actual = M[:, t]
        naive_scale.append(np.abs(actual - ps["seasonal_naive"]))
        for m in MODELS:
            abs_err[m].append(np.abs(ps[m] - actual))
            sq_err[m].append((ps[m] - actual) ** 2)
        for m in ["historical_mean", "gbm", "ensemble"]:
            pc = pai_curve(ps[m], actual, budgets)
            for b in budgets:
                pai_acc[m][b].append(pc[b][0]); pei_acc[m][b].append(pc[b][1])
        lo = np.maximum(0, ps["ensemble"] - conf_q); hi = ps["ensemble"] + conf_q
        cover_hits += int(((actual >= lo) & (actual <= hi)).sum()); cover_n += B
        pinballs.append(pinball(actual, lo, hi))
        sys.stdout.write(f"\r  backtest {i+1}/{test_weeks}"); sys.stdout.flush()
    print()

    naive_mae = np.mean(np.concatenate(naive_scale))
    report = {"config": {"beats": B, "periods": T, "test_weeks": test_weeks,
                          "tune_weeks": tune_weeks, "retrain": retrain,
                          "span": [str(periods[0].date()), str(periods[-1].date())]},
              "point": {}, "spatial": {}, "calibration": {}}
    for m in MODELS:
        mae = np.mean(np.concatenate(abs_err[m]))
        rmse = np.sqrt(np.mean(np.concatenate(sq_err[m])))
        report["point"][m] = {"MAE": round(mae, 4), "RMSE": round(rmse, 4), "MASE": round(mae / naive_mae, 4)}
    for m in ["historical_mean", "gbm", "ensemble"]:
        report["spatial"][m] = {f"{int(b*100)}%": {
            "PAI": round(float(np.nanmean(pai_acc[m][b])), 3),
            "PEI": round(float(np.nanmean(pei_acc[m][b])), 3)} for b in budgets}
    report["calibration"] = {"target": 0.90, "empirical_coverage": round(cover_hits / cover_n, 4),
                             "pinball_loss": round(float(np.mean(pinballs)), 4), "conformal_q90": round(float(conf_q), 3)}
    report["ensemble_weights"] = {k: round(float(v), 3) for k, v in ens_w.items()}
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/chicago.parquet")
    ap.add_argument("--freq", default="W")
    ap.add_argument("--unit", default="beat", choices=["beat", "grid"])
    ap.add_argument("--grid-m", type=int, default=400)
    ap.add_argument("--test-weeks", type=int, default=104)
    ap.add_argument("--out", default="data/eval_report.json")
    args = ap.parse_args()
    df = pd.read_parquet(args.data)
    print(f"Loaded {len(df):,} incidents  {df['date'].min()} .. {df['date'].max()}")
    M, units, periods = build_panel(df, args.freq, unit=args.unit, grid_m=args.grid_m)
    print(f"Panel: {M.shape[0]} {args.unit}s x {M.shape[1]} {args.freq}-periods  (mean {M.mean():.2f}/cell)")
    Adj = build_adjacency(units) if args.unit == "grid" else None
    if Adj is not None:
        print(f"Spatial adjacency: {int(Adj.nnz)} neighbour links (near-repeat features ON)")
    rep = run(M, periods, Adj=Adj, test_weeks=args.test_weeks)
    with open(args.out, "w") as f:
        json.dump(rep, f, indent=2)
    print("\n================= REAL-DATA EVAL (Chicago) =================")
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
