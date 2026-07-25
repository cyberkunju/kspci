"""Scoring.

Point accuracy, distributional accuracy, and the operational spatial metrics from the NIJ
Real-Time Crime Forecasting Challenge. All three are reported together because they
disagree, and a model chosen on one alone is chosen badly: a model can win on MASE by
shrinking everything toward the mean while ranking hotspots no better than chance.
"""

from __future__ import annotations

import numpy as np


# ------------------------------------------------------------------ point accuracy
def mase(pred: np.ndarray, actual: np.ndarray, naive: np.ndarray) -> float:
    """Mean absolute scaled error. Below 1.0 beats seasonal-naive.

    Scale-free, so it can be averaged over units of wildly different volume — which is the
    reason it is the headline number rather than MAE.
    """
    denom = float(np.mean(np.abs(actual - naive)))
    if denom <= 1e-9:
        return float("nan")
    return float(np.mean(np.abs(pred - actual)) / denom)


def rmsse(pred: np.ndarray, actual: np.ndarray, naive: np.ndarray) -> float:
    """Root mean squared scaled error — MASE's squared-error sibling, tail-sensitive."""
    denom = float(np.mean((actual - naive) ** 2))
    if denom <= 1e-9:
        return float("nan")
    return float(np.sqrt(np.mean((pred - actual) ** 2) / denom))


def mae(pred: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean(np.abs(pred - actual)))


def bias(pred: np.ndarray, actual: np.ndarray) -> float:
    """Mean signed error. A forecast that is right on average but always low in the tail is
    a different failure from one that is noisy, and MAE hides the difference."""
    return float(np.mean(pred - actual))


# --------------------------------------------------------- distributional accuracy
def pinball(qpred: np.ndarray, actual: np.ndarray, quantiles: tuple[float, ...]) -> float:
    """Mean pinball (quantile) loss across the predicted quantiles."""
    if qpred.size == 0:
        return float("nan")
    a = actual[:, None]
    q = np.asarray(quantiles)[None, :]
    d = a - qpred
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


def crps_from_quantiles(qpred: np.ndarray, actual: np.ndarray, quantiles: tuple[float, ...]) -> float:
    """CRPS approximated from a quantile grid.

    The mean pinball loss over a uniform quantile grid converges to CRPS up to a factor of
    two, which is the standard approximation when a full predictive CDF is not available.
    """
    if qpred.size == 0:
        return float("nan")
    return 2.0 * pinball(qpred, actual, quantiles)


def coverage(lo: np.ndarray, hi: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean((actual >= lo) & (actual <= hi)))


def interval_width(lo: np.ndarray, hi: np.ndarray) -> float:
    """Mean interval width. Coverage without width is meaningless — an infinite interval
    covers everything."""
    return float(np.mean(hi - lo))


def pit_histogram(qpred: np.ndarray, actual: np.ndarray, quantiles: tuple[float, ...], bins: int = 10) -> list[float]:
    """Probability integral transform histogram.

    A calibrated forecast gives a flat PIT. A U shape means intervals are too narrow, a
    hump means too wide. This catches miscalibration that an aggregate coverage number
    near target will happily conceal.
    """
    if qpred.size == 0:
        return []
    q = np.asarray(quantiles)
    # Empirical CDF value of the observation within the predicted quantile grid.
    below = (qpred <= actual[:, None]).sum(axis=1)
    u = np.where(below == 0, 0.0, q[np.clip(below - 1, 0, len(q) - 1)])
    h, _ = np.histogram(u, bins=bins, range=(0.0, 1.0))
    return (h / max(1, h.sum())).round(4).tolist()


# --------------------------------------------------------------- spatial / operational
def spatial_metrics(pred: np.ndarray, actual: np.ndarray, budgets: tuple[float, ...]) -> dict:
    """Hit-rate, PAI and PEI at several flagged-area budgets, for one origin.

    PAI = hit-rate / area-fraction: how much more crime the flagged area captures than its
    size would give at random. PEI = hit-rate / oracle hit-rate: how close the ranking is
    to the best achievable at that budget, which is the fairer measure of the model's
    skill because PAI is bounded by concentration in the data rather than by the model.
    """
    B = len(pred)
    total = float(actual.sum())
    out = {}
    if total <= 0 or B == 0:
        return out
    order_pred = np.argsort(-pred)
    order_act = np.argsort(-actual)
    for b in budgets:
        k = max(1, int(round(b * B)))
        area = k / B
        cap = float(actual[order_pred[:k]].sum()) / total
        orc = float(actual[order_act[:k]].sum()) / total
        out[f"{b:.3f}"] = {
            "budget": b, "k": k, "hit_rate": cap,
            "pai": cap / area if area > 0 else 0.0,
            "pei": cap / orc if orc > 0 else float("nan"),
        }
    return out


def aggregate_spatial(per_origin: list[dict]) -> dict:
    """Average spatial metrics across origins, ignoring origins with no events."""
    if not per_origin:
        return {}
    keys = per_origin[0].keys()
    out = {}
    for k in keys:
        hr = [o[k]["hit_rate"] for o in per_origin if k in o]
        pai = [o[k]["pai"] for o in per_origin if k in o]
        pei = [o[k]["pei"] for o in per_origin if k in o and not np.isnan(o[k]["pei"])]
        out[k] = {
            "budget": per_origin[0][k]["budget"],
            "hit_rate": round(float(np.mean(hr)), 4) if hr else None,
            "pai": round(float(np.mean(pai)), 3) if pai else None,
            "pei": round(float(np.mean(pei)), 3) if pei else None,
        }
    return out


def recapture_rate(flagged_sets: list[set]) -> float:
    """Share of flagged units that stay flagged from one origin to the next.

    High persistence is expected — crime is sticky — but it is also the warning sign for a
    feedback loop: a model that always flags the same places will send patrols to the same
    places, which generates the records that confirm the model."""
    if len(flagged_sets) < 2:
        return float("nan")
    vals = [
        len(flagged_sets[i] & flagged_sets[i - 1]) / max(1, len(flagged_sets[i]))
        for i in range(1, len(flagged_sets))
    ]
    return float(np.mean(vals))
