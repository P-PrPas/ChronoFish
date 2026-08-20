package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// SQLConfig contains only the connection lifecycle settings needed by the
// canonical SQL store. Keeping this in store prevents HTTP transport code from
// owning database setup or migration semantics.
type SQLConfig struct {
	Driver          string
	URL             string
	MigrationsDir   string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

func OpenSQLRepository(ctx context.Context, cfg SQLConfig) (*SQLRepository, error) {
	driver := cfg.Driver
	sqlDriver := "pgx"
	if driver == "mysql" {
		sqlDriver = "mysql"
		if !strings.Contains(strings.ToLower(cfg.URL), "multistatements=") {
			separator := "?"
			if strings.Contains(cfg.URL, "?") {
				separator = "&"
			}
			cfg.URL += separator + "multiStatements=true"
		}
	}
	db, err := sql.Open(sqlDriver, cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	if err := RunMigrations(ctx, db, driver, cfg.MigrationsDir); err != nil {
		_ = db.Close()
		return nil, err
	}
	return NewSQLRepository(db, driver), nil
}
