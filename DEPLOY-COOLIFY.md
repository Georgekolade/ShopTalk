# Deploying ShopTalk on Coolify

Stack: Postgres 16 -> Django/Gunicorn (port 8003, internal) -> Next.js (port 3003, public).
The browser only ever talks to the frontend origin. `/api/*` is rewritten
server-side to the backend, so there is no CORS and no public API port.

## 1. Create the resource

1. In Coolify: **+ New -> Docker Compose**, point it at this repository.
2. Compose file: `docker-compose.yml` at the repo root.
3. Add every variable from [`.env.example`](/.env.example) under
   **Environment Variables**. Required: `DB_PASSWORD`, `DJANGO_SECRET_KEY`,
   `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`.
   Generate secrets with `openssl rand -hex 32`.
4. Assign your domain to the **frontend** service, port **3003**
   (for example `https://shoptalk.example.com`).
   Set `DJANGO_ALLOWED_HOSTS=shoptalk.example.com` and
   `CSRF_TRUSTED_ORIGINS=https://shoptalk.example.com` to match.
5. Deploy. First boot runs database migrations automatically.

## 2. Create the first admin user

Coolify -> backend container -> **Terminal**:

```sh
python manage.py createsuperuser
```

## 3. Rules that keep production working

- Never set `NEXT_PUBLIC_API_URL`. It is baked into the browser bundle at
  build time and must stay empty so calls stay same-origin.
- Never publish the backend or database ports publicly. Only the frontend
  receives a domain.
- `DJANGO_DEBUG` is forced to `False` in the compose file.
- Postgres data lives in the `pgdata` volume. Back it up with
  `pg_dump` from the db container; Coolify scheduled backups work too.

## Local check (optional, needs Docker)

```sh
cp .env.example .env   # fill in the two secrets
docker compose up --build
```

Then open http://localhost:3003 (the local-only docker-compose.override.yml publishes the port; Coolify ignores that file). API health: the backend answers
`/api/health/` internally; check with
`docker compose exec backend curl -s http://127.0.0.1:8003/api/health/`.
