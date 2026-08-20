package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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

func TestRunMigrationsHonoursCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := RunMigrations(ctx, nil, "postgres", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}
