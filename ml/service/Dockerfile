# KSP Forecasting Engine — Catalyst AppSail (custom Docker/OCI runtime)
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# AppSail injects the listen port via X_ZOHO_CATALYST_LISTEN_PORT (fallback 9000).
ENV PORT=9000
EXPOSE 9000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${X_ZOHO_CATALYST_LISTEN_PORT:-${PORT:-9000}}"]
