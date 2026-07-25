"""Run the forecasting engine on Modal, fanned out across panels.

Why: evaluation is embarrassingly parallel across panels but serial per panel, and this
machine has four cores. The eighteen per-crime-group district panels take roughly two hours
locally and about three minutes when each gets its own container. Nothing about the engine
changes — the same ``engine`` package runs in the container, which is the point: an accuracy
claim that depends on where the code ran is not an accuracy claim.

Layout:
    Volume ``ksp-forecast``      /data/events.csv     the 27.4M-row incident table
                                 /data/panels/*.json  built panels
                                 /data/reports/*.json evaluation reports

Commands:
    # one-time: push the incident table (3.4 GB) so panels can be built in the cloud
    modal run ml/modal_app.py::push_events

    # build panels remotely and evaluate them, fanned out
    modal run ml/modal_app.py::build --level district --period week --split-head
    modal run ml/modal_app.py::sweep

    # grid panels for several metros at once, one container each
    modal run ml/modal_app.py::grid_sweep

    # pull reports back
    modal run ml/modal_app.py::fetch_reports
"""

from __future__ import annotations

import json
import os
import pathlib

import modal

APP = "ksp-forecast-engine"
HERE = pathlib.Path(__file__).parent

# The engine source is added to the image directly rather than mounted at call time, so a
# run is reproducible from the image alone.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "numpy>=2.0", "scipy>=1.13", "pandas>=2.2", "scikit-learn>=1.5",
        "lightgbm>=4.5", "duckdb>=1.1", "pyarrow>=17.0",
    )
    .add_local_dir(str(HERE / "engine"), remote_path="/root/engine")
    .add_local_file(str(HERE / "build_panels.py"), remote_path="/root/build_panels.py")
    .add_local_file(str(HERE / "hierarchical.py"), remote_path="/root/hierarchical.py")
)

# Node plus the reference data, for generating independent realisations of the corpus. Only
# the noise-floor measurement needs this, so it is a separate image: adding Node to the
# evaluation image would rebuild and re-upload it for every panel run.
GEN = HERE.parent / "datastore"
gen_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("nodejs")
    .pip_install("duckdb>=1.1", "numpy>=2.0", "pyarrow>=17.0")
    .add_local_dir(str(GEN / "ref"), remote_path="/root/datastore/ref")
    .add_local_file(str(GEN / "generate-india.js"), remote_path="/root/datastore/generate-india.js")
    .add_local_file(str(HERE / "build_panels.py"), remote_path="/root/build_panels.py")
)

app = modal.App(APP, image=image)
vol = modal.Volume.from_name("ksp-forecast", create_if_missing=True)
DATA = "/data"

# Evaluation is single-process and memory-bound on the panel; 8 cores keeps LightGBM's
# thread pool busy without paying for cores it cannot use.
EVAL_CPU = 8
EVAL_MEM = 16384


# --------------------------------------------------------------------------- upload
@app.function(volumes={DATA: vol}, timeout=3600)
def _write_chunk(name: str, offset: int, blob: bytes, final: bool) -> int:
    path = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if offset == 0 else "r+b"
    with open(path, mode) as fh:
        fh.seek(offset)
        fh.write(blob)
    if final:
        vol.commit()
    return offset + len(blob)


@app.function(volumes={DATA: vol}, timeout=1800)
def _put_file(name: str, blob: bytes) -> str:
    path = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(blob)
    vol.commit()
    return f"{name} ({len(blob) / 1e6:.1f} MB)"


