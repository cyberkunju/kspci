"""KSP Forecasting Engine — served on Catalyst AppSail.

This runs the **same** ``engine`` package that produced every number in ml/RESULTS.md:
LightGBM with a Poisson objective, nine quantile regressors, NNLS-stacked ensemble against
the police historical-pattern baseline, and Mondrian/CQR conformal intervals chosen on
measured width at equal coverage.

Why this service exists at all. The Catalyst Function that used to answer /analytics/forecast
fitted a model inside the HTTP request, under a 25-second ceiling — which is why the live
service was pinned to the coarsest resolution it could get away with. Worse, it was a *second*
implementation: squared-error boosting and a single global conformal quantile, so the published
accuracy figures did not describe what the API actually returned. A forecast served by
different code than the code its accuracy was measured on is an unvalidated forecast.

AppSail is a long-running container with no per-request ceiling and a real Docker image, so
LightGBM installs normally and the full engine runs unchanged. A national 640-district monthly
panel takes ~45 s here, which is fine for a batch refresh and impossible in a function.

Contract: the caller sends the panel it already assembled from the Data Store; this service
does no data access, which keeps the trust boundary at the function and means this container
holds no credentials.
"""

from __future__ import annotations

import os
import sys

# Must precede every third-party import. AppSail's managed Python runtime does not install
# requirements.txt, so the dependencies are vendored into ./vendor by deploy.sh and put on the
# path here. ./ is added too, for the engine package copied in alongside.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "vendor"))
sys.path.insert(0, _HERE)

from typing import Dict, List, Optional  # noqa: E402

import numpy as np  # noqa: E402,F401
from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from engine import Panel, forecast_next  # noqa: E402
from engine import models as MD  # noqa: E402

app = FastAPI(title="KSP Forecasting Engine", version="3.0")

SEASON = {"month": 12, "week": 52, "day": 365}


class UnitMeta(BaseModel):
    lat: Optional[float] = None
    lng: Optional[float] = None
    pop: Optional[float] = None


class PanelIn(BaseModel):
    """A units x periods count panel — the engine's single input contract."""

    series: Dict[str, List[float]]
    labels: List[str] = Field(default_factory=list)
    months: List[int] = Field(default_factory=list)
    period: str = "month"
    level: Optional[str] = None
    unitMeta: Dict[str, UnitMeta] = Field(default_factory=dict)
    calibFrac: float = 0.2
    neighbours: int = 5
    withQuantiles: bool = True
    level90: float = Field(0.9, alias="intervalLevel")

    class Config:
        populate_by_name = True


def _to_panel(p: PanelIn) -> Panel:
    units = list(p.series.keys())
    if not units:
        raise HTTPException(400, "empty panel")
    T = max(len(v) for v in p.series.values())
    counts = np.array([(list(v) + [0.0] * (T - len(v)))[:T] for v in p.series.values()],
                      dtype=np.float32)
    labels = p.labels[:T] if len(p.labels) >= T else [str(i) for i in range(T)]

    # Calendar month per period drives the seasonal features. Derived from the labels when the
    # caller does not send it, because guessing it as a plain index would silently destroy the
    # seasonal signal rather than fail.
    months = p.months[:T] if len(p.months) >= T else []
    if len(months) < T:
        months = []
        for lab in labels:
            try:
                months.append(int(str(lab)[5:7]))
            except Exception:
                months.append((len(months) % 12) + 1)
    month = np.array(months[:T], dtype=np.int16)

    lat = lng = pop = None
    if p.unitMeta:
        lat = np.array([(p.unitMeta.get(u).lat if p.unitMeta.get(u) else None) or np.nan
                        for u in units], dtype=np.float64)
        lng = np.array([(p.unitMeta.get(u).lng if p.unitMeta.get(u) else None) or np.nan
                        for u in units], dtype=np.float64)
        pop = np.array([(p.unitMeta.get(u).pop if p.unitMeta.get(u) else None) or 0.0
                        for u in units], dtype=np.float64)
        if not np.isfinite(lat).any():
            lat = lng = None

    period = p.period if p.period in SEASON else "month"
    return Panel(units=units, counts=counts, period=period, season=SEASON[period],
                 labels=labels, month=month, lat=lat, lng=lng, pop=pop,
                 meta={"level": p.level, "source": "catalyst-datastore"})


@app.get("/")
@app.get("/health")
def health():
    return {
        "service": "ksp-forecast-engine",
        "status": "ok",
        "version": "3.0",
        "engine": "engine/serve — Poisson GBM + quantile GBM, NNLS ensemble, Mondrian/CQR conformal",
        "lightgbm": MD.lgb is not None,
        "validated": "ml/RESULTS.md — 28 panels on 6.37M real incidents across 5 cities, "
                     "plus 56 configurations on a 27.4M-incident synthetic corpus",
    }


@app.post("/forecast")
def forecast(p: PanelIn):
    panel = _to_panel(p)
    try:
        return forecast_next(panel, calib_frac=p.calibFrac, n_neighbours=p.neighbours,
                             with_quantiles=p.withQuantiles, level=p.level90)
    except ValueError as e:
        # Too little history is a client-side condition, not a server fault: the caller chose
        # the scope. A 500 here would send an operator hunting the wrong problem.
        raise HTTPException(422, str(e))


if __name__ == "__main__":
    import uvicorn

    # The port must come from AppSail or the container is unreachable and the platform reports
    # only "check the startup command or port". Order matters: the startup command's
    # ${X_ZOHO_CATALYST_LISTEN_PORT} is not always shell-expanded, in which case argv[1] is the
    # literal placeholder, so a failed parse has to fall through to the environment rather than
    # quietly keeping a default.
    def _port() -> int:
        for cand in (sys.argv[1] if len(sys.argv) > 1 else None,
                     os.getenv("X_ZOHO_CATALYST_LISTEN_PORT"),
                     os.getenv("PORT")):
            try:
                p = int(str(cand))
                if 1 <= p <= 65535:
                    return p
            except (TypeError, ValueError):
                continue
        return 9000

    port = _port()
    print(f"KSP forecast engine starting on port {port} "
          f"(argv={sys.argv[1:]}, env={os.getenv('X_ZOHO_CATALYST_LISTEN_PORT')})", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port)
