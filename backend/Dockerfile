# School ERP API. Build:  docker build -t school-erp-api backend
# Run:  docker run --env-file backend/.env -p 8000:8000 school-erp-api
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS deps
COPY requirements.txt .
RUN pip install --prefix=/install -r requirements.txt

FROM base
# a user without a shell or home: the API never needs to write to its own files
RUN useradd --system --no-create-home --shell /usr/sbin/nologin erp
COPY --from=deps /install /usr/local
COPY app ./app
COPY scripts ./scripts
USER erp
EXPOSE 8000
# Liveness only (the database isn't checked here, so a slow database doesn't restart every container);
# point the load balancer's readiness check at /api/v1/health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4).status == 200 else 1)"
# --no-proxy-headers: only TRUSTED_PROXY_HOPS decides the client IP (audit log, rate limits).
# WEB_CONCURRENCY processes; rate limits and the renewal run are shared through the database.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2} --no-proxy-headers --timeout-graceful-shutdown 20"]