@app.local_entrypoint()
def push_panels(src: str = "/tmp/mp/panels", dest: str = "panels"):
    """Upload already-built panels into the Volume, in parallel.

    Panels are the only input evaluation needs, and the whole set is ~55 MB against 3.4 GB
    for the incident table. When panels already exist locally — after a workspace change,
    say — pushing them beats re-uploading the corpus and rebuilding.
    """
    files = sorted(pathlib.Path(src).glob("*.json"))
    if not files:
        raise SystemExit(f"no panels in {src}")
    total = sum(f.stat().st_size for f in files)
    print(f"uploading {len(files)} panels ({total / 1e6:.0f} MB) in parallel")
    jobs = [(f"{dest}/{f.name}", f.read_bytes()) for f in files]
    for msg in _put_file.starmap(jobs, return_exceptions=True):
        print("  ", msg)


@app.local_entrypoint()
def push_events(path: str = "datastore/train/events.csv", chunk_mb: int = 64):
    """Stream the incident table into the Volume in chunks.

    Chunked because a 3.4 GB single-shot upload is a single point of failure on a domestic
    connection, and a resumable-looking failure at 90% is worse than no upload at all.
    """
    src = pathlib.Path(path)
    if not src.exists():
        raise SystemExit(f"{src} not found — generate it with:\n"
                         f"  node datastore/generate-india.js --events-only --cases 27281585 --years 5")
    size = src.stat().st_size
    chunk = chunk_mb * 1024 * 1024
    print(f"uploading {src} ({size / 1e9:.2f} GB) in {chunk_mb} MB chunks")
    sent = 0
    with open(src, "rb") as fh:
        while True:
            blob = fh.read(chunk)
            if not blob:
                break
            nxt = sent + len(blob)
            _write_chunk.remote("events.csv", sent, blob, nxt >= size)
            sent = nxt
            print(f"  {sent / 1e9:.2f} / {size / 1e9:.2f} GB", flush=True)
    print("done")


# ---------------------------------------------------------------------- panel build
EVENTS_PARQUET = os.path.join(DATA, "events.parquet")
EVENTS_CSV = os.path.join(DATA, "events.csv")


@app.function(volumes={DATA: vol}, cpu=8, memory=32768, timeout=3600)
def to_parquet(force: bool = False) -> str:
    """Convert the incident CSV to Parquet on the Volume, once.

    Every panel build scans the whole table. Against CSV that means re-parsing 3.3 GB of
    text each time; against Parquet it means reading the handful of columns the panel
    actually needs. This is the single largest cost in the pipeline and it only has to be
    paid once.
    """
    import duckdb

    if os.path.exists(EVENTS_PARQUET) and not force:
        n = duckdb.sql(f"SELECT count(*) FROM read_parquet('{EVENTS_PARQUET}')").fetchone()[0]
        return f"exists: {EVENTS_PARQUET} ({n:,} rows)"
    con = duckdb.connect()
    con.execute("SET threads=8")
    con.execute(
        f"COPY (SELECT * FROM read_csv_auto('{EVENTS_CSV}', header=true)) "
        f"TO '{EVENTS_PARQUET}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    vol.commit()
    sz = os.path.getsize(EVENTS_PARQUET)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{EVENTS_PARQUET}')").fetchone()[0]
    return f"wrote {EVENTS_PARQUET}: {n:,} rows, {sz / 1e9:.2f} GB"


@app.function(volumes={DATA: vol}, cpu=8, memory=16384, timeout=3600)
def build_panels_remote(args: list[str], events: str = "") -> list[str]:
    """Run build_panels.py inside the container against the Volume-resident table.

    Returns only the panels this call produced, not the whole directory: with many of these
    running concurrently, listing the shared directory returns other containers' output and
    makes the result meaningless.
    """
    import subprocess
    import sys

    out = os.path.join(DATA, "panels")
    os.makedirs(out, exist_ok=True)
    before = set(os.listdir(out))
    src = events or (EVENTS_PARQUET if os.path.exists(EVENTS_PARQUET) else EVENTS_CSV)
    cmd = [sys.executable, "/root/build_panels.py", "--events", src, "--out", out] + args
    print(" ".join(cmd), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr)
        raise RuntimeError("build_panels failed: " + " ".join(args))
    vol.commit()
    return sorted(set(os.listdir(out)) - before)


# ------------------------------------------------------------------------ evaluate
@app.function(volumes={DATA: vol}, cpu=EVAL_CPU, memory=EVAL_MEM, timeout=7200)
def evaluate_panel(name: str, test_frac: float = 0.25, retrain_every: int = 8,
                   neighbours: int = 5, with_quantiles: bool = True,
                   min_total: int = 0) -> dict:
    """Evaluate one panel. Returns the report and writes it to the Volume."""
    import sys
    sys.path.insert(0, "/root")
    from engine import Panel, evaluate

    path = os.path.join(DATA, "panels", name)
    p = Panel.from_json(path)
    if min_total:
        p = p.drop_empty_units(min_total)
    try:
        r = evaluate(p, dataset=pathlib.Path(name).stem, test_frac=test_frac,
                     retrain_every=retrain_every, n_neighbours=neighbours,
                     with_quantiles=with_quantiles)
    except ValueError as e:
        return {"dataset": pathlib.Path(name).stem, "skipped": str(e)}
    rep = {k: v for k, v in r.__dict__.items() if k != "predictions"}
    outdir = os.path.join(DATA, "reports")
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, pathlib.Path(name).stem + ".json"), "w") as fh:
        json.dump(rep, fh, indent=2, default=str)
    vol.commit()
    print(r.summary(), flush=True)
    return rep


