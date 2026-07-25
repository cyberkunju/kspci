"""Model zoo.

Contains the baselines the engine must beat to justify itself, and the learned models.

Two choices here matter more than anything else in this file:

1. **Poisson objective.** Crime counts are Poisson-like: variance grows with the mean.
   Squared-error boosting on counts optimises the wrong thing — it concentrates capacity
   on the few high-volume units and treats a miss of 5 on a unit averaging 3 as
   equivalent to a miss of 5 on one averaging 600. The existing AppSail service uses
   default squared error; switching to Poisson is the cheapest real accuracy gain
   available and costs nothing at inference.

2. **The historical-pattern baseline is included and reported.** It is what a duty officer
   already does with a wall map: long-run mean for this unit in this seasonal slot. Any
   engine that cannot beat it is decoration. Beating seasonal-naive is not the bar.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:
    import lightgbm as lgb
except ImportError:  # pragma: no cover - environment guard
    lgb = None
from sklearn.ensemble import HistGradientBoostingRegressor


# --------------------------------------------------------------------- baselines
def seasonal_naive(counts: np.ndarray, t: int, season: int) -> np.ndarray:
    """Same seasonal slot, one cycle back. The MASE denominator."""
    if t - season >= 0:
        return counts[:, t - season].copy()
    return counts[:, max(0, t - 1)].copy()


def persistence(counts: np.ndarray, t: int) -> np.ndarray:
    return counts[:, max(0, t - 1)].copy()


def moving_average(counts: np.ndarray, t: int, k: int = 3) -> np.ndarray:
    lo = max(0, t - k)
    return counts[:, lo:t].mean(axis=1) if t > lo else counts[:, max(0, t - 1)].copy()


def historical_pattern(counts: np.ndarray, t: int, season: int, month: np.ndarray | None) -> np.ndarray:
    """Long-run mean for this unit in this seasonal slot — the police baseline.

    Uses only periods before ``t``. Falls back to the unit's overall history when the slot
    has not been seen enough times.
    """
    B = counts.shape[0]
    if t <= 0:
        return np.zeros(B, dtype=np.float32)
    hist = counts[:, :t]
    if month is not None and t < len(month):
        slot = month[:t] == month[t]
        if slot.sum() >= 2:
            return hist[:, slot].mean(axis=1)
    idx = np.arange(t)
    slot = (idx % season) == (t % season)
    if slot.sum() >= 2:
        return hist[:, slot].mean(axis=1)
    return hist.mean(axis=1)


def holt(counts: np.ndarray, t: int, alpha: float = 0.4, beta: float = 0.15) -> np.ndarray:
    """Vectorised Holt linear trend across all units at once."""
    if t < 2:
        return persistence(counts, t)
    h = counts[:, :t]
    level = h[:, 0].astype(np.float64)
    trend = (h[:, 1] - h[:, 0]).astype(np.float64)
    for i in range(1, t):
        prev = level
        level = alpha * h[:, i] + (1 - alpha) * (level + trend)
        trend = beta * (level - prev) + (1 - beta) * trend
    return np.maximum(0.0, level + trend).astype(np.float32)


BASELINES = ("seasonal_naive", "persistence", "ma3", "historical_pattern", "holt")


def baseline_preds(counts: np.ndarray, t: int, season: int, month: np.ndarray | None) -> dict[str, np.ndarray]:
    return {
        "seasonal_naive": seasonal_naive(counts, t, season),
        "persistence": persistence(counts, t),
        "ma3": moving_average(counts, t, 3),
        "historical_pattern": historical_pattern(counts, t, season, month),
        "holt": holt(counts, t),
    }


# ----------------------------------------------------------------- learned models
@dataclass
class PoissonGBM:
    """Gradient boosting with a Poisson objective.

    LightGBM when available, otherwise scikit-learn's ``HistGradientBoostingRegressor`` with
    ``loss="poisson"``. The fallback matters because the AppSail serving environment installs
    dependencies as vendored wheels and LightGBM needs a binary wheel plus libgomp; sklearn is
    already there. Both optimise Poisson deviance, so the fallback is the same objective rather
    than the log-space approximation this used to do — that version trained on log1p targets
    and inverted, which is not the same estimator and quietly biases predictions low.

    The backend is recorded on every run and in every report, so results are never compared
    across backends by accident.
    """

    booster: object | None = None
    backend: str = "none"

    def fit(self, X: np.ndarray, y: np.ndarray, rounds: int = 400, seed: int = 7) -> "PoissonGBM":
        if len(X) < 40:
            return self
        # An all-zero target happens on a real panel: a stray record far outside the data's
        # actual range stretches the timeline, and a training window can land entirely inside
        # the empty stretch. A Poisson objective is undefined there — sklearn raises and
        # LightGBM fits a degenerate model — so the honest response is to stay unfitted and let
        # the caller fall back to a baseline.
        if not np.any(np.asarray(y) > 0):
            return self
        if lgb is not None:
            ds = lgb.Dataset(X, label=y, free_raw_data=True)
            params = {
                "objective": "poisson",
                "metric": "poisson",
                "learning_rate": 0.05,
                "num_leaves": 63,
                "min_data_in_leaf": 40,
                "feature_fraction": 0.85,
                "bagging_fraction": 0.85,
                "bagging_freq": 1,
                "lambda_l2": 1.0,
                "max_bin": 255,
                "verbosity": -1,
                "seed": seed,
                "num_threads": 0,
            }
            self.booster = lgb.train(params, ds, num_boost_round=rounds)
            self.backend = "lightgbm-poisson"
        else:
            g = HistGradientBoostingRegressor(
                loss="poisson", max_depth=6, learning_rate=0.06, max_iter=350,
                l2_regularization=1.0, min_samples_leaf=30, random_state=seed,
            )
            # The Poisson loss requires non-negative targets; counts are, but a caller passing
            # residuals would otherwise get an opaque sklearn error.
            g.fit(X, np.maximum(0.0, y))
            self.booster = g
            self.backend = "sklearn-histgb-poisson"
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.booster is None:
            return np.zeros(len(X), dtype=np.float32)
        return np.maximum(0.0, self.booster.predict(X)).astype(np.float32)


@dataclass
class QuantileGBM:
    """A set of quantile regressors giving a full predictive distribution.

    Point forecasts alone cannot support a deployment decision — a commander needs to know
    whether a predicted 40 could plausibly be 90. Nine quantiles also make the distribution
    scorable with CRPS and enable conformalised quantile regression, which adapts interval
    width per unit instead of applying one width to a panel spanning four orders of
    magnitude.
    """

    quantiles: tuple[float, ...] = (0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95)
    boosters: dict[float, object] = None
    backend: str = "none"

    def fit(self, X: np.ndarray, y: np.ndarray, rounds: int = 250, seed: int = 7) -> "QuantileGBM":
        self.boosters = {}
        if len(X) < 60 or not np.any(np.asarray(y) > 0):
            return self
        if lgb is None:
            # sklearn's quantile loss, so the serving environment gets a real predictive
            # distribution instead of silently dropping to point forecasts with no CQR. Fewer
            # iterations than LightGBM because nine sequential sklearn fits are the slowest
            # part of a refresh and the marginal accuracy past this is negligible.
            for q in self.quantiles:
                g = HistGradientBoostingRegressor(
                    loss="quantile", quantile=q, max_depth=5, learning_rate=0.08,
                    max_iter=150, l2_regularization=1.0, min_samples_leaf=40,
                    random_state=seed,
                )
                g.fit(X, y)
                self.boosters[q] = g
            self.backend = "sklearn-histgb-quantile"
            return self
        for q in self.quantiles:
            ds = lgb.Dataset(X, label=y, free_raw_data=True)
            params = {
                "objective": "quantile", "alpha": q, "metric": "quantile",
                "learning_rate": 0.06, "num_leaves": 31, "min_data_in_leaf": 40,
                "feature_fraction": 0.85, "lambda_l2": 1.0,
                "verbosity": -1, "seed": seed, "num_threads": 0,
            }
            self.boosters[q] = lgb.train(params, ds, num_boost_round=rounds)
        self.backend = "lightgbm-quantile"
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        """(N, Q) predicted quantiles, sorted so the distribution is monotone."""
        if not self.boosters:
            return np.zeros((len(X), 0), dtype=np.float32)
        out = np.stack(
            [np.maximum(0.0, self.boosters[q].predict(X)) for q in self.quantiles], axis=1
        ).astype(np.float32)
        # Quantile regressors are fitted independently and can cross; sorting restores a
        # valid distribution and is standard practice.
        return np.sort(out, axis=1)


def nnls_weights(P: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Non-negative least-squares stacking weights over candidate predictions.

    Non-negativity keeps the ensemble interpretable — every member contributes or is
    dropped, and no member is used to cancel another, which is what makes stacked weights
    fragile out of sample.
    """
    from scipy.optimize import nnls

    w, _ = nnls(np.asarray(P, dtype=np.float64), np.asarray(y, dtype=np.float64))
    if w.sum() <= 1e-9:
        return np.full(P.shape[1], 1.0 / P.shape[1])
    return w
