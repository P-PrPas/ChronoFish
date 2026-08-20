package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4/source/iofs"
)

func TestMigrationFilesUseStandardSourceParser(t *testing.T) {
	root := filepath.Join("..", "..", "db", "migrations")
	source, err := iofs.New(os.DirFS(root), "postgres")
	if err != nil {
		t.Fatalf("create migration source: %v", err)
	}
	version, err := source.First()
	if err != nil {
		t.Fatalf("read first migration: %v", err)
	}
	if version != 1 {
		t.Fatalf("first migration version = %d, want 1", version)
	}
}

func TestIdempotencyUpgradePreservesV3AndAddsFencedLease(t *testing.T) {
	root := filepath.Join("..", "..", "db", "migrations")
	v3, err := os.ReadFile(filepath.Join(root, "postgres", "000003_request_idempotency.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(v3), "lease_until") || strings.Contains(string(v3), "lease_token") {
		t.Fatal("v3 must remain immutable and must not contain lease columns")
	}
	v4, err := os.ReadFile(filepath.Join(root, "postgres", "000004_idempotency_lease.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"ADD COLUMN lease_until", "ADD COLUMN lease_token", "lease_token = idempotency_key", "ALTER COLUMN response_body TYPE TEXT"} {
		if !strings.Contains(string(v4), marker) {
			t.Fatalf("v4 missing upgrade marker %q", marker)
		}
	}
	mysqlV3, err := os.ReadFile(filepath.Join(root, "mysql", "000003_request_idempotency.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(mysqlV3), "LONGTEXT") || strings.Contains(string(mysqlV3), "lease_until") {
		t.Fatal("MySQL v3 must retain its original TEXT schema")
	}
	mysqlV4, err := os.ReadFile(filepath.Join(root, "mysql", "000004_idempotency_lease.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mysqlV4), "MODIFY response_body LONGTEXT NOT NULL") || !strings.Contains(string(mysqlV4), "lease_token CHAR(36)") {
		t.Fatal("MySQL v4 must widen response bodies and add the fencing token")
	}
}

func TestRunMigrationsHonoursCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := RunMigrations(ctx, nil, "postgres", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}