@app.local_entrypoint()
def build(level: str = "district", period: str = "week", split_head: bool = False,
          grid_m: float = 1000.0, state: str = "", district: str = "",
          min_total: int = 0):
    """Build one family of panels remotely."""
    args = ["--level", level, "--period", period, "--min-total", str(min_total)]
    if level == "grid":
        args += ["--grid-m", str(grid_m)]
    if split_head:
        args += ["--split-head"]
    if state:
        args += ["--state", state]
    if district:
        args += ["--district", district]
    files = build_panels_remote.remote(args, "")
    print(f"{len(files)} panels in the volume:")
    for f in files:
        print("  ", f)


@app.local_entrypoint()
def sweep(pattern: str = "", test_frac: float = 0.25, quantiles: bool = True,
          min_total: int = 0):
    """Evaluate every panel in the Volume in parallel, one container each."""
    names = [n for n in list_panels.remote() if n.endswith(".json") and pattern in n]
    if not names:
        raise SystemExit("no panels matched — run `modal run ml/modal_app.py::build` first")
    print(f"evaluating {len(names)} panels in parallel")
    reports = list(evaluate_panel.starmap(
        [(n, test_frac, 8, 5, quantiles, min_total) for n in names], return_exceptions=True
    ))
    _print_table([r for r in reports if isinstance(r, dict)])
    for r in reports:
        if isinstance(r, Exception):
            print(f"  eval failed: {r}")


@app.function(volumes={DATA: vol})
def list_panels() -> list[str]:
    d = os.path.join(DATA, "panels")
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


METROS = [
    "Mumbai Suburban", "Chennai", "Bangalore", "Ahmadabad", "Hyderabad", "Pune",
    "Kolkata", "Jaipur", "Lucknow", "Surat", "Kanpur Nagar", "Nagpur",
    "Indore", "Thane", "Patna", "Ludhiana", "Coimbatore", "Kochi",
]


