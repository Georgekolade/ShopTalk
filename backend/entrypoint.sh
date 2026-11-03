#!/bin/sh
# Wait for Postgres, apply migrations, then start the app server.
set -eu

python - <<'PY'
import os, time
import psycopg

deadline = time.time() + 60
last = None
while time.time() < deadline:
    try:
        psycopg.connect(
            dbname=os.environ.get("DB_NAME", "shoptalk"),
            user=os.environ.get("DB_USER", "postgres"),
            password=os.environ.get("DB_PASSWORD", ""),
            host=os.environ.get("DB_HOST", "db"),
            port=os.environ.get("DB_PORT", "5432"),
            connect_timeout=3,
        ).close()
        break
    except Exception as exc:  # noqa: BLE001 - retry until deadline
        last = exc
        time.sleep(2)
else:
    raise SystemExit(f"Database unreachable after 60s: {last}")
print("Database ready.")
PY

python manage.py migrate --noinput

exec "$@"
