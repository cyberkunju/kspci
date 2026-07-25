"""Feature construction for the pooled forecasting model.

Every feature at origin ``t`` is computed from strictly earlier periods. That is the whole
discipline of this file: one lookahead in a lag or a rolling mean produces a backtest that
looks excellent and a deployed model that does not work, and the failure is invisible in
the metrics.

Design notes worth stating:

* Counts are log1p-transformed for the *features*. The model is pooled across units, and
  on raw counts a panel spanning single-digit to four-digit volumes is dominated by the
  largest units. In log space the model learns proportional behaviour, which transfers.
* The *target* stays a raw count, because the gradient-boosted models use a Poisson
  objective. Squared error on counts is the wrong loss for this problem and silently
  penalises the many small units into irrelevance.
* Neighbour and self-excitation features exist because crime is a spatio-temporal point
  process, not B independent series. Their value is measured, not assumed — the ablation
  in ``evaluate`` reports what each block contributes.
"""

from __future__ import annotations

import numpy as np

from .panel import Panel

L1P = np.log1p


def feature_names(season: int, n_neigh: int, with_pop: bool) -> list[str]:
    names = [
        "lag1", "lag2", "lag3", "lag4",
        "lag_season", "lag_season_p1",
        "roll3", "roll6", "roll12",
        "trend_3_6", "trend_6_12",
        "dispersion6",
        "zero_run",
        "sin_season", "cos_season",
        "hawkes_excess", "hawkes_decay",
    ]
    if n_neigh:
        names += ["neigh_lag1", "neigh_roll3", "neigh_trend"]
    if with_pop:
        names += ["log_pop"]
    names += ["unit_mean_hist"]
    return names


def build_at(
    counts: np.ndarray,
    t: int,
    season: int,
    month: np.ndarray | None,
    neigh: np.ndarray | None,
    pop: np.ndarray | None,
    hist_mean: np.ndarray,
) -> np.ndarray:
    """Feature block for every unit at a single origin ``t``. Returns (B, F).

    ``hist_mean`` must be computed on a prefix that ends at or before ``t`` — it is passed
    in rather than derived here so the caller owns that guarantee.
    """
    B = counts.shape[0]

    def lag(k: int) -> np.ndarray:
        return L1P(counts[:, t - k]) if t - k >= 0 else np.zeros(B, dtype=np.float32)

    def roll(k: int) -> np.ndarray:
        lo = max(0, t - k)
        return L1P(counts[:, lo:t].mean(axis=1)) if t > lo else np.zeros(B, dtype=np.float32)

    lag1, lag2, lag3, lag4 = lag(1), lag(2), lag(3), lag(4)
    lag_s = lag(season)
    lag_s1 = lag(season + 1)
    r3, r6, r12 = roll(3), roll(6), roll(12)

    # Volatility of the recent window, in log space, so a unit that swings wildly is
    # distinguishable from a steady one at the same level.
    lo6 = max(0, t - 6)
    win6 = counts[:, lo6:t]
    dispersion6 = (
        L1P(win6.std(axis=1)) if win6.shape[1] > 1 else np.zeros(B, dtype=np.float32)
    )

    # How long this unit has been at zero. Sparse units behave differently from active
    # ones at the same rolling mean, and a tree can exploit that directly.
    zero_run = np.zeros(B, dtype=np.float32)
    for k in range(1, min(12, t) + 1):
        still = counts[:, t - k] == 0
        zero_run += still
        if not still.any():
            break

    # Seasonal position. Uses the calendar month where available so a weekly panel still
    # carries an annual cycle, which a raw index modulo would smear.
    if month is not None and t < len(month):
        ph = 2.0 * np.pi * (month[t] - 1) / 12.0
    else:
        ph = 2.0 * np.pi * (t % season) / season
    sin_s = np.full(B, np.sin(ph), dtype=np.float32)
    cos_s = np.full(B, np.cos(ph), dtype=np.float32)

    # Self-excitation. This is the near-repeat term: recent excess over the unit's own
    # baseline, decayed. It is the one feature block with a mechanism specific to crime.
    base = hist_mean
    excess = np.zeros(B, dtype=np.float32)
    decay = np.zeros(B, dtype=np.float32)
    for k in range(1, min(6, t) + 1):
        w = float(np.exp(-0.6 * (k - 1)))
        e = np.maximum(0.0, counts[:, t - k] - base)
        excess += e
        decay += w * e
    hawkes_excess = L1P(excess)
    hawkes_decay = L1P(decay)

    blocks = [
        lag1, lag2, lag3, lag4, lag_s, lag_s1, r3, r6, r12,
        r3 - r6, r6 - r12, dispersion6, zero_run, sin_s, cos_s,
        hawkes_excess, hawkes_decay,
    ]

    if neigh is not None and neigh.shape[1] > 0:
        # Neighbour aggregates, again strictly from the past.
        nl1 = L1P(counts[neigh, t - 1].mean(axis=1)) if t >= 1 else np.zeros(B, dtype=np.float32)
        lo3 = max(0, t - 3)
        nr3 = (
            L1P(counts[neigh, lo3:t].mean(axis=(1, 2)))
            if t > lo3 else np.zeros(B, dtype=np.float32)
        )
        lo6n = max(0, t - 6)
        nr6 = (
            L1P(counts[neigh, lo6n:t].mean(axis=(1, 2)))
            if t > lo6n else np.zeros(B, dtype=np.float32)
        )
        blocks += [nl1, nr3, nr3 - nr6]

    if pop is not None:
        blocks.append(L1P(np.asarray(pop, dtype=np.float32) * 1e4))

    blocks.append(L1P(hist_mean))

    return np.stack(blocks, axis=1).astype(np.float32)


def build_training_set(
    panel: Panel,
    t_lo: int,
    t_hi: int,
    neigh: np.ndarray | None,
    hist_mean: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pooled design matrix over origins [t_lo, t_hi).

    Returns (X, y, unit_index). ``y`` is a raw count, for the Poisson objective.
    """
    Xs, ys, us = [], [], []
    idx = np.arange(panel.B, dtype=np.int32)
    for t in range(t_lo, t_hi):
        Xs.append(build_at(panel.counts, t, panel.season, panel.month, neigh, panel.pop, hist_mean))
        ys.append(panel.counts[:, t])
        us.append(idx)
    if not Xs:
        n_f = len(feature_names(panel.season, 0 if neigh is None else neigh.shape[1], panel.pop is not None))
        return np.zeros((0, n_f), np.float32), np.zeros(0, np.float32), np.zeros(0, np.int32)
    return np.vstack(Xs), np.concatenate(ys), np.concatenate(us)