@app.local_entrypoint()
def full(grid_m: float = 1000.0, metros: str = "", quantiles: bool = True,
         test_frac: float = 0.25):
    """Build and evaluate the entire panel matrix in one app run.

    Everything here fans out with ``.starmap``, which is the whole point. Driving this from a
    shell loop over separate ``modal run`` invocations — which is how I first did it — pays a
    container cold start and a full table scan per panel and runs them one after another. One
    app run with parallel map turns roughly an hour of serial work into a few minutes, and
    the results are identical.
    """
    print(to_parquet.remote())

    metro_list = [m.strip() for m in metros.split(",") if m.strip()] or METROS
    jobs: list[tuple[list[str]]] = [
        (["--level", "district", "--period", "week"], ""),
        (["--level", "district", "--period", "month"], ""),
        (["--level", "district", "--period", "day", "--min-total", "500"], ""),
        (["--level", "taluk", "--period", "week", "--min-total", "300"], ""),
        (["--level", "district", "--period", "week", "--split-head", "--min-total", "200"], ""),
    ]
    for m in metro_list:
        jobs.append((["--level", "grid", "--grid-m", str(grid_m), "--period", "week",
                      "--district", m, "--min-total", "30"], ""))
        jobs.append((["--level", "grid", "--grid-m", str(grid_m), "--period", "day",
                      "--district", m, "--min-total", "150"], ""))

    print(f"building {len(jobs)} panel families in parallel")
    built: list[str] = []
    for produced in build_panels_remote.starmap(jobs, return_exceptions=True):
        if isinstance(produced, Exception):
            print(f"  build failed: {produced}")
            continue
        built.extend(produced)
    print(f"built {len(built)} panels")

    names = [n for n in list_panels.remote() if n.endswith(".json")]
    print(f"evaluating {len(names)} panels in parallel")
    reports = list(evaluate_panel.starmap(
        [(n, test_frac, 8, 5, quantiles, 0) for n in names], return_exceptions=True
    ))
    _print_table([r for r in reports if isinstance(r, dict)])
    for r in reports:
        if isinstance(r, Exception):
            print(f"  eval failed: {r}")


def _print_table(reports: list[dict]) -> None:
    ok = [r for r in reports if "skipped" not in r]
    print(f"\n{'panel':<52}{'units':>7}{'MASE':>8}{'police':>9}{'PAI@1%':>9}{'eff':>7}{'head%':>8}")
    for r in sorted(ok, key=lambda x: x["point"]["ENSEMBLE"]["mase"]):
        pt, ach = r["point"], r.get("achievability") or {}
        sp = (r.get("spatial") or {}).get("0.010") or {}
        print(f"{r['dataset'][:51]:<52}"
              f"{r['panel'].get('units', 0):>7}"
              f"{pt['ENSEMBLE']['mase']:>8.3f}"
              f"{pt.get('historical_pattern', {}).get('mase', float('nan')):>9.3f}"
              f"{(sp.get('pai') or 0):>9.2f}"
              f"{(ach.get('efficiency') or 0):>7.3f}"
              f"{(ach.get('headroom_pct') or 0):>7.1f}%")
    for r in reports:
        if "skipped" in r:
            print(f"  skipped {r['dataset']}: {r['skipped']}")


@app.local_entrypoint()
def grid_sweep(districts: str = "Mumbai Suburban,Chennai,Bangalore,Ahmadabad,Hyderabad,Pune,Kolkata,Jaipur",
               grid_m: float = 1000.0, period: str = "week", min_total: int = 30):
    """Build and evaluate a grid panel per metropolitan district, all in parallel.

    Grid resolution is where a model can add spatial value over the long-run mean, and it
    only works per city: a national 1 km grid has a median of one event per cell because
    India is five thousand times the area of Chicago.
    """
    ds = [d.strip() for d in districts.split(",") if d.strip()]
    jobs = [(["--level", "grid", "--grid-m", str(grid_m), "--period", period,
              "--district", d, "--min-total", str(min_total)], "") for d in ds]
    print(f"building {len(jobs)} grid panels in parallel")
    for files in build_panels_remote.starmap(jobs):
        pass
    names = [n for n in list_panels.remote() if "grid" in n]
    print(f"evaluating {len(names)} grid panels")
    reports = list(evaluate_panel.starmap([(n, 0.25, 8, 5, True, 0) for n in names]))
    print(f"\n{'metro grid panel':<52}{'MASE':>8}{'police':>9}{'PAI@1%':>9}{'eff':>7}")
    for r in sorted([x for x in reports if "skipped" not in x],
                    key=lambda x: x["point"]["ENSEMBLE"]["mase"]):
        pt = r["point"]
        sp = (r.get("spatial") or {}).get("0.010") or {}
        ach = r.get("achievability") or {}
        print(f"{r['dataset'][:51]:<52}{pt['ENSEMBLE']['mase']:>8.3f}"
              f"{pt.get('historical_pattern', {}).get('mase', float('nan')):>9.3f}"
              f"{(sp.get('pai') or 0):>9.2f}{(ach.get('efficiency') or 0):>7.3f}")


