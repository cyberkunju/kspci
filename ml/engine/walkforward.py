"""Leak-free expanding-window walk-forward evaluation.

The window discipline is the part that decides whether the reported numbers mean anything,
so it is stated explicitly rather than left to the reader:

    |<--- train --->|<-- stack -->|<-- calib -->|<------ test ------>|
    0              t_train       t_stack       t_calib             T

* **train**   — the gradient-boosted models see only origins before ``t_train``.
* **stack**   — NNLS ensemble weights are fitted here. Fitting them on the training window
                would reward whichever member overfitted hardest.
* **calib**   — conformal quantiles are fitted here. Reusing train or stack inflates
                coverage; reusing test makes the coverage figure circular.
* **test**    — every reported metric is measured here, and nowhere else.

Models are refitted every ``retrain_every`` origins on all data available at that point, so
the evaluation reflects a system that is periodically retrained in production rather than
one fitted once with hindsight.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from . import features as FT
from . import metrics as MT
from . import models as MD
from .conformal import ConformalizedQuantile, MondrianConformal, SplitConformal
from .panel import Panel

BUDGETS = (0.01, 0.05, 0.10, 0.20)


@dataclass
class Split:
    t_train: int
    t_stack: int
    t_calib: int
    T: int

    @property
    def n_test(self) -> int:
        return self.T - self.t_calib

    def describe(self) -> dict:
        return {
            "train_origins": self.t_train,
            "stack_origins": self.t_stack - self.t_train,
            "calib_origins": self.t_calib - self.t_stack,
            "test_origins": self.n_test,
        }


def make_split(T: int, season: int, test_frac: float = 0.25) -> Split:
    """Choose window boundaries.

    The minimum training length is one full seasonal cycle plus a few periods; without it
    the seasonal lag features are undefined and the model is asked to learn a cycle it has
    never seen.
    """
    min_train = season + 4
    n_test = max(3, int(round(T * test_frac)))
    n_calib = max(3, int(round(T * 0.15)))
    n_stack = max(3, int(round(T * 0.15)))
    t_train = max(min_train, T - n_test - n_calib - n_stack)
    t_stack = min(T - n_test - n_calib, t_train + n_stack)
    t_calib = min(T - n_test, t_stack + n_calib)
    return Split(t_train=t_train, t_stack=t_stack, t_calib=t_calib, T=T)


@dataclass
class Result:
    dataset: str
    panel: dict
    split: dict
    point: dict = field(default_factory=dict)
    distribution: dict = field(default_factory=dict)
    spatial: dict = field(default_factory=dict)
    conformal: dict = field(default_factory=dict)
    weights: dict = field(default_factory=dict)
    achievability: dict = field(default_factory=dict)
    diagnostics: dict = field(default_factory=dict)
    runtime_s: float = 0.0

    def summary(self) -> str:
        lines = [f"── {self.dataset} ──", "  " + self.panel.get("describe", ""),
                 f"  split: {self.split}"]
        lines.append("  point accuracy (test window):")
        for m, v in sorted(self.point.items(), key=lambda kv: (kv[1].get("mase") is None, kv[1].get("mase"))):
            lines.append(
                f"    {m:<22} MASE {v['mase']:.3f}  RMSSE {v['rmsse']:.3f}  "
                f"MAE {v['mae']:.2f}  bias {v['bias']:+.2f}"
            )
        if self.achievability:
            a = self.achievability
            lines.append(
                f"  achievability: Poisson noise floor MAE {a['poisson_floor_mae']} "
                f"vs achieved {a['achieved_mae']} → efficiency {a['efficiency']} "
                f"({a['headroom_pct']}% headroom remains); floor MASE {a['floor_mase']}"
            )
        if self.spatial:
            lines.append("  spatial (flagged-area budget → PAI / PEI / hit-rate):")
            for k, v in self.spatial.items():
                lines.append(
                    f"    {v['budget'] * 100:>5.1f}%   PAI {v['pai']:<6} PEI {v['pei']:<6} hit {v['hit_rate']}"
                )
        if self.distribution:
            d = self.distribution
            lines.append(
                f"  distribution: CRPS {d.get('crps')}  pinball {d.get('pinball')}"
            )
            for name, c in (d.get("intervals") or {}).items():
                lines.append(
                    f"    {name:<28} coverage {c['coverage'] * 100:5.1f}%  mean width {c['width']:.1f}"
                )
        return "\n".join(lines)


def evaluate(
    panel: Panel,
    dataset: str = "panel",
    test_frac: float = 0.25,
    retrain_every: int = 6,
    n_neighbours: int = 5,
    budgets: tuple[float, ...] = BUDGETS,
    with_quantiles: bool = True,
    seed: int = 7,
) -> Result:
    t_start = time.time()
    T, B = panel.T, panel.B
    sp = make_split(T, panel.season, test_frac)
    if sp.n_test < 2 or sp.t_train < panel.season + 2:
        raise ValueError(
            f"not enough history: T={T}, season={panel.season}. "
            f"Need at least {panel.season + 12} periods for a credible walk-forward."
        )

    neigh = panel.neighbours(n_neighbours) if n_neighbours else None
    strata_unit = panel.size_band(upto=sp.t_train)

    learned = ("poisson_gbm",)
    cand = list(MD.BASELINES) + list(learned)

    # Per-origin predictions, collected once and reused for every downstream calculation.
    store: dict[str, list[np.ndarray]] = {m: [] for m in cand}
    qstore: list[np.ndarray] = []
    actuals: list[np.ndarray] = []
    origins: list[int] = []

    gbm: MD.PoissonGBM | None = None
    qgbm: MD.QuantileGBM | None = None
    last_fit = -10 ** 9
    train_rows = 0

    for t in range(sp.t_train, T):
        # Refit on everything strictly before t, on the retrain cadence.
        if t - last_fit >= retrain_every or gbm is None:
            hist_mean_fit = panel.mean_volume(upto=t)
            X, y, _ = FT.build_training_set(panel, panel.season + 2, t, neigh, hist_mean_fit)
            train_rows = len(X)
            gbm = MD.PoissonGBM().fit(X, y, seed=seed)
            if with_quantiles:
                qgbm = MD.QuantileGBM().fit(X, y, seed=seed)
            last_fit = t

        hist_mean = panel.mean_volume(upto=t)
        base = MD.baseline_preds(panel.counts, t, panel.season, panel.month)
        Xt = FT.build_at(panel.counts, t, panel.season, panel.month, neigh, panel.pop, hist_mean)
        base["poisson_gbm"] = gbm.predict(Xt) if gbm else base["ma3"]

        for m in cand:
            store[m].append(base[m].astype(np.float32))
        if with_quantiles and qgbm is not None and qgbm.boosters:
            qstore.append(qgbm.predict(Xt))
        actuals.append(panel.counts[:, t].astype(np.float32))
        origins.append(t)

    idx_of = {t: i for i, t in enumerate(origins)}
    def rows(lo: int, hi: int) -> slice:
        return slice(idx_of[lo], idx_of[hi] if hi in idx_of else len(origins))

    def flat(m: str, lo: int, hi: int) -> np.ndarray:
        return np.concatenate(store[m][rows(lo, hi)])

    def flat_actual(lo: int, hi: int) -> np.ndarray:
        return np.concatenate(actuals[rows(lo, hi)])

    # ---------------------------------------------------- stack on the stack window
    stack_members = [m for m in cand if m != "seasonal_naive"]
    P_stack = np.stack([flat(m, sp.t_train, sp.t_stack) for m in stack_members], axis=1)
    y_stack = flat_actual(sp.t_train, sp.t_stack)
    w = MD.nnls_weights(P_stack, y_stack)
    w = w / w.sum()
    weights = {m: round(float(x), 4) for m, x in zip(stack_members, w)}

    def ensemble(lo: int, hi: int) -> np.ndarray:
        P = np.stack([flat(m, lo, hi) for m in stack_members], axis=1)
        return P @ w

    # --------------------------------------------- calibrate on the calib window
    ens_cal = ensemble(sp.t_stack, sp.t_calib)
    y_cal = flat_actual(sp.t_stack, sp.t_calib)
    n_cal_origins = idx_of[sp.t_calib] - idx_of[sp.t_stack] if sp.t_calib in idx_of else 0
    strata_cal = np.tile(strata_unit, max(1, n_cal_origins))[: len(y_cal)]

    split_cal = SplitConformal(0.9).fit(ens_cal, y_cal)
    mondrian = MondrianConformal(0.9).fit(ens_cal, y_cal, strata_cal)
    cqr = None
    if qstore:
        Q_cal = np.concatenate(qstore[rows(sp.t_stack, sp.t_calib)])
        qs = MD.QuantileGBM().quantiles
        i_lo, i_hi = qs.index(0.05), qs.index(0.95)
        cqr = ConformalizedQuantile(0.9).fit(Q_cal[:, i_lo], Q_cal[:, i_hi], y_cal, strata_cal)

    # ------------------------------------------------- measure on the test window
    y_test = flat_actual(sp.t_calib, T)
    naive_test = flat(("seasonal_naive"), sp.t_calib, T)
    n_test_origins = len(origins) - idx_of[sp.t_calib]
    strata_test = np.tile(strata_unit, n_test_origins)[: len(y_test)]

    point = {}
    for m in cand:
        p = flat(m, sp.t_calib, T)
        point[m] = {
            "mase": round(MT.mase(p, y_test, naive_test), 4),
            "rmsse": round(MT.rmsse(p, y_test, naive_test), 4),
            "mae": round(MT.mae(p, y_test), 3),
            "bias": round(MT.bias(p, y_test), 3),
            "weight": weights.get(m, 0.0),
        }
    ens_test = ensemble(sp.t_calib, T)
    achieve = MT.achievability(ens_test, y_test, naive_test)
    point["ENSEMBLE"] = {
        "mase": round(MT.mase(ens_test, y_test, naive_test), 4),
        "rmsse": round(MT.rmsse(ens_test, y_test, naive_test), 4),
        "mae": round(MT.mae(ens_test, y_test), 3),
        "bias": round(MT.bias(ens_test, y_test), 3),
        "weight": 1.0,
    }

    # Intervals, each measured on the same held-out window.
    intervals = {}
    lo_s, hi_s = split_cal.interval(ens_test)
    intervals["split-conformal (global)"] = {
        "coverage": round(MT.coverage(lo_s, hi_s, y_test), 4),
        "width": round(MT.interval_width(lo_s, hi_s), 2),
    }
    lo_m, hi_m = mondrian.interval(ens_test, strata_test)
    intervals["mondrian-conformal (by band)"] = {
        "coverage": round(MT.coverage(lo_m, hi_m, y_test), 4),
        "width": round(MT.interval_width(lo_m, hi_m), 2),
    }
    dist = {}
    if qstore and cqr is not None:
        Q_test = np.concatenate(qstore[rows(sp.t_calib, T)])
        qs = MD.QuantileGBM().quantiles
        dist["crps"] = round(MT.crps_from_quantiles(Q_test, y_test, qs), 4)
        dist["pinball"] = round(MT.pinball(Q_test, y_test, qs), 4)
        dist["pit"] = MT.pit_histogram(Q_test, y_test, qs)
        i_lo, i_hi = qs.index(0.05), qs.index(0.95)
        lo_c, hi_c = cqr.interval(Q_test[:, i_lo], Q_test[:, i_hi], strata_test)
        intervals["CQR (adaptive, stratified)"] = {
            "coverage": round(MT.coverage(lo_c, hi_c, y_test), 4),
            "width": round(MT.interval_width(lo_c, hi_c), 2),
        }
    dist["intervals"] = intervals

    # Per-band coverage: the check that catches an interval that is right on average and
    # wrong everywhere.
    per_band = {}
    for s in np.unique(strata_test):
        m = strata_test == s
        per_band[int(s)] = {
            "n": int(m.sum()),
            "split": round(MT.coverage(lo_s[m], hi_s[m], y_test[m]), 3),
            "mondrian": round(MT.coverage(lo_m[m], hi_m[m], y_test[m]), 3),
        }

    # ---------------------------------------------------------- spatial metrics
    per_origin_sp, per_origin_sn, flagged = [], [], []
    kflag = max(1, int(round(0.10 * B)))
    for i in range(idx_of[sp.t_calib], len(origins)):
        a = actuals[i]
        e = np.stack([store[m][i] for m in stack_members], axis=1) @ w
        per_origin_sp.append(MT.spatial_metrics(e, a, budgets))
        per_origin_sn.append(MT.spatial_metrics(store["historical_pattern"][i], a, budgets))
        flagged.append(set(np.argsort(-e)[:kflag].tolist()))

    spatial = MT.aggregate_spatial([o for o in per_origin_sp if o])
    spatial_baseline = MT.aggregate_spatial([o for o in per_origin_sn if o])

    conformal = {
        "split": split_cal.describe(),
        "mondrian": mondrian.describe(),
        "cqr": cqr.describe() if cqr else None,
        "coverage_by_band": per_band,
    }

    return Result(
        dataset=dataset,
        panel={
            "units": B, "periods": T, "period": panel.period, "season": panel.season,
            "events": int(panel.counts.sum()), "describe": panel.describe().replace("\n", "\n  "),
            **{k: v for k, v in (panel.meta or {}).items() if v is not None},
        },
        split=sp.describe(),
        point=point,
        distribution=dist,
        spatial=spatial,
        conformal=conformal,
        weights=weights,
        achievability=achieve,
        diagnostics={
            "gbm_backend": gbm.backend if gbm else None,
            "quantile_backend": qgbm.backend if qgbm else None,
            "train_rows_last_fit": train_rows,
            "retrain_every": retrain_every,
            "neighbours": 0 if neigh is None else int(neigh.shape[1]),
            "recapture_rate": round(MT.recapture_rate(flagged), 4),
            "spatial_baseline_historical_pattern": spatial_baseline,
        },
        runtime_s=round(time.time() - t_start, 1),
    )
