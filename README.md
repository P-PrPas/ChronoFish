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

For a local stack with PostgreSQL, use `docker compose up --build`. The API
defaults to the portable memory driver so the UI can be exercised without a
database; set `DB_DRIVER=postgres` and `DATABASE_URL` when running against the
migrations in `backend/db/migrations/postgres`. A MySQL deployment uses the
generated files under `backend/db/migrations/mysql` and `DB_DRIVER=mysql`.

Writes require `X-Operator-Id` and `X-Device-Id`. Offline-capable clients also
send a stable `X-Idempotency-Key`; retries are safe and return the original
result. Never commit credentials in `.env` files.

Database migrations are applied in filename order. PostgreSQL is canonical; regenerate the MySQL copies after every schema change. CI boots both database engines, applies all migrations, and runs constraint smoke checks.

Optional initial master data is under `backend/db/seeds/{postgres,mysql}/master_data.sql`.

Configuration is documented in [`.env.example`](.env.example). Do not commit real credentials.
