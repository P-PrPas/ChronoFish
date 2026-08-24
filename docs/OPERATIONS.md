# ChronoFish operations runbook

This runbook covers a clean local or self-hosted deployment. Hosting, TLS, backup retention, and the production database owner remain deployment decisions outside this repository.

## Configuration

Production API processes must use a real database:

```text
APP_ENV=production
DB_DRIVER=postgres
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/chronofish?sslmode=require
MIGRATIONS_DIR=/migrations/postgres
CORS_ALLOWED_ORIGINS=https://chronofish.example
IP_ALLOWLIST=10.0.0.0/8,192.168.1.0/24
```

`DB_DRIVER=memory` is restricted to development and test. Keep credentials in the deployment secret store, never in `.env` committed to the repository. The API validates configuration, connects, applies versioned migrations, loads canonical tables, and only then serves traffic.

The API is not a TLS terminator. Production traffic must reach it through an HTTPS reverse proxy or private VPN, with the proxy enforcing the approved IP/CIDR allowlist. Set `IP_ALLOWLIST` as a second control when the API can be reached outside that proxy. Do not trust arbitrary forwarded headers from public clients.

## Build and deploy

Build the API image from the repository root so migration files are included:

```powershell
docker build --build-arg VCS_REF=$(git rev-parse HEAD) -f backend/Dockerfile -t chronofish-api:local .
cd frontend
npm ci
npm run check
```

Serve `frontend/dist` from a static web server with SPA fallback to `index.html`, and proxy `/api/` to the API. Keep TLS termination and the external VPN/reverse-proxy allowlist in front of the API. If the API is directly reachable, set `IP_ALLOWLIST` as an additional control.

The API image is pinned to a patch-level Python base, runs as the non-root `chronofish` user, contains only the installed backend and migrations, and carries OCI build metadata. Scan the exact image that will be deployed before promotion; for example:

```powershell
trivy image --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 chronofish-api:local
docker image inspect chronofish-api:local --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The frontend is a static artifact. The production path does not require Node or a frontend container; if hosting requires one, use a separate web-server image with SPA fallback and keep Node out of the runtime image.

For the default PostgreSQL stack:

```powershell
docker compose -f compose.yaml up --build -d
docker compose -f compose.yaml ps
curl http://localhost:8080/api/v1/health
```

The MySQL compatibility stack is isolated in its own file and does not start PostgreSQL:

```powershell
docker compose -f compose.mysql.yaml --profile mysql up --build -d
curl http://localhost:8081/api/v1/health
```

## Backup and restore

Schedule a daily logical backup in the database platform or job runner and retain at least 30 days. Verify the job by restoring to a disposable database; never restore over production without an approved maintenance window.

PostgreSQL example:

```powershell
docker compose -f compose.yaml exec -T postgres pg_dump -U chronofish -d chronofish --format=custom > chronofish-YYYYMMDD.dump
createdb chronofish_restore
pg_restore --clean --if-exists --dbname=chronofish_restore chronofish-YYYYMMDD.dump
```

MySQL example:

```powershell
docker compose -f compose.mysql.yaml --profile mysql exec -T mysql mysqldump -uroot -proot --single-transaction chronofish > chronofish-YYYYMMDD.sql
mysql -h HOST -u chronofish -p chronofish_restore < chronofish-YYYYMMDD.sql
```

After a restore, check `/api/v1/health`, run the database constraint checks, and verify one idempotent mutation plus its audit entry before reopening traffic.

The API keeps no application state on the local filesystem. PostgreSQL/MySQL is the source of truth; local filesystem volumes are not a substitute for database backup or restore.

## Upgrade and rollback

Deploy the immutable API image, wait for the health check, and inspect logs for migration/load failures. A startup migration or canonical-load failure is fail-closed; keep the previous image available for application rollback. Do not manually edit migration history or roll back a non-transactional MySQL DDL migration. Restore a database backup into a new instance if data rollback is required, then point the API at that instance during a controlled cutover.

## Verification

The CI workflow validates OpenAPI, generated MySQL migrations, frontend build, Python tests/coverage, and boot/idempotency/restart smoke tests on PostgreSQL 16 and MySQL 8. Production UAT, browser/device validation, reference-export reconciliation, and the restore drill require the deployment owner and are not replaced by CI.
