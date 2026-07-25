#!/usr/bin/env bash
# Deploy the forecast engine to Catalyst AppSail (managed Python runtime).
#
# Two things this script exists to guarantee:
#
# 1. The served engine is the backtested engine. ml/engine is the single source of truth and is
#    copied in here at deploy time. A second checked-in copy would drift, and a served model
#    that differs from the backtested one invalidates every accuracy claim in ml/RESULTS.md.
#
# 2. Dependencies are present. The managed Python runtime does not install requirements.txt, so
#    wheels are vendored into ./vendor, which app.py puts on sys.path. They must be Linux
#    manylinux wheels for the runtime's Python version, not whatever this machine happens to
#    run, so pip is told the target platform explicitly.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_TAG="${PY_TAG:-312}"

[ -d "$here/../engine" ] || { echo "missing $here/../engine" >&2; exit 1; }

rm -rf "$here/engine"
mkdir -p "$here/engine"
cp "$here"/../engine/*.py "$here/engine/"
echo "synced $(ls -1 "$here/engine" | wc -l) engine modules"

# Re-vendoring is ~200 MB of downloads and dominates a redeploy that usually only changes
# app.py, so it is keyed on the requirements hash and skipped when nothing moved.
stamp="$here/vendor/.requirements.sha256"
want="$(sha256sum "$here/requirements.txt" | cut -d' ' -f1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
  echo "vendor up to date ($(du -sh "$here/vendor" | cut -f1)) — skipping re-vendor"
else
rm -rf "$here/vendor"
python3 -m pip install \
  --target "$here/vendor" \
  --platform manylinux2014_x86_64 \
  --python-version "$PY_TAG" \
  --implementation cp \
  --only-binary=:all: \
  --upgrade \
  -r "$here/requirements.txt"
# Test directories are dead weight in an upload that travels on every deploy. .dist-info is
# deliberately kept: several of these packages resolve their own version through
# importlib.metadata at import time, and stripping it trades a subtle import failure in the
# cloud for a few megabytes.
find "$here/vendor" -type d \( -name tests -o -name test -o -name __pycache__ \) -prune -exec rm -rf {} + 2>/dev/null || true
  echo "$want" > "$stamp"
  echo "vendored $(du -sh "$here/vendor" | cut -f1) of wheels"
fi

cd "$(dirname "$here")/.."
catalyst deploy --only appsail "$@"
