package httpapi

import "testing"

func TestLoadConfigDefaultsToMemory(t *testing.T) {
	t.Setenv("APP_ENV", "development")
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

func TestLoadConfigProductionDefaultsToPostgres(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DB_DRIVER", "")
	t.Setenv("DATABASE_URL", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected production to require postgres DATABASE_URL")
	}
}

func TestLoadConfigRejectsInvalidAllowlist(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("DB_DRIVER", "memory")
	t.Setenv("IP_ALLOWLIST", "not-an-ip")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected invalid IP_ALLOWLIST error")
	}
}

func TestLoadConfigRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DATABASE_URL", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected missing DATABASE_URL error")
	}
}
