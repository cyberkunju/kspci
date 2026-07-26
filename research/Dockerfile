# KSP Research Engine — Catalyst AppSail (custom Docker/OCI runtime).
#
# Python 3.12 rather than the newest release, on purpose: lxml — which trafilatura
# is built on — publishes wheels for 3.12, and building it from source would pull a
# C toolchain and libxml2 headers into the image for no benefit.
FROM python:3.12-slim

# Non-root. This service fetches attacker-influenceable URLs all day; if something
# ever goes wrong in a parser, it should not be going wrong as root.
RUN useradd --create-home --uid 10001 research

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=9000

USER research
EXPOSE 9000

# AppSail injects the listen port via X_ZOHO_CATALYST_LISTEN_PORT (fallback 9000),
# the same contract the forecasting service already uses.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${X_ZOHO_CATALYST_LISTEN_PORT:-${PORT:-9000}}"]
