package main

import "testing"

func TestLoadConfigDefaultsToMemory(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("DB_DRIVER", "memory")
	t.Setenv("DATABASE_URL", "")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.dbDriver != "memory" || cfg.maxOpenConns != 10 {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestLoadConfigRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DATABASE_URL", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected missing DATABASE_URL error")
	}
}
