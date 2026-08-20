# ChronoFish

ChronoFish tracks SCNT zebrafish experiments from injection through embryo checkpoints and clone-fish follow-up. This repository is the implementation baseline for SRS v1.0.

## Repository layout

```text
api/        OpenAPI 3.1 contract (single source of truth)
backend/    Go API and portable PostgreSQL/MySQL migrations
frontend/   Static React + TypeScript application
docs/       Requirements and SRS
scripts/    Contract and migration checks
```

## Run locally

Requirements: Go 1.24+, Node.js 22+, npm, Python 3.12+.

```powershell
# terminal 1
cd backend
$env:APP_ENV="development"
$env:DB_DRIVER="memory"
go run ./cmd/api

# terminal 2
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the Go server on port 8080.

## Validate

```powershell
cd backend
go test ./...
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

For a local stack with PostgreSQL, use `docker compose up --build`; Compose
uses PostgreSQL 16 and the API applies migrations before serving traffic. A
MySQL 8 deployment uses `docker compose --profile mysql up --build`.
Production configuration defaults to PostgreSQL and requires `DATABASE_URL`.
The memory driver is available only when `APP_ENV=development|test` (for
offline UI work and unit tests) and is never a Compose default.

Writes require `X-Operator-Id` and `X-Device-Id`. Offline-capable clients also
send a stable `X-Idempotency-Key`; retries are safe and return the original
result. Set `IP_ALLOWLIST` to comma-separated CIDRs when the API is not behind
a VPN/reverse proxy; otherwise enforce HTTPS, IP allowlisting and TLS at the
reverse proxy. API requests are rate limited per source IP. Never commit
credentials in `.env` files.

Database migrations are applied in filename order. PostgreSQL is canonical; regenerate the MySQL copies after every schema change. CI boots both database engines, applies all migrations, and runs constraint smoke checks.

Optional initial master data is under `backend/db/seeds/{postgres,mysql}/master_data.sql`.

Configuration is documented in [`.env.example`](.env.example). Do not commit real credentials.