# --------------------------------------------------------------- real-city corpora
# Sub-district unit and grid size per city. Grid size is not one global number: a 1 km cell
# holds a useful count in Chicago and almost nothing in Seattle's outer precincts, and the
# comparison across cities is only fair if each city's cells carry comparable volume.
CITY_GRID_M = {
    "chicago": 700.0, "newyork": 700.0, "losangeles": 1000.0,
    "sanfrancisco": 500.0, "seattle": 800.0,
}


@app.local_entrypoint()
def cities(src: str = "datastore/train/cities", grid: bool = True, test_frac: float = 0.25):
    """Validate the identical engine on real, incident-level crime from five US cities.

    This is the external anchor. The synthetic corpus can only show that the engine recovers
    the simulator that produced it; five real cities with different geography, recording
    practice and offence mixes are what test whether the *conclusions* generalise.

    Uploads, panel builds and evaluations all fan out.
    """
    files = sorted(pathlib.Path(src).glob("*.parquet"))
    if not files:
        raise SystemExit(f"no city parquet in {src} — run ml/ingest_cities.py --all first")
    print(f"uploading {len(files)} city corpora "
          f"({sum(f.stat().st_size for f in files) / 1e6:.0f} MB)")
    for msg in _put_file.starmap([(f"cities/{f.name}", f.read_bytes()) for f in files],
                                 return_exceptions=True):
        print("  ", msg)

    jobs = []
    for f in files:
        city = f.stem
        remote = f"{DATA}/cities/{f.name}"
        common = ["--prefix", city, "--source", f"real-open-data-{city}"]
        for period, min_total in (("week", 0), ("day", 0)):
            jobs.append((common + ["--level", "district", "--period", period], remote))
            jobs.append((common + ["--level", "taluk", "--period", period,
                                   "--min-total", "50"], remote))
        if grid:
            g = CITY_GRID_M.get(city, 700.0)
            jobs.append((common + ["--level", "grid", "--grid-m", str(g), "--period", "week",
                                   "--min-total", "30"], remote))
            jobs.append((common + ["--level", "grid", "--grid-m", str(g), "--period", "day",
                                   "--min-total", "150"], remote))

    print(f"building {len(jobs)} real-city panels in parallel")
    built: list[str] = []
    for produced in build_panels_remote.starmap(jobs, return_exceptions=True):
        if isinstance(produced, Exception):
            print(f"  build failed: {produced}")
            continue
        built.extend(produced)
    print(f"built {len(built)} panels")

    names = [n for n in list_panels.remote() if n.endswith(".json")
             and any(n.startswith(f.stem) for f in files)]
    print(f"evaluating {len(names)} real-city panels in parallel")
    reports = list(evaluate_panel.starmap(
        [(n, test_frac, 8, 5, True, 0) for n in names], return_exceptions=True))
    _print_table([r for r in reports if isinstance(r, dict)])
    for r in reports:
        if isinstance(r, Exception):
            print(f"  eval failed: {r}")


