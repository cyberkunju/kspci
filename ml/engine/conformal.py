"""Prediction intervals with distribution-free coverage guarantees.

Three calibrators, in increasing order of how well they behave on a heterogeneous panel:

* ``SplitConformal`` — one absolute-residual quantile for the whole panel. Simple, valid
  *marginally*, and misleading here: applied to a panel spanning two to twenty-two thousand
  events per unit it produces intervals far too narrow for the largest units and absurd for
  the smallest, while the aggregate coverage number sits reassuringly near 90%.

* ``MondrianConformal`` — a separate quantile per stratum (volume band). Restores
  conditional validity within each band, which is what makes a per-unit interval honest.

* ``ConformalizedQuantile`` — CQR. Calibrates the *quantile model's* own interval, so the
  width adapts per observation rather than per stratum. This is the strongest option and
  the one the engine prefers when a quantile model is available.

All three are calibrated on a window that is disjoint from both the training window and the
evaluation window. Calibrating on data the model was fitted on inflates coverage;
calibrating on the evaluation window makes the reported coverage circular.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def _finite_sample_quantile(residuals: np.ndarray, level: float) -> float:
    """The conformal quantile with the finite-sample correction.

    Using the plain empirical quantile under-covers on small calibration sets; the
    ``ceil((n+1)*level)/n`` order statistic is what actually delivers the guarantee.
    """
    r = np.asarray(residuals, dtype=np.float64)
    r = r[np.isfinite(r)]
    n = len(r)
    if n == 0:
        return 0.0
    k = min(1.0, np.ceil((n + 1) * level) / n)
    return float(np.quantile(r, k))


@dataclass
class SplitConformal:
    level: float = 0.9
    q: float = 0.0

    def fit(self, pred: np.ndarray, actual: np.ndarray) -> "SplitConformal":
        self.q = _finite_sample_quantile(np.abs(actual - pred), self.level)
        return self

    def interval(self, pred: np.ndarray, strata: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        return np.maximum(0.0, pred - self.q), pred + self.q

    def describe(self) -> dict:
        return {"method": "split-conformal", "level": self.level, "q": round(self.q, 3)}


@dataclass
class MondrianConformal:
    """Stratified (Mondrian) conformal: one quantile per stratum."""

    level: float = 0.9
    min_per_stratum: int = 30
    q_by_stratum: dict[int, float] = field(default_factory=dict)
    q_global: float = 0.0

    def fit(self, pred: np.ndarray, actual: np.ndarray, strata: np.ndarray) -> "MondrianConformal":
        res = np.abs(actual - pred)
        self.q_global = _finite_sample_quantile(res, self.level)
        self.q_by_stratum = {}
        for s in np.unique(strata):
            m = strata == s
            # A stratum with too few calibration points cannot support its own quantile;
            # falling back to the global one is honest, silently using a noisy quantile is
            # not.
            if m.sum() >= self.min_per_stratum:
                self.q_by_stratum[int(s)] = _finite_sample_quantile(res[m], self.level)
        return self

    def interval(self, pred: np.ndarray, strata: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        if strata is None:
            return np.maximum(0.0, pred - self.q_global), pred + self.q_global
        q = np.array([self.q_by_stratum.get(int(s), self.q_global) for s in strata], dtype=np.float64)
        return np.maximum(0.0, pred - q), pred + q

    def describe(self) -> dict:
        return {
            "method": "mondrian-conformal (stratified by volume band)",
            "level": self.level,
            "q_global": round(self.q_global, 3),
            "q_by_band": {k: round(v, 3) for k, v in sorted(self.q_by_stratum.items())},
        }


@dataclass
class ConformalizedQuantile:
    """CQR (Romano, Patterson & Candès 2019), stratified.

    Calibrates the additive correction to a quantile model's own lower and upper bounds
    using the conformity score ``max(lo - y, y - hi)``. Because the base interval already
    varies with the observation, the corrected interval is adaptive rather than constant
    width — the property that makes it usable across a heterogeneous panel.
    """

    level: float = 0.9
    min_per_stratum: int = 30
    e_by_stratum: dict[int, float] = field(default_factory=dict)
    e_global: float = 0.0

    def fit(self, lo: np.ndarray, hi: np.ndarray, actual: np.ndarray, strata: np.ndarray | None = None) -> "ConformalizedQuantile":
        score = np.maximum(lo - actual, actual - hi)
        self.e_global = _finite_sample_quantile(score, self.level)
        self.e_by_stratum = {}
        if strata is not None:
            for s in np.unique(strata):
                m = strata == s
                if m.sum() >= self.min_per_stratum:
                    self.e_by_stratum[int(s)] = _finite_sample_quantile(score[m], self.level)
        return self

    def interval(self, lo: np.ndarray, hi: np.ndarray, strata: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        if strata is None:
            e = np.full(len(lo), self.e_global)
        else:
            e = np.array([self.e_by_stratum.get(int(s), self.e_global) for s in strata], dtype=np.float64)
        return np.maximum(0.0, lo - e), hi + e

    def describe(self) -> dict:
        return {
            "method": "conformalized quantile regression (CQR), stratified",
            "level": self.level,
            "e_global": round(self.e_global, 3),
            "e_by_band": {k: round(v, 3) for k, v in sorted(self.e_by_stratum.items())},
        }
