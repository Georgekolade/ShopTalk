# ShopTalk AI

Talk to your business. Understand what is happening. Get things done.

Voice-and-text business operations for small shops: record sales, stock
receipts, and expenses by conversation, and ask questions answered from real
records. Every money-moving action shows a preview and waits for confirmation.
Nothing is final until the backend commits it.

Spec: [ShopTalk_AI_PRD.md](ShopTalk_AI_PRD.md). Demo script: [DEMO.md](DEMO.md).

## Stack

- Backend: Django 6 + Django REST Framework + PostgreSQL 18 (`backend/`)
- Frontend: Next.js 16 + TypeScript PWA (`frontend/`)
- AI: provider adapter with an offline rule-based default, typed tools,
  scripted mock for tests. No API key needed to run.

## Quickstart

Prerequisites: Python 3.12+, Node 20+, PostgreSQL 18 with a `shoptalk`
database. Connection values live in `backend/.env` (see
`backend/.env.example`).

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo      # demo login: demo / demo1234
python manage.py runserver      # http://127.0.0.1:8000
```

```powershell
cd frontend
npm install
npm run dev                    # http://localhost:3000
```

Reset the demo any time: `python manage.py seed_demo --reset`.

Seeded shop: Ada's Provisions (retail, NGN, Africa/Lagos), 6 catalogue
items with opening stock, one supplier, one customer.

## How it works

```
Mic / Keyboard → speech-to-text (voice only) → POST /assistant/messages
  → provider plans (tools, preview, or clarifying question)
  → Django services validate, price, and commit atomically → PostgreSQL
  → reply synthesized from tool output only → UI + optional speech
```

AI interprets and orchestrates. Deterministic services do prices, totals,
stock, permissions, and writes. The assistant never claims success unless
the backend confirms it.

Key endpoints (all under `/api/businesses/{id}`, membership-checked):

- `POST /api/auth/token/` — login
- `GET/POST .../catalogue`, `POST .../catalogue/import` — catalogue + CSV
- `POST .../sales/prepare`, `POST .../sales/{id}/commit` — two-step sales
- `POST .../stock-receipts`, `GET/POST .../expenses`
- `GET .../reports?metric=`, `GET .../activity` — reports + audit
- `POST .../assistant/messages`, `POST .../assistant/actions/{id}/confirm`

Roles: catalogue writes, stock receipts, and expenses need owner/manager.
Any active member may prepare and commit sales. Cross-tenant reads are 404.

## Testing

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py test core     # 87 tests: unit, service, API, orchestration, 12 PRD acceptance
```

```powershell
cd frontend
npm run lint
npx next build --webpack
```

## Deploy notes

Backend reads everything from the environment: `DJANGO_SECRET_KEY`,
`DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `DB_NAME/USER/PASSWORD/HOST/PORT`,
`CORS_ALLOWED_ORIGINS`, `SHOP_TALK_AI_PROVIDER`. Set
`DJANGO_DEBUG=False`, a real secret, and the public hosts. Run
`collectstatic` and serve `/static/` (whitenoise or the platform).

The frontend inlines `NEXT_PUBLIC_API_URL` at build time — set it to the
public API URL before `next build`. Same-origin hosting avoids CORS
entirely; otherwise add the frontend origin to `CORS_ALLOWED_ORIGINS`.