# ------------------------------------------------------------------- noise floor
@app.function(image=gen_image, volumes={DATA: vol}, cpu=4, memory=16384, timeout=7200)
def realisation(seed: int, level: str = "district", period: str = "week",
                years: float = 5.0, cases: int = 27281585) -> str:
    """Generate one independent realisation of the corpus and reduce it to a panel.

    The generator's intensity field is deterministic — a district's expected volume is real
    NCRB state totals split by census population and urban share, with no seeded district
    effect. Changing ``--seed`` therefore redraws the *realisation* of the same process, not a
    different process. That is what makes a measured noise floor possible.

    The 3.4 GB incident table is discarded once the panel is built; only the panel is kept.
    """
    import subprocess
    import sys

    csv = f"/tmp/events_{seed}.csv"
    r = subprocess.run(
        ["node", "/root/datastore/generate-india.js", "--events-only",
         "--cases", str(cases), "--years", str(years), "--seed", str(seed),
         "--events-out", csv],
        capture_output=True, text=True, cwd="/root",
    )
    print(r.stdout[-2000:], flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"generator failed for seed {seed}: {r.stderr[-2000:]}")

    out = os.path.join(DATA, "realisations")
    os.makedirs(out, exist_ok=True)
    tmp = f"/tmp/panels_{seed}"
    r = subprocess.run(
        [sys.executable, "/root/build_panels.py", "--events", csv, "--level", level,
         "--period", period, "--out", tmp],
        capture_output=True, text=True,
    )
    print(r.stdout, flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"build_panels failed for seed {seed}: {r.stderr[-2000:]}")

    import shutil
    built = sorted(pathlib.Path(tmp).glob("*.json"))
    dest = os.path.join(out, f"{level}_{period}_seed{seed}.json")
    shutil.copy(built[0], dest)
    os.remove(csv)
    vol.commit()
    return dest


