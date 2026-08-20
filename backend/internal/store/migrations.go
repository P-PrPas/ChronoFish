package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/golang-migrate/migrate/v4"
	mysqlDriver "github.com/golang-migrate/migrate/v4/database/mysql"
	postgresDriver "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// RunMigrations applies the checked-in migrations before the API accepts traffic.
// golang-migrate owns versioning, SQL parsing, dirty-state recovery, and the
// PostgreSQL/MySQL driver differences. MySQL DDL remains statement-committed
// by the engine; the API never reports readiness until all files are applied.
func RunMigrations(ctx context.Context, db *sql.DB, driver, directory string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if driver != "postgres" && driver != "mysql" {
		return fmt.Errorf("unsupported migration driver %q", driver)
	}
	if directory == "" {
		candidates := []string{filepath.Join("backend", "db", "migrations", driver), filepath.Join("db", "migrations", driver), filepath.Join("/migrations", driver)}
		for _, candidate := range candidates {
			if _, err := os.Stat(candidate); err == nil {
				directory = candidate
				break
			} else if !errors.Is(err, fs.ErrNotExist) {
				return fmt.Errorf("migration directory: %w", err)
			}
		}
	}
	if directory == "" {
		return fmt.Errorf("migration directory for %s not found", driver)
	}
	if _, err := os.Stat(directory); err != nil {
		return fmt.Errorf("migration directory %s: %w", directory, err)
	}
	source, err := iofs.New(os.DirFS(filepath.Dir(directory)), filepath.Base(directory))
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	var m *migrate.Migrate
	switch driver {
	case "postgres":
		backend, err := postgresDriver.WithInstance(db, &postgresDriver.Config{MigrationsTable: "schema_migrations", MultiStatementEnabled: true})
		if err != nil {
			return fmt.Errorf("initialize PostgreSQL migrator: %w", err)
		}
		m, err = migrate.NewWithInstance("iofs", source, "postgres", backend)
		if err != nil {
			return fmt.Errorf("initialize PostgreSQL migrations: %w", err)
		}
	case "mysql":
		backend, err := mysqlDriver.WithInstance(db, &mysqlDriver.Config{MigrationsTable: "schema_migrations"})
		if err != nil {
			return fmt.Errorf("initialize MySQL migrator: %w", err)
		}
		m, err = migrate.NewWithInstance("iofs", source, "mysql", backend)
		if err != nil {
			return fmt.Errorf("initialize MySQL migrations: %w", err)
		}
	}
	if m == nil {
		return errors.New("migration instance was not initialized")
	}
	// Do not close the migrate instance here. Its database driver owns the
	// *sql.DB passed to WithInstance, and the API must keep that pool open for
	// canonical reads and writes after startup. The iofs source is read-only
	// and does not hold resources that need explicit shutdown.
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
