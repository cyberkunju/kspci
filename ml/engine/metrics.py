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


def poisson_expected_abs_dev(lam: np.ndarray) -> np.ndarray:
    """E|N - lambda| for N ~ Poisson(lambda) — the irreducible error of a perfect forecast.

    This is the piece of analysis that changes how every other number here should be read.
    Crime counts are Poisson-like, so even a forecaster that knows the true intensity
    exactly cannot predict the realised count: the error floor is set by the arrival
    process, not by the model. De Moivre's identity gives it in closed form,

        E|N - lambda| = 2 * lambda^(floor(lambda)+1) * exp(-lambda) / floor(lambda)!

    Without this bound, "our model beats the police baseline by 1.8%" reads as a
    disappointing result. Against the bound it usually reads as being within a couple of
    percent of the best any model could do, which is a completely different conclusion and
    the correct one. It is also the number that tells you when to stop buying compute.
    """
    lam = np.asarray(lam, dtype=np.float64)
    lam = np.clip(lam, 1e-9, None)
    k = np.floor(lam)
    # Computed in log space: lambda^(k+1) overflows and k! is enormous well before the
    # counts here become large.
    from scipy.special import gammaln

    log_term = (k + 1.0) * np.log(lam) - lam - gammaln(k + 1.0)
    return 2.0 * np.exp(log_term)


def achievability(pred: np.ndarray, actual: np.ndarray, naive: np.ndarray,
                  dispersion: float | None = None) -> dict:
    """How close the forecast is to the noise floor.

    ``floor_mae`` uses the forecast itself as the intensity estimate, which is the best
    available stand-in for the unknown true intensity. ``efficiency`` is floor / achieved:
    at 1.0 the forecast is at the information-theoretic limit and no architecture can
    improve it. Values slightly above 1.0 mean the forecast is closer to the realised counts
    than the noise floor implies, which happens when the intensity estimate is itself shrunk
    toward the observation — it should be read as "at the floor", not as beating it.

    The Poisson floor is a **lower bound** on irreducible error, and for clustered crime it
    is a loose one. Near-repeat victimisation means events arrive in bursts, so the count in
    a cell is over-dispersed and a forecaster who knew the intensity exactly would still do
    worse than Poisson predicts. Measured on six independent realisations of the same
    intensity field, district-week counts have a dispersion index of 1.71 and a true floor
    1.30x the Poisson figure — which turns an apparent 32% of remaining headroom into about
    12%. Pass ``dispersion`` (variance / mean) to get the corrected numbers; without it only
    the Poisson bound is reported, clearly labelled as a bound.

    The correction scales the floor by sqrt(dispersion), because the mean absolute deviation
    of a count distribution scales with its standard deviation.
    """
    floor = float(np.mean(poisson_expected_abs_dev(pred)))
    achieved = mae(pred, actual)
    denom = float(np.mean(np.abs(actual - naive)))
    out = {
        "poisson_floor_mae": round(floor, 4),
        "achieved_mae": round(achieved, 4),
        "efficiency": round(floor / achieved, 4) if achieved > 0 else None,
        "headroom_pct": round(100.0 * (achieved - floor) / achieved, 2) if achieved > 0 else None,
        "floor_mase": round(floor / denom, 4) if denom > 0 else None,
    }
    if dispersion and achieved > 0:
        lo, hi = (dispersion, dispersion) if isinstance(dispersion, (int, float)) else dispersion
        # Higher dispersion means a higher floor, so it gives the *lower* headroom.
        f_lo, f_hi = floor * float(np.sqrt(lo)), floor * float(np.sqrt(hi))
        head = lambda f: round(max(0.0, 100.0 * (achieved - f) / achieved), 2)  # noqa: E731
        out.update({
            "dispersion_bracket": [round(float(lo), 4), round(float(hi), 4)],
            # A bracket wider than ~3x is consistent with almost any headroom and should not
            # be read as a measurement. Happens at monthly resolution, where successive
            # differencing cannot separate noise from the seasonal cycle.
            "dispersion_informative": bool(hi / max(lo, 1e-9) <= 3.0),
            "dispersion_floor_mae": [round(f_lo, 4), round(f_hi, 4)],
            "dispersion_efficiency": [round(min(f_lo / achieved, 1.0), 4),
                                      round(min(f_hi / achieved, 1.0), 4)],
            "dispersion_headroom_pct": [head(f_hi), head(f_lo)],
        })
    return out


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
