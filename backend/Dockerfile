# ShopTalk API — production image (Django + Gunicorn)
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Runtime libs for psycopg/reportlab wheels; curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libpq5 unzip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -d /app app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY --chown=app:app . .
COPY --chown=app:app entrypoint.sh /entrypoint.sh
# Vosk large offline speech model: fetched on the server at build time so the
# repo stays small and no laptop ever downloads the ~1.8GB file.
# Override at build time with --build-arg VOSK_MODEL_URL=... VOSK_MODEL_DIR=...
ARG VOSK_MODEL_URL=https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip
ARG VOSK_MODEL_DIR=vosk-model-en-us-0.22
RUN curl -fsSL -o /tmp/vosk-model.zip ${VOSK_MODEL_URL} \
    && mkdir -p /app/core/models \
    && unzip -q /tmp/vosk-model.zip -d /app/core/models \
    && rm /tmp/vosk-model.zip \
    && test -d "/app/core/models/${VOSK_MODEL_DIR}" \
    && chown -R app:app /app/core/models
RUN chmod +x /entrypoint.sh \
    && mkdir -p /app/staticfiles \
    && chown -R app:app /app/staticfiles

USER app

# Static files are baked into the image; no shared volume needed.
RUN python manage.py collectstatic --noinput

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
# gthread + threads: threads in one worker share the single loaded Vosk model,
# so the large model costs ~1 copy per worker instead of one per request slot.
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--worker-class", "gthread", "--workers", "2", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-"]
