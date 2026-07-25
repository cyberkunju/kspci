"""Panel representation: a units x periods count matrix with unit metadata.

Every dataset the engine touches — synthetic all-India, Chicago, Los Angeles, UK — is
reduced to this one shape. That is deliberate: the accuracy claim is about the method,
so the method must run unmodified across datasets, and the only way to guarantee that is
to give it a single input contract.

A panel is intentionally dense (zeros materialised). Crime panels at fine resolution are
mostly zeros, and every model here needs the zeros to be real observations rather than
missing rows.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Panel:
    """A dense count panel.

    Attributes:
        units:   unit identifiers, length B.
        counts:  (B, T) non-negative integer counts.
        period:  'month' | 'week' | 'day'.
        season:  number of periods in a seasonal cycle (12, 52, 365).
        labels:  human-readable period labels, length T.
        month:   (T,) calendar month per period, for seasonal features.
        dow:     (T,) day of week per period, or None for coarser periods.
        lat/lng: (B,) unit centroids, or None when the dataset has no geography.
        pop:     (B,) exposure weight per unit (population share), or None.
        meta:    free-form provenance.
    """

    units: list[str]
    counts: np.ndarray
    period: str
    season: int
    labels: list[str]
    month: np.ndarray | None = None
    dow: np.ndarray | None = None
    lat: np.ndarray | None = None
    lng: np.ndarray | None = None
    pop: np.ndarray | None = None
    meta: dict = field(default_factory=dict)

    # ------------------------------------------------------------------ shape
    @property
    def B(self) -> int:
        return self.counts.shape[0]

    @property
    def T(self) -> int:
        return self.counts.shape[1]

    def __post_init__(self):
        self.counts = np.asarray(self.counts, dtype=np.float32)
        if self.counts.ndim != 2:
            raise ValueError(f"counts must be 2-D, got {self.counts.shape}")
        if len(self.units) != self.counts.shape[0]:
            raise ValueError(f"{len(self.units)} units but {self.counts.shape[0]} rows")
        if len(self.labels) != self.counts.shape[1]:
            raise ValueError(f"{len(self.labels)} labels but {self.counts.shape[1]} columns")
        if (self.counts < 0).any():
            raise ValueError("counts contain negative values")

    # --------------------------------------------------------------- exposure
    def volume(self) -> np.ndarray:
        """Total count per unit."""
        return self.counts.sum(axis=1)

    def mean_volume(self, upto: int | None = None) -> np.ndarray:
        """Mean count per period per unit, optionally restricted to a prefix.

        Restricting to a prefix matters: anything derived from the full series and then
        used to stratify or weight an evaluation leaks the future into the split.
        """
        m = self.counts[:, :upto] if upto else self.counts
        return m.mean(axis=1) if m.shape[1] else np.zeros(self.B, dtype=np.float32)

    def size_band(self, upto: int | None = None) -> np.ndarray:
        """Order-of-magnitude volume band per unit, as an integer 0..4.

        Used to stratify conformal calibration. A single interval width cannot describe a
        metropolitan district and a Himalayan one at the same time; the aggregate coverage
        number stays near target while being wrong for nearly every individual unit.
        """
        mv = self.mean_volume(upto)
        return np.digitize(mv, [3.0, 15.0, 60.0, 250.0]).astype(np.int8)

    def dispersion_bracket(self, upto: int | None = None) -> tuple[float, float]:
        """Bracket the variance-to-mean ratio of the counts. Returns (low, high).

        This exists to correct the achievability bound. The Poisson floor assumes variance
        equals mean; clustered crime is over-dispersed, so the Poisson floor *understates*
        irreducible error and overstates how much headroom a better model could claim.

        Dispersion means variance at fixed intensity, and the variance of a unit's series
        over time is not that — it also contains trend and seasonality, which would be
        counted as noise. Successive differences remove whatever is common to adjacent
        periods, since E[(X_t - X_t-1)^2] = 2 sigma^2 when intensity is locally flat.

        A single number is not honestly available, so this returns a bracket:

        * **high** — plain successive differences. Any real period-to-period movement in
          intensity inflates it.
        * **low** — successive differences after dividing out the cross-sectional common
          factor (the shared national seasonal envelope). Removing that factor also removes
          some genuine independent variation, so it deflates.

        Checked against ground truth. Six independent realisations of the same intensity
        field give a district-week dispersion index of **1.705**; this bracket is
        [1.29, 1.99], which contains it, and neither endpoint alone is close enough to
        report as a point estimate. That is the whole reason for the bracket: real data
        arrives as one realisation and can never be replicated, so a point estimate here
        would be false precision that silently rewrites every headroom figure.
        """
        c = np.asarray(self.counts[:, :upto] if upto else self.counts, dtype=np.float64)
        # At daily resolution adjacent periods differ by the day-of-week cycle, which is not
        # noise, so the difference is taken a full cycle apart instead.
        lag = self.season if self.period == "day" else 1
        mean = float(np.mean(c))
        if c.shape[1] <= lag or mean <= 1e-9:
            return (1.0, 1.0)

        def vmr(m: np.ndarray) -> float:
            d = m[:, lag:] - m[:, :-lag]
            mu = float(np.mean(m))
            return max(1.0, float(np.mean(d ** 2) / 2.0) / mu) if mu > 1e-9 else 1.0

        high = vmr(c)
        tot = c.sum(axis=0)
        f = tot / max(1e-9, float(tot.mean()))
        low = vmr(c / np.where(f <= 0, 1.0, f))
        return (min(low, high), max(low, high))

    # ----------------------------------------------------------------- spatial
    def neighbours(self, k: int = 5) -> np.ndarray | None:
        """(B, k) indices of each unit's k nearest neighbours by centroid distance.

        Crime diffuses across administrative boundaries, so a unit's neighbours carry
        genuine signal that a per-unit model cannot see. Returns None when the dataset
        has no coordinates.
        """
        if self.lat is None or self.lng is None:
            return None
        lat = np.radians(np.asarray(self.lat, dtype=np.float64))
        lng = np.radians(np.asarray(self.lng, dtype=np.float64))
        # Equirectangular approximation: adequate for ranking neighbours within a country.
        x = np.cos(lat) * lng
        y = lat
        pts = np.stack([x, y], axis=1)
        d2 = ((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1)
        np.fill_diagonal(d2, np.inf)
        kk = min(k, self.B - 1)
        if kk <= 0:
            return None
        return np.argsort(d2, axis=1)[:, :kk].astype(np.int32)

    # --------------------------------------------------------------- selection
    def slice_periods(self, lo: int, hi: int) -> "Panel":
        return Panel(
            units=list(self.units), counts=self.counts[:, lo:hi], period=self.period,
            season=self.season, labels=self.labels[lo:hi],
            month=None if self.month is None else self.month[lo:hi],
            dow=None if self.dow is None else self.dow[lo:hi],
            lat=self.lat, lng=self.lng, pop=self.pop, meta=dict(self.meta),
        )

    def drop_empty_units(self, min_total: int = 1) -> "Panel":
        """Remove units with almost no activity.

        Kept explicit rather than automatic. Dropping them flatters every metric — a unit
        with two events in three years is unforecastable and its seasonal-naive error is
        near zero, which distorts MASE in both directions. Any run that drops units has to
        say so in its report.
        """
        keep = np.where(self.volume() >= min_total)[0]
        return Panel(
            units=[self.units[i] for i in keep], counts=self.counts[keep], period=self.period,
            season=self.season, labels=list(self.labels),
            month=self.month, dow=self.dow,
            lat=None if self.lat is None else self.lat[keep],
            lng=None if self.lng is None else self.lng[keep],
            pop=None if self.pop is None else self.pop[keep],
            meta={**self.meta, "dropped_units": self.B - len(keep), "min_total": min_total},
        )

    # ------------------------------------------------------------------- io
    @classmethod
    def from_json(cls, path: str) -> "Panel":
        """Load a panel written by ml/panel_from_seed.js."""
        with open(path) as fh:
            d = json.load(fh)
        units = list(d["units"])
        timeline = d["timeline"]
        counts = np.array([d["series"][u] for u in units], dtype=np.float32)
        period = d.get("period", "month")
        season = {"month": 12, "week": 52, "day": 365}.get(period, 12)
        month = np.array([t["month"] for t in timeline], dtype=np.int16)
        meta = {k: d.get(k) for k in ("level", "state", "head", "source")}
        lat = lng = pop = None
        if d.get("unitMeta"):
            um = d["unitMeta"]
            lat = np.array([(um.get(u) or {}).get("lat") or np.nan for u in units], dtype=np.float64)
            lng = np.array([(um.get(u) or {}).get("lng") or np.nan for u in units], dtype=np.float64)
            pop = np.array([(um.get(u) or {}).get("pop") or 0.0 for u in units], dtype=np.float64)
            if np.isnan(lat).all():
                lat = lng = None
        return cls(units=units, counts=counts, period=period, season=season,
                   labels=[t["label"] for t in timeline], month=month,
                   lat=lat, lng=lng, pop=pop, meta=meta)

    def describe(self) -> str:
        v = np.sort(self.volume())
        mv = self.mean_volume()
        return (
            f"panel {self.B} units x {self.T} {self.period}s "
            f"({self.B * self.T:,} cells, {int(self.counts.sum()):,} events)\n"
            f"  volume/unit  min {int(v[0])}  p10 {int(v[max(0, int(len(v) * .1))])}  "
            f"median {int(v[len(v) // 2])}  max {int(v[-1])}\n"
            f"  per-period   median {np.median(mv):.1f}  "
            f"zero cells {100.0 * (self.counts == 0).mean():.1f}%  "
            f"bands {np.bincount(self.size_band(), minlength=5).tolist()}"
        )
