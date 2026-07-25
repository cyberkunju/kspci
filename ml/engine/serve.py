"""Forward forecasting for production serving.

``walkforward.evaluate`` answers "how good is this configuration", which is what a results
document needs. Serving needs a different question answered: "what is the count next period,
and how uncertain is it". This module answers that one, reusing the same features, models and
calibrators so the served forecast is produced by the code its accuracy claims were measured
on. A separate serving implementation is how a system ends up with published metrics that do
not describe what it actually returns — which was the case here, with the AppSail service
running its own squared-error model.

Layout of the history, which is the part that has to be right:

    |<---------- fit ---------->|<-- calibrate -->| next
    0                        t_calib             T    T+1

* Models are fitted on origins before ``t_calib``.
* Conformal quantiles come from predictions on the calibration window, which the models
  never saw. Calibrating on the fit window inflates coverage.
* The returned forecast is for period ``T`` — one step past the last observation — produced by
  models refitted on **all** history, because at serving time there is no reason to withhold
  the most recent data from the fit. Only the calibration quantiles come from the held-out
  window.
"""

from __future__ import annotations

import time

import numpy as np

from . import features as FT
from . import metrics as MT
from . import models as MD
from .conformal import ConformalizedQuantile, MondrianConformal
from .panel import Panel

BAND_NAMES = ("xs", "s", "m", "l", "xl")


def _band_name(b: int) -> str:
    return BAND_NAMES[int(np.clip(b, 0, len(BAND_NAMES) - 1))]


