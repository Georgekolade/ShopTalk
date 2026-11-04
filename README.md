# ShopTalk AI

**Talk to your business. Understand what is happening. Get things done.**

ShopTalk AI is a voice-and-text business operations assistant for small
businesses. An owner says or types what happened — *"sell 2 honey beans
5kg"*, *"we received 20 bags"*, *"spent 5,000 on transport"*, *"how much
did we sell this week?"* — and ShopTalk interprets the request, acts on
the shop's real records through validated backend tools, and answers
from those same records.

This repository is our hackathon build. It is a working end-to-end
product, not a mock-up: every demo request writes to or reads from a
real PostgreSQL database, and the interface, audit trail, and reports
move with it.

- Product specification: [ShopTalk_AI_PRD.md](ShopTalk_AI_PRD.md)
- Deployment: [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md)
- Demo business: GeoPure (seeded, see [Demo data](#demo-data-geopure))

---

## The problem

Small businesses run on memory, notebooks, WhatsApp messages, and
spreadsheets. Sales get recorded late or not at all. Stock counts drift.
Expenses vanish. At month end, the owner cannot answer simple questions
— *what did we sell, what is left, are we making money?* — without hours
of manual work.

Generic chatbots do not solve this. They can explain, but they cannot
safely update records, and they will happily invent a price or a stock
figure. ShopTalk AI was built for that gap.

## Our goal

Make business operations accessible in everyday language:

1. **Capture** sales, stock receipts, and expenses by conversation, in
   the moment they happen, by voice or text.
2. **Understand** performance at any time — sales, expenses, profit, low
   stock, trends — answered only from actual records.
3. **Trust** every consequential action: the owner previews and confirms
   it, the backend validates and commits it atomically, and an audit
   trail proves what happened.

The design principle that holds the whole system together:

> **AI interprets and orchestrates. Deterministic backend services
> validate permissions, calculate money and stock, and preserve
> transaction integrity. The assistant never claims success unless the
> backend confirms it.**

## What a user can do

| Workflow | Example | What happens |
| --- | --- | --- |
| Record a sale | "Sell 2 honey beans 2.5kg" | Items resolved, priced server-side, preview shown, confirmed, committed; stock drops, receipt issued |
| Receive stock | "We received 20 honey beans 5kg" | Restock preview, confirmed, stock rises with a movement record |
| Record an expense | "Spent 4,500 on delivery fuel" | Preview, confirmed, saved and included in reports |
| Add to the catalogue | "Add zobo 1500 to the catalogue" | Preview with name, kind, and price; confirmed, product created; duplicates and missing prices get a question instead |
| Ask about the business | "How much did we sell this week?" | Trusted reporting code calculates the figure; the model only words the answer |
| Check stock | "How many 10kg packs are left?" | Answered from live stock balances |
| Teach the business | Paste a policy or price list in Setup | Stored as a knowledge document the assistant can search, treated always as data, never as instructions |
| Upload a document | Attach a receipt, PDF, or spreadsheet | Text is extracted server-side and the assistant works from it |
| Talk hands-free | Tap the mic and speak | Words appear live while you talk; the final transcript lands on stop, editable before sending |

Ambiguity is handled by asking, never guessing: an unknown product, a
missing quantity, or two matching products produces a focused
clarifying question and no write.

## How Meta Muse is integrated

ShopTalk is powered end-to-end by Meta's Muse family, through one
replaceable provider adapter (`SHOP_TALK_AI_PROVIDER`). The same Meta
Model API key serves reasoning and voice.

| Muse capability | Role in ShopTalk |
| --- | --- |
| **Muse Spark** (`muse-spark-1.3`, OpenAI-compatible chat completions at `api.meta.ai/v1`) | Understands free phrasing in the owner's own language and style, and returns a structured *plan*: read-tool calls, one proposed write, a confirmation, or a clarifying question |
| **Muse Spark reply composition** | Turns trusted tool results into a short, warm, spoken-friendly answer — from the tool output only, never from memory |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`, Meta ASR endpoint) | Server-side speech-to-text fallback. When the browser's built-in speech service hears speech but returns no transcript (verified on current Chrome and Edge builds), the mic recording is transcribed by Muse Voice instead of losing the user's words |
| **Provider fallback** | If the Muse service is unreachable, planning falls back to a deterministic heuristic provider, so sales, stock, and expenses still work. If transcription is unconfigured, the app says so and typing remains available |

What the model never does: it never sets prices or totals, never checks
permissions, never writes to the database, and never executes SQL. It
proposes; Django disposes. Conversation history and a rolling memory
summary give Muse continuity across turns, and only the business
context a task needs is sent — data minimisation by design.

### Voice pipeline

```
Mic ──► Browser speech recognition (live transcript, editable)
  │        │ returns nothing / network error
  │        ▼
  └──► Parallel 16 kHz WAV recording ──► POST /api/assistant/transcribe
              ──► Muse Voice Transcribe ──► text
Text and voice converge ──► POST /api/assistant/messages ──► Muse Spark plan
```

While recording, the audio so far is transcribed every few seconds
so words appear live; the upload on stop stays final.

Spoken replies use text-to-speech with the same transcript shown on
screen, so voice and text always take the identical backend path.

## How a request flows

1. **Input.** Voice is transcribed (browser first, Muse Voice as
   fallback) or the user types. The text lands in the composer, editable
   before sending.
2. **Planning.** Muse Spark (or the fallback provider) interprets the
   request against business context, catalogue aliases, rules, and
   conversation history, and returns a typed plan.
3. **Tools.** Read tools run immediately (`search_products`,
   `check_stock`, `get_business_report`, `get_sales_trend`,
   `search_knowledge`, `get_sale_documents`, `get_business_context`).
   Write intents become a **PendingAction** preview: lines, server-side
   prices, totals, warnings.
4. **Confirmation.** Nothing money-moving is final until the owner
   confirms. Declining discards the preview.
5. **Commit.** Django services revalidate permissions, stock, and
   prices, then commit sale/items/stock movements, receipt, payment,
   and audit log in one database transaction — or roll back entirely.
6. **Reply.** The answer is composed from the committed result only:
   receipt number, new totals, and caveats (for example, lines excluded
   from profit because they lack cost data).

## Product tour

- **Assistant** — voice/text conversation with action previews,
  continuous hands-free mode with spoken replies, catalogue additions, document attachments,
  receipts and invoice downloads.
- **Dashboard** — sales, expenses, profit, low stock, trends, and top
  products for any period, compared against the previous period.
- **Catalogue** — products and services with aliases, prices, costs,
  stock tracking, and CSV import with validation.
- **Transactions** — committed sales, stock receipts, and expenses,
  with branded receipt and invoice PDFs generated from saved rows.
- **Reports** — sales totals, expenses, profit (revenue minus cost of
  goods, expenses reported separately), and low-stock, with the date
  range and data limitations stated.
- **Activity** — the audit trail: actor, action, status, and record
  reference for every committed action.
- **Setup** — business profile and branding (the owner's colour leads
  navigation, charts, and documents), business rules, and knowledge
  documents the assistant can search.
- **Team** — members with owner, manager, sales, and inventory roles;
  permissions enforced by the backend on every request.

## Roles and permissions

| Role | Can do |
| --- | --- |
| Owner / Manager | Everything, including catalogue, team, and setup |
| Sales | Record sales, view catalogue, use the assistant |
| Inventory | Manage stock and catalogue, view reports and activity |
| Finance / Viewer | View reports, catalogue, and activity (finance can also record expenses) |

Every record is scoped to a business through an active membership.
Asking for another business's data resolves to 404, never a leak.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Next.js 16 PWA (React 19, TypeScript)                      │
│ Assistant · Dashboard · Catalogue · Transactions · Reports │
│ Voice: browser speech → WAV fallback · TTS replies         │
└──────────────────────────┬─────────────────────────────────┘
                           │ same-origin /api/* (server-side rewrite)
┌──────────────────────────▼─────────────────────────────────┐
│ Django 6 + DRF (Gunicorn)                                  │
│ Provider adapter ─► Muse Spark plan / fallback heuristic   │
│ Typed tools ─► deterministic services (money, stock, audit)│
│ Knowledge search · document extraction · PDF documents     │
│ Transcription ─► Muse Voice Transcribe (Meta ASR)          │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
                     PostgreSQL
```

Multi-tenancy is row-level: every operational record carries a business
foreign key, and every query passes through an active membership. Stock
is always reconcilable — balances are backed by opening, purchase, and
sale movements. Sales and stock receipts are idempotent, so a repeated
submission never silently duplicates a transaction.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16.4, React 19, TypeScript, Tailwind CSS 4, installable PWA |
| Backend | Django 6.1, Django REST Framework, Gunicorn |
| Database | PostgreSQL 16 |
| AI reasoning | Meta Muse Spark via OpenAI-compatible chat completions |
| Speech-to-text | Browser Web Speech API, falling back to Meta Muse Voice Transcribe |
| Speech output | Browser text-to-speech |
| Documents | reportlab and pdfmake (branded receipts/invoices), pypdf and openpyxl/xlrd (uploads) |
| Deployment | Docker Compose behind Coolify/Traefik with automatic HTTPS |

## Demo data: GeoPure

The demo business is **GeoPure**, a real one-product business: purely,
carefully picked honey beans (Ewa Oloyin) in 2.5 kg, 5 kg, and 10 kg
packs — ₦7,000 / ₦14,000 / ₦28,000 today, up from ₦5,000 for the 2.5 kg
pack at launch. Open 8 am–8 pm daily, delivery or public pickup, cash
and transfer, no returns. That content, professionally written for
customers, is seeded into the business's knowledge base so the
assistant can answer policy questions from it.

In the Coolify backend container terminal:

```sh
# First run on the existing george / GeoPure workspace (replaces the
# old fictional general-store history with 26 months of beans trading):
python manage.py seed_geopure --replace-legacy

# Rerun any time to heal the profile, catalogue, policies and stock
# balances without duplicating history (always safe):
python manage.py seed_geopure
```

The seeder is idempotent and deterministic. It heals the existing
`george` account's GeoPure business — correct profile, three packs at
today's prices, verified hours/delivery/payment/returns rules — and
writes 26 months of history: about 540 sales with cash/transfer
payments and receipts, monthly restock purchases from Nigerian grains
suppliers, sorting, packaging, transport, rent, power, wages, and
marketing expenses that inflate and grow with the business. Historical
sales snapshot their era's price, so the journey from ₦5,000 to ₦7,000
is visible in the reports. Opening stock plus purchases minus sales
reconciles exactly with the closing balances.

Other seeders: `seed_demo` creates a small training shop
(`demo / demo1234`), and `seed_george --reset` rebuilds the original
two-shop fixture.

## Running locally

Prerequisites: Python 3.13, Node 20+, PostgreSQL.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env        # fill in DB values and secrets
python manage.py migrate
python manage.py seed_geopure --replace-legacy
python manage.py runserver    # http://127.0.0.1:8000
```

```powershell
cd frontend
npm install
npm run dev                   # http://localhost:3000
```

Or the full stack in Docker, the same shape Coolify runs:

```sh
cp .env.example .env          # fill in DB_PASSWORD and DJANGO_SECRET_KEY
docker compose up --build     # http://localhost:3003
```

Sign in with the existing `george` account (the seeder never invents or
resets passwords), open the Assistant, and say: *"Sell 2 honey beans
2.5kg."*

## Configuration

Everything is environment-driven; secrets never live in source control.

| Variable | Purpose |
| --- | --- |
| `DB_PASSWORD`, `DJANGO_SECRET_KEY` | Required secrets |
| `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` | Public hostname and HTTPS origin |
| `SHOP_TALK_AI_PROVIDER` | `meta` / `llm` (OpenAI-compatible), `anthropic`, `mock` (tests), or `heuristic` (offline default) |
| `SHOP_TALK_AI_API_KEY`, `SHOP_TALK_AI_BASE_URL`, `SHOP_TALK_AI_MODEL` | Muse Spark access, e.g. base `https://api.meta.ai/v1`, model `muse-spark-1.3` |
| `SHOP_TALK_AI_TRANSCRIBE_MODEL` | Optional override; defaults to `muse-voice-transcribe-1.0` on Meta, `whisper-1` elsewhere |

Deployment on Coolify is a Docker Compose resource from this
repository with the domain assigned to the frontend service on port
3003. Full steps: [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md).

## Testing

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py test core
```

The backend suite covers unit math, service transactions, API
permissions and tenant isolation, assistant orchestration against a
scripted provider, the PRD acceptance cases, a provider-quality
evaluation set, and the transcription endpoint.

```powershell
cd frontend
npx tsc --noEmit
npm run lint
npm run build
```

## Guardrails we can demonstrate

- No invented prices, stock, or figures — reports and answers come from
  deterministic code over saved records.
- No success claims without a committed backend result.
- Confirmation before every sale, stock receipt, and expense.
- Permissions checked server-side on every request, independent of the
  model.
- Atomic commits: a failed operation leaves no partial writes, and
  idempotency keys prevent duplicate transactions.
- Uploaded documents and pasted knowledge are data, never instructions.
- A complete audit log of every committed action.

## Hackathon demonstration (5 minutes)

1. Open GeoPure: three honey-beans packs, two years of trading on the
   Dashboard.
2. Ask *"How much did we sell this month?"* — the figure matches the
   Dashboard because both come from the same records.
3. Say *"Sell 2 honey beans 2.5kg"* by voice. Preview shows the
   server-side ₦14,000 total. Confirm; the receipt number returns and
   stock drops.
4. Say *"We received 20 honey beans 5kg"* and *"Spent 4,500 on delivery
   fuel"* — stock and expenses move too.
5. Ask *"What is running low?"* and *"What are your delivery and
   returns policies?"* — stock answers from balances, policy answers
   from the taught knowledge base.

If voice fails on the demo machine, type the same requests: identical
backend path. If the model provider is down, the heuristic provider
answers the core flows. See [DEMO.md](DEMO.md).

## Scope and roadmap

Deliberately out of scope for the MVP: full accounting, payroll, tax,
banking, automatic payments, and multi-branch operations.

Next: industry templates, supplier ordering and reorder suggestions,
payment-provider integrations, accounting exports, staff approval
workflows, and trend forecasting with stated assumptions.

## Documentation

- [ShopTalk_AI_PRD.md](ShopTalk_AI_PRD.md) — product requirements
- [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md) — production deployment
- [DEMO.md](DEMO.md) — guided demonstration script
- [DESIGN.md](DESIGN.md) — visual design system

---

**ShopTalk AI — Talk to your business. Understand what is happening.
Get things done.**
