# KUVTH Zebrafish LIMS

KUVTH Zebrafish LIMS tracks SCNT zebrafish experiments from injection through embryo checkpoints and clone-fish follow-up. This repository is the implementation baseline for SRS v1.0.

## Repository layout

```text
api/        OpenAPI 3.1 contract (single source of truth)
backend/    Python API and portable PostgreSQL/MySQL migrations
frontend/   Static React + TypeScript application
docs/       Project documentation grouped by purpose
scripts/    Contract and migration checks
```

The backend uses a Python `src` layout. Inside `backend/src/chronofish`, `app.py`
composes FastAPI, `api/routes` groups HTTP routes by domain capability, `domain`
contains state and pure rules, `services` applies business rules to state,
`runtime` owns shared request behavior, `store` contains the memory/SQL adapters
and migrations, and `reporting` contains file
encoders. Keep new code in the narrowest existing module; add a package only
when it has real implementation.

## Run locally

Requirements: Python 3.13+, Node.js 22+, npm.

```powershell
# terminal 1
cd backend
$env:APP_ENV="development"
$env:DB_DRIVER="memory"
python -m pip install -c constraints.txt -e ".[dev]"
python -m chronofish

# terminal 2
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the Python server on port 8080.

## Validate

```powershell
cd backend
python -m pytest
cd ..
python -m pip install -r requirements-dev.txt
python scripts/validate_openapi.py
python scripts/gen_mysql_migrations.py
git diff --exit-code -- backend/db/migrations/mysql
cd frontend
npm ci
npm run generate:api
npm run check
```

For a local stack with PostgreSQL, copy `.env.example` to `.env` (PowerShell:
`Copy-Item .env.example .env`) and use
`docker compose up --build`; Compose starts the frontend image, API and
PostgreSQL. Open `http://localhost:5173`; the frontend nginx proxy forwards
`/api/` to the API service. The direct API port is bound to `127.0.0.1` for
local diagnostics; remote clients must use the frontend proxy. The isolated
MySQL 8 stack is in `compose.mysql.yaml`; start it with
`docker compose -f compose.mysql.yaml --profile mysql up --build` so the
PostgreSQL services are not started alongside it.
Production configuration defaults to PostgreSQL and requires `DATABASE_URL`.
The memory driver is available only when `APP_ENV=development|test` (for
offline UI work and unit tests) and is never a Compose default.

Writes require `X-Operator-Id` and `X-Device-Id`. Offline-capable clients also
send a stable `X-Idempotency-Key`; retries are safe and return the original
result. Set `IP_ALLOWLIST` to comma-separated CIDRs when the API is not behind
a VPN/reverse proxy; otherwise enforce HTTPS, IP allowlisting and TLS at the
reverse proxy. API requests are rate limited per source IP. Never commit
credentials in `.env` files.

Database migrations are applied by the Python migration runner from the versioned SQL files.
PostgreSQL is canonical; regenerate the MySQL copies after every schema change.
CI boots both database engines, applies all migrations, and runs constraint
smoke checks.

Optional initial master data is under `backend/db/seeds/{postgres,mysql}/master_data.sql`.

`docker compose --profile demo up --build` additionally loads
`backend/db/seeds/postgres/demo_data.sql`. That seed deletes and recreates every
record owned by its demo batches — including anything entered through the UI
against them — so run it only against a throwaway database, never a real one.

Configuration is documented in [`.env.example`](.env.example). Do not commit real credentials.

Deployment, backup/restore, and upgrade procedures are documented in [`docs/operations/OPERATIONS.md`](docs/operations/OPERATIONS.md). See [`docs/README.md`](docs/README.md) for the documentation index.