def forecast_next(
    panel: Panel,
    calib_frac: float = 0.2,
    n_neighbours: int = 5,
    with_quantiles: bool = True,
    level: float = 0.9,
    seed: int = 7,
) -> dict:
    """One-step-ahead forecast per unit, with calibrated intervals.

    Returns a payload shaped for the API: per-unit point forecast, interval, baseline and
    trend, plus the model weights and the accuracy actually measured on the calibration
    window. The accuracy numbers are held-out, so they describe this forecast rather than
    flattering it.
    """
    t0 = time.time()
    T, B = panel.T, panel.B
    if T < panel.season + 6:
        raise ValueError(
            f"not enough history: {T} {panel.period}s for a season of {panel.season}. "
            f"Need at least {panel.season + 6}."
        )

    n_calib = max(2, int(round(T * calib_frac)))
    t_calib = max(panel.season + 2, T - n_calib)
    if t_calib >= T:
        raise ValueError("history too short to hold out a calibration window")

    neigh = panel.neighbours(n_neighbours) if n_neighbours else None
    bands = panel.size_band(upto=t_calib)

    # ---------------------------------------------------------- fit for calibration
    hist_mean = panel.mean_volume(upto=t_calib)
    X, y, _ = FT.build_training_set(panel, panel.season + 2, t_calib, neigh, hist_mean)
    gbm = MD.PoissonGBM().fit(X, y, seed=seed)
    qgbm = MD.QuantileGBM().fit(X, y, seed=seed) if with_quantiles else MD.QuantileGBM()

    members = [m for m in MD.BASELINES if m != "seasonal_naive"] + ["poisson_gbm"]
    P: dict[str, list[np.ndarray]] = {m: [] for m in members}
    naive, actual, qrows = [], [], []
    for t in range(t_calib, T):
        base = MD.baseline_preds(panel.counts, t, panel.season, panel.month)
        Xt = FT.build_at(panel.counts, t, panel.season, panel.month, neigh, panel.pop,
                         panel.mean_volume(upto=t))
        base["poisson_gbm"] = gbm.predict(Xt) if gbm.booster is not None else base["ma3"]
        for m in members:
            P[m].append(base[m])
        if qgbm.boosters:
            qrows.append(qgbm.predict(Xt))
        naive.append(base["seasonal_naive"])
        actual.append(panel.counts[:, t])

    flat = {m: np.concatenate(v) for m, v in P.items()}
    y_cal = np.concatenate(actual)
    naive_cal = np.concatenate(naive)

    # Ensemble weights on the calibration window. With one held-out window the weights and
    # the conformal quantiles share it, so the reported coverage is mildly optimistic; that
    # is a deliberate trade for keeping the whole of a short history usable, and it is stated
    # in the payload rather than left for someone to discover.
    Pmat = np.stack([flat[m] for m in members], axis=1)
    w = MD.nnls_weights(Pmat, y_cal)
    w = w / w.sum()
    weights = {m: round(float(x), 4) for m, x in zip(members, w)}
    ens_cal = Pmat @ w

    strata_cal = np.tile(bands, len(actual))[: len(y_cal)]
    mondrian = MondrianConformal(level).fit(ens_cal, y_cal, strata_cal)
    cqr = None
    if qrows:
        Q = np.concatenate(qrows)
        qs = MD.QuantileGBM().quantiles
        cqr = ConformalizedQuantile(level).fit(
            Q[:, qs.index(0.05)], Q[:, qs.index(0.95)], y_cal, strata_cal)

    accuracy = {
        "window": {"calibration_origins": len(actual), "fit_origins": t_calib},
        "mase": {m: round(MT.mase(flat[m], y_cal, naive_cal), 4) for m in members},
        "mae": round(MT.mae(ens_cal, y_cal), 3),
        "bias": round(MT.bias(ens_cal, y_cal), 3),
    }
    accuracy["mase"]["seasonal_naive"] = 1.0
    accuracy["mase"]["ENSEMBLE"] = round(MT.mase(ens_cal, y_cal, naive_cal), 4)
    accuracy["achievability"] = MT.achievability(
        ens_cal, y_cal, naive_cal, dispersion=panel.dispersion_bracket(upto=t_calib))
    # Which calibrated interval to serve. CQR is adaptive and usually the better choice, but
    # not unconditionally: with a short monthly history its 5% quantile model is poorly
    # determined for the largest units, and the corrected interval comes out wide and skewed
    # with the point forecast sitting near its top — technically valid, useless to a commander
    # deciding where to send a shift. Both are calibrated to the same level here, so whichever
    # is narrower at equal coverage is strictly better and it is chosen on measurement.
    lo_m, hi_m = mondrian.interval(ens_cal, strata_cal)
    cand_intervals = {"mondrian": (lo_m, hi_m)}
    if cqr is not None:
        Qc = np.concatenate(qrows)
        qs = MD.QuantileGBM().quantiles
        cand_intervals["cqr"] = cqr.interval(
            Qc[:, qs.index(0.05)], Qc[:, qs.index(0.95)], strata_cal)

    scored = {}
    for nm, (lo_i, hi_i) in cand_intervals.items():
        scored[nm] = {
            "coverage": round(MT.coverage(lo_i, hi_i, y_cal), 4),
            "width": round(MT.interval_width(lo_i, hi_i), 2),
        }
    # Prefer a candidate that reaches the nominal level (with a small tolerance); among those,
    # take the narrowest. If neither reaches it, take the highest coverage.
    ok = [nm for nm, s in scored.items() if s["coverage"] >= level - 0.02]
    chosen = (min(ok, key=lambda nm: scored[nm]["width"]) if ok
              else max(scored, key=lambda nm: scored[nm]["coverage"]))
    accuracy["intervals"] = scored
    accuracy["intervalChosen"] = chosen
    accuracy["coverage"] = scored[chosen]["coverage"]
    accuracy["spatial"] = MT.aggregate_spatial([
        MT.spatial_metrics((np.stack([P[m][i] for m in members], axis=1) @ w), actual[i],
                           (0.01, 0.05, 0.10, 0.20))
        for i in range(len(actual))
    ])

    # ------------------------------------------------------- refit on all history, predict
    hist_all = panel.mean_volume()
    Xa, ya, _ = FT.build_training_set(panel, panel.season + 2, T, neigh, hist_all)
    gbm_full = MD.PoissonGBM().fit(Xa, ya, seed=seed)
    qgbm_full = MD.QuantileGBM().fit(Xa, ya, seed=seed) if with_quantiles else MD.QuantileGBM()

    nxt = MD.baseline_preds(panel.counts, T, panel.season, panel.month)
    Xn = FT.build_at(panel.counts, T, panel.season, panel.month, neigh, panel.pop, hist_all)
    nxt["poisson_gbm"] = gbm_full.predict(Xn) if gbm_full.booster is not None else nxt["ma3"]
    point = np.maximum(0.0, np.stack([nxt[m] for m in members], axis=1) @ w)

    bands_full = panel.size_band()
    lo, hi = mondrian.interval(point, bands_full)
    interval_method = mondrian.describe()["method"]
    if chosen == "cqr" and cqr is not None and qgbm_full.boosters:
        Qn = qgbm_full.predict(Xn)
        qs = MD.QuantileGBM().quantiles
        lo, hi = cqr.interval(Qn[:, qs.index(0.05)], Qn[:, qs.index(0.95)], bands_full)
        interval_method = cqr.describe()["method"]

    # Baseline for the trend figure: the unit's mean over the last seasonal cycle. Comparing
    # against the immediately preceding period would make the trend a noise readout.
    look = min(panel.season, T)
    baseline = panel.counts[:, T - look:].mean(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        trend = np.where(baseline > 0, (point - baseline) / baseline * 100.0, 0.0)

    order = np.argsort(-point)
    forecasts = []
    for i in order:
        u = panel.units[i]
        state, district = (u.split("|", 1) + [None])[:2] if "|" in u else (None, u)
        forecasts.append({
            "unit": u,
            "state": state,
            "district": district,
            "name": district or state or u,
            "predicted": round(float(point[i]), 2),
            "low": round(float(lo[i]), 2),
            "high": round(float(hi[i]), 2),
            "baseline": round(float(baseline[i]), 2),
            "last": float(panel.counts[i, -1]),
            "trendPct": round(float(trend[i]), 1),
            "band": _band_name(bands_full[i]),
            "lat": None if panel.lat is None else (None if not np.isfinite(panel.lat[i]) else round(float(panel.lat[i]), 5)),
            "lng": None if panel.lng is None else (None if not np.isfinite(panel.lng[i]) else round(float(panel.lng[i]), 5)),
        })

    return {
        "engine": "ksp-engine/serve",
        "backends": {"point": gbm_full.backend, "quantile": qgbm_full.backend},
        "level": (panel.meta or {}).get("level"),
        "period": panel.period,
        "units": B,
        "periods": T,
        "horizon": _next_label(panel),
        "weights": weights,
        "intervalMethod": interval_method,
        "intervalLevel": level,
        "accuracy": accuracy,
        "caveat": ("Ensemble weights and conformal quantiles share one held-out window, so "
                   "reported coverage is mildly optimistic; ml/RESULTS.md carries the fully "
                   "disjoint walk-forward figures."),
        "forecasts": forecasts,
        "runtime_s": round(time.time() - t0, 2),
    }


def _next_label(panel: Panel) -> str | None:
    """Label for the period being forecast, continuing the panel's own labelling."""
    if not panel.labels:
        return None
    last = str(panel.labels[-1])
    if panel.period == "month" and len(last) >= 7 and last[4] == "-":
        y, m = int(last[:4]), int(last[5:7])
        m += 1
        if m > 12:
            m, y = 1, y + 1
        return f"{y}-{m:02d}"
    try:
        from datetime import date, timedelta

        d = date.fromisoformat(last[:10])
        step = {"day": 1, "week": 7}.get(panel.period)
        if step:
            return (d + timedelta(days=step)).isoformat()
    except Exception:
        pass
    return f"after {last}"
