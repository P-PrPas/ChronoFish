package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RunMigrations is the database lifecycle seam used by the API composition.
// Each migration is applied in its own transaction and recorded before the
// server accepts requests.
func RunMigrations(ctx context.Context, db *sql.DB, driver, directory string) error {
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
	placeholder := func(index int) string {
		if driver == "postgres" {
			return fmt.Sprintf("$%d", index)
		}
		return "?"
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS chronofish_schema_migration (version VARCHAR(40) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL)`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS chronofish_runtime_state (resource VARCHAR(80) NOT NULL, record_id CHAR(36) NOT NULL, payload TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMP NOT NULL, PRIMARY KEY (resource, record_id))`); err != nil {
		return fmt.Errorf("create runtime state table: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS chronofish_runtime_idempotency (scope VARCHAR(100) NOT NULL PRIMARY KEY, response TEXT NOT NULL, created_at TIMESTAMP NOT NULL)`); err != nil {
		return fmt.Errorf("create idempotency table: %w", err)
	}
	files, err := filepath.Glob(filepath.Join(directory, "*.up.sql"))
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, file := range files {
		name := filepath.Base(file)
		var exists int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM chronofish_schema_migration WHERE version = `+placeholder(1), name).Scan(&exists); err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		if exists > 0 {
			continue
		}
		contents, err := os.ReadFile(file)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		failed := func(cause error) error { _ = tx.Rollback(); return fmt.Errorf("apply migration %s: %w", name, cause) }
		for _, statement := range splitSQLStatements(string(contents)) {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return failed(err)
			}
		}
		query := `INSERT INTO chronofish_schema_migration (version, applied_at) VALUES (` + placeholder(1) + `,` + placeholder(2) + `)`
		if _, err := tx.ExecContext(ctx, query, name, time.Now().UTC()); err != nil {
			return failed(err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

func splitSQLStatements(sqlText string) []string {
	statements := make([]string, 0)
	start, quote := 0, byte(0)
	for index := 0; index < len(sqlText); index++ {
		character := sqlText[index]
		if quote != 0 {
			if character == quote {
				if index+1 < len(sqlText) && sqlText[index+1] == quote {
					index++
				} else {
					quote = 0
				}
			}
			continue
		}
		if character == '\'' || character == '"' || character == '`' {
			quote = character
			continue
		}
		if character == ';' {
			if statement := strings.TrimSpace(sqlText[start:index]); statement != "" {
				statements = append(statements, statement)
			}
			start = index + 1
		}
	}
	if statement := strings.TrimSpace(sqlText[start:]); statement != "" {
		statements = append(statements, statement)
	}
	return statements
}
