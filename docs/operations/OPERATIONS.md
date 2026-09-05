# KUVTH Zebrafish LIMS operations runbook

This runbook covers a clean local or self-hosted deployment. Hosting, TLS, backup retention, and the production database owner remain deployment decisions outside this repository.

## Configuration

Production API processes must use a real database:

```text
APP_ENV=production
DB_DRIVER=postgres
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/chronofish?sslmode=require
MIGRATIONS_DIR=/migrations/postgres
CORS_ALLOWED_ORIGINS=https://kuvth-zebrafish-lims.example
IP_ALLOWLIST=10.0.0.0/8,192.168.1.0/24
```

`DB_DRIVER=memory` is restricted to development and test. Keep credentials in the deployment secret store, never in `.env` committed to the repository. The API validates configuration, connects, applies versioned migrations, loads canonical tables, and only then serves traffic.

The API is not a TLS terminator. Production traffic must reach it through an HTTPS reverse proxy or private VPN, with the proxy enforcing the approved IP/CIDR allowlist. Set `IP_ALLOWLIST` as a second control when the API can be reached outside that proxy. Do not trust arbitrary forwarded headers from public clients.

## Build and deploy

Build the API image from the repository root so migration files are included:

```powershell
$imageBuildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$imageRevision = git rev-parse HEAD
docker build --build-arg "BUILD_DATE=$imageBuildDate" --build-arg "VCS_REF=$imageRevision" -f backend/Dockerfile -t kuvth-zebrafish-lims-api:local .
cd frontend
npm ci
npm run check
```

For a native API process, install the reviewed dependency resolution instead of resolving new transitive versions during deployment:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -c constraints.txt .
```

Serve `frontend/dist` from a static web server with SPA fallback to `index.html`, and proxy `/api/` to the API. Keep TLS termination and the external VPN/reverse-proxy allowlist in front of the API. If the API is directly reachable, set `IP_ALLOWLIST` as an additional control.

The API image is pinned to a patch-level Python base, runs as the non-root `chronofish` user, contains only the installed backend and migrations, and carries OCI build metadata. Scan the exact image that will be deployed before promotion; for example:

```powershell
trivy image --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 kuvth-zebrafish-lims-api:local
docker image inspect kuvth-zebrafish-lims-api:local --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The frontend is a static artifact. The repository also provides an optional nginx image for environments that want one Compose stack: it builds with Node, runs the static files with unprivileged nginx, proxies `/api/` to the API service, and has SPA fallback. Node is not present in the runtime image. For static hosting, deploy `frontend/dist` directly instead.

For the default PostgreSQL stack:

```powershell
docker compose -f compose.yaml up --build -d
docker compose -f compose.yaml ps
curl http://localhost:5173/
curl http://localhost:5173/api/v1/health
```

Compose binds the direct API ports (`8080` for PostgreSQL and `8081` for MySQL)
to `127.0.0.1`. Network clients use the frontend proxy, which normalizes the
forwarded client address before the API applies `IP_ALLOWLIST` and rate limits.

The MySQL compatibility stack is isolated in its own file and does not start PostgreSQL:

```powershell
docker compose -f compose.mysql.yaml --profile mysql up --build -d
curl http://localhost:5173/
curl http://localhost:5173/api/v1/health
```

## Backup and restore

Schedule a daily logical backup in the database platform or job runner and retain at least 30 days. Verify the job by restoring to a disposable database; never restore over production without an approved maintenance window.

PostgreSQL example:

```powershell
docker compose -f compose.yaml exec -T postgres pg_dump -U chronofish -d chronofish --format=custom --file=/tmp/kuvth-zebrafish-lims.dump
docker compose -f compose.yaml cp postgres:/tmp/kuvth-zebrafish-lims.dump ./kuvth-zebrafish-lims-YYYYMMDD.dump
docker compose -f compose.yaml exec -T postgres createdb -U chronofish chronofish_restore
docker compose -f compose.yaml cp ./kuvth-zebrafish-lims-YYYYMMDD.dump postgres:/tmp/kuvth-zebrafish-lims-restore.dump
docker compose -f compose.yaml exec -T postgres pg_restore -U chronofish --clean --if-exists --dbname=chronofish_restore /tmp/kuvth-zebrafish-lims-restore.dump
```

MySQL example:

```powershell
docker compose -f compose.mysql.yaml --profile mysql exec -T mysql mysqldump -uroot -proot --single-transaction --result-file=/tmp/kuvth-zebrafish-lims.sql chronofish
docker compose -f compose.mysql.yaml --profile mysql cp mysql:/tmp/kuvth-zebrafish-lims.sql ./kuvth-zebrafish-lims-YYYYMMDD.sql
docker compose -f compose.mysql.yaml --profile mysql exec -T mysql mysql -uroot -proot --execute="CREATE DATABASE chronofish_restore"
docker compose -f compose.mysql.yaml --profile mysql cp ./kuvth-zebrafish-lims-YYYYMMDD.sql mysql:/tmp/kuvth-zebrafish-lims-restore.sql
docker compose -f compose.mysql.yaml --profile mysql exec -T mysql mysql -uroot -proot chronofish_restore --execute="source /tmp/kuvth-zebrafish-lims-restore.sql"
```

After a restore, check `/api/v1/health`, run the database constraint checks, and verify one idempotent mutation plus its audit entry before reopening traffic.

The API keeps no application state on the local filesystem. PostgreSQL/MySQL is the source of truth; local filesystem volumes are not a substitute for database backup or restore.

## Upgrade and rollback

Deploy the immutable API image, wait for the health check, and inspect logs for migration/load failures. A startup migration or canonical-load failure is fail-closed; keep the previous image available for application rollback. Do not manually edit migration history or roll back a non-transactional MySQL DDL migration. Restore a database backup into a new instance if data rollback is required, then point the API at that instance during a controlled cutover.

## Verification

The CI workflow validates OpenAPI, generated MySQL migrations, frontend build, Python tests/coverage, and boot/idempotency/restart smoke tests on PostgreSQL 16 and MySQL 8. Production UAT, browser/device validation, reference-export reconciliation, and the restore drill require the deployment owner and are not replaced by CI.
