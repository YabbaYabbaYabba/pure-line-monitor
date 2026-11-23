# bookworm: newer Debian releases use syscalls that older NAS kernels (e.g. QNAP) reject
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8080
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --system --uid 10001 monitor \
 && mkdir -p /data && chown monitor /data
# Owned by the app user, so it can read its code even if the NAS unpacked the files with strict permissions
COPY --chown=10001:10001 app ./app
USER monitor
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz')" || exit 1
CMD ["python", "-m", "app.server"]