@app.function(volumes={DATA: vol}, cpu=4, memory=16384, timeout=3600)
def noise_floor(level: str = "district", period: str = "week") -> dict:
    """Measure the irreducible forecast error, without assuming Poisson.

    The achievability bound reported per panel uses De Moivre's identity, which requires
    counts to be Poisson given the intensity. This corpus is a Hawkes process: offspring
    events cluster on their parents, so the marginal count in a cell is over-dispersed and
    the Poisson floor is a *lower* bound on irreducible error — it makes the remaining
    headroom look larger than it is.

    With K independent realisations of the same intensity field the floor can be measured
    instead. For each realisation k, the oracle predictor is the mean of the other K-1
    realisations, and its error on realisation k is a leave-one-out estimate of the best any
    forecaster could do. It is slightly pessimistic, because that mean still carries
    sampling error of order sigma/sqrt(K-1); the Poisson-equivalent correction below reports
    how much.
    """
    import numpy as np

    d = os.path.join(DATA, "realisations")
    files = sorted(f for f in os.listdir(d) if f.startswith(f"{level}_{period}_seed"))
    if len(files) < 3:
        raise RuntimeError(f"need at least 3 realisations, found {len(files)}")

    # Align on the units and periods every realisation has. A cell missing from one
    # realisation is a cell where that draw happened to be empty; dropping it would bias the
    # floor downward by removing exactly the low-rate cells that are hardest to predict.
    panels = [json.load(open(os.path.join(d, f))) for f in files]
    units = sorted(set.intersection(*[set(p["units"]) for p in panels]))
    labels = sorted(set.intersection(*[{t["label"] for t in p["timeline"]} for p in panels]))
    lidx = {lab: i for i, lab in enumerate(labels)}

    X = np.zeros((len(panels), len(units), len(labels)), dtype=np.float64)
    for k, p in enumerate(panels):
        cols = [lidx.get(t["label"]) for t in p["timeline"]]
        for i, u in enumerate(units):
            s = p["series"].get(u)
            if not s:
                continue
            for j, c in enumerate(cols):
                if c is not None:
                    X[k, i, c] = s[j]

    K = len(panels)
    tot = X.sum(axis=(1, 2))
    lam = X.mean(axis=0)
    var = X.var(axis=0, ddof=1)

    abs_err, sq_err = [], []
    for k in range(K):
        others = np.delete(X, k, axis=0).mean(axis=0)
        abs_err.append(np.abs(X[k] - others))
        sq_err.append((X[k] - others) ** 2)
    loo_mae = float(np.mean(abs_err))
    loo_rmse = float(np.sqrt(np.mean(sq_err)))

    # The leave-one-out oracle uses a mean of K-1 draws, so its error variance is
    # sigma^2 (1 + 1/(K-1)). Scaling by that factor gives the floor a forecaster with perfect
    # knowledge of the intensity would face.
    inflate = np.sqrt(1.0 + 1.0 / (K - 1))
    measured = loo_mae / inflate

    # The closed-form Poisson floor the engine reports per panel, evaluated on the *same*
    # intensity estimates. Computing it any other way would make the ratio below an artefact
    # of two different estimators rather than of over-dispersion.
    import sys
    sys.path.insert(0, "/root")
    from engine.metrics import poisson_expected_abs_dev
    poisson_floor = float(np.mean(poisson_expected_abs_dev(lam)))

    band_edges = np.quantile(lam.sum(axis=1), [0.5, 0.8, 0.95])
    bands = np.digitize(lam.sum(axis=1), band_edges)
    per_band = {}
    for b in range(len(band_edges) + 1):
        m = bands == b
        if not m.any():
            continue
        per_band[int(b)] = {
            "units": int(m.sum()),
            "mean_count": round(float(lam[m].mean()), 3),
            "variance": round(float(var[m].mean()), 3),
            "dispersion": round(float(var[m].mean() / max(1e-9, lam[m].mean())), 3),
            "measured_floor_mae": round(float(np.mean([e[m] for e in abs_err])) / inflate, 4),
            "poisson_floor_mae": round(float(np.mean(poisson_expected_abs_dev(lam[m]))), 4),
        }

    res = {
        "level": level, "period": period, "realisations": K,
        "events_per_realisation": [int(t) for t in tot],
        "units": len(units), "periods": len(labels),
        "mean_count_per_cell": round(float(lam.mean()), 4),
        "variance_per_cell": round(float(var.mean()), 4),
        # > 1 means clustered, so the Poisson bound is optimistic about what is achievable.
        "dispersion_index": round(float(var.mean() / max(1e-9, lam.mean())), 4),
        "loo_oracle_mae": round(loo_mae, 4),
        "loo_oracle_rmse": round(loo_rmse, 4),
        "measured_floor_mae": round(measured, 4),
        "poisson_floor_mae": round(poisson_floor, 4),
        # How much the Poisson bound understates irreducible error. Every per-panel
        # "headroom" figure should be discounted by this before anyone spends effort on it.
        "poisson_bound_understates_by": round(measured / poisson_floor, 4),
        "by_volume_band": per_band,
    }
    out = os.path.join(DATA, "reports", f"noise_floor_{level}_{period}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(res, fh, indent=2)
    vol.commit()
    print(json.dumps(res, indent=2), flush=True)
    return res


@app.local_entrypoint()
def floor(k: int = 6, level: str = "district", period: str = "week",
          years: float = 5.0, cases: int = 27281585, base_seed: int = 20260725):
    """Generate K realisations in parallel, then measure the irreducible error.

    K containers, one realisation each. Serially this is K x (generate 27M events + build a
    panel); in parallel it is one of those.
    """
    seeds = [base_seed + 1000 * i for i in range(k)]
    print(f"generating {k} independent realisations of {cases:,} events over {years}y")
    for r in realisation.starmap([(s, level, period, years, cases) for s in seeds],
                                 return_exceptions=True):
        print("  ", r)
    print(json.dumps(noise_floor.remote(level, period), indent=2))


# -------------------------------------------------------------------- hierarchical
@app.function(volumes={DATA: vol}, cpu=16, memory=32768, timeout=10800)
def hierarchical_remote(aggregate: str = "india_district_week.json",
                        test_frac: float = 0.25, retrain_every: int = 8) -> str:
    """Bottom-up (per crime group, summed) vs top-down at district x week.

    Sixteen group panels plus the aggregate, each a full walk-forward, is a couple of hours
    on four local cores. It is one container here and the groups share the process, so the
    LightGBM thread pool is the parallelism that matters.
    """
    import shutil
    import subprocess
    import sys

    panels = os.path.join(DATA, "panels")
    heads = "/tmp/heads"
    os.makedirs(heads, exist_ok=True)
    agg_stem = pathlib.Path(aggregate).stem
    for n in os.listdir(panels):
        # Only the per-group splits of this same aggregate; the aggregate itself and other
        # levels would either double count or mismatch the unit set.
        if n.startswith(agg_stem + "_") and n.endswith(".json"):
            shutil.copy(os.path.join(panels, n), os.path.join(heads, n))
    if not os.listdir(heads):
        raise RuntimeError(f"no per-group panels named {agg_stem}_*.json in the volume — "
                           f"build with --split-head first")

    out = os.path.join(DATA, "reports", "hierarchical_" + agg_stem + ".json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run(
        [sys.executable, "/root/hierarchical.py", "--panels", heads,
         "--aggregate", os.path.join(panels, aggregate),
         "--test-frac", str(test_frac), "--retrain-every", str(retrain_every),
         "--json", out],
        capture_output=True, text=True,
    )
    print(r.stdout, flush=True)
    if r.returncode != 0:
        print(r.stderr, flush=True)
        raise RuntimeError("hierarchical.py failed")
    vol.commit()
    return r.stdout


@app.local_entrypoint()
def hierarchical(aggregate: str = "india_district_week.json", test_frac: float = 0.25):
    print(hierarchical_remote.remote(aggregate, test_frac))


@app.local_entrypoint()
def resume(src: str = "/tmp/mp/panels", test_frac: float = 0.25):
    """Push local panels, evaluate whatever has no report yet, and run the hierarchical test.

    One app run: the upload, the outstanding evaluations, and the hierarchy comparison all
    fan out together instead of being three serial invocations.
    """
    files = sorted(pathlib.Path(src).glob("*.json"))
    if files:
        print(f"uploading {len(files)} panels "
              f"({sum(f.stat().st_size for f in files) / 1e6:.0f} MB)")
        list(_put_file.starmap([(f"panels/{f.name}", f.read_bytes()) for f in files],
                               return_exceptions=True))

    have = {n for n in read_reports.remote()}
    todo = [n for n in list_panels.remote() if n.endswith(".json") and n not in have]
    print(f"{len(have)} reports present, evaluating {len(todo)} outstanding panels")

    hier = hierarchical_remote.spawn(aggregate="india_district_week.json", test_frac=test_frac)

    reports = []
    if todo:
        reports = list(evaluate_panel.starmap(
            [(n, test_frac, 8, 5, True, 0) for n in todo], return_exceptions=True))
        _print_table([r for r in reports if isinstance(r, dict)])
        for r in reports:
            if isinstance(r, Exception):
                print(f"  eval failed: {r}")

    print("\n=== hierarchical: bottom-up vs top-down ===")
    try:
        print(hier.get())
    except Exception as e:  # a failed comparison must not lose the panel evaluations above
        print(f"hierarchical failed: {e}")


@app.function(volumes={DATA: vol})
def read_reports() -> dict[str, str]:
    d = os.path.join(DATA, "reports")
    if not os.path.isdir(d):
        return {}
    return {n: open(os.path.join(d, n)).read() for n in sorted(os.listdir(d))}


@app.local_entrypoint()
def fetch_reports(out: str = "ml/out/reports"):
    """Copy evaluation reports out of the Volume."""
    dest = pathlib.Path(out)
    dest.mkdir(parents=True, exist_ok=True)
    got = read_reports.remote()
    for name, body in got.items():
        (dest / name).write_text(body)
    print(f"wrote {len(got)} reports to {dest}")
