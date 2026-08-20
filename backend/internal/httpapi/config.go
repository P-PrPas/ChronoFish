package httpapi

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	port            string
	dbDriver        string
	databaseURL     string
	allowedOrigins  string
	maxOpenConns    int
	maxIdleConns    int
	connMaxLifetime time.Duration
	migrationsDir   string
	ipAllowlist     string
	appEnv          string
}

func loadConfig() (config, error) {
	appEnv := strings.ToLower(strings.TrimSpace(envOr("APP_ENV", "production")))
	defaultDriver := "postgres"
	if appEnv == "test" || appEnv == "development" || appEnv == "dev" {
		defaultDriver = "memory"
	}
	cfg := config{
		port:            envOr("PORT", "8080"),
		dbDriver:        strings.ToLower(envOr("DB_DRIVER", defaultDriver)),
		databaseURL:     strings.TrimSpace(os.Getenv("DATABASE_URL")),
		allowedOrigins:  strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS")),
		maxOpenConns:    envInt("DB_MAX_OPEN_CONNS", 10),
		maxIdleConns:    envInt("DB_MAX_IDLE_CONNS", 5),
		connMaxLifetime: envDuration("DB_CONN_MAX_LIFETIME", 5*time.Minute),
		migrationsDir:   strings.TrimSpace(os.Getenv("MIGRATIONS_DIR")),
		ipAllowlist:     strings.TrimSpace(os.Getenv("IP_ALLOWLIST")),
		appEnv:          appEnv,
	}
	if cfg.port == "" {
		return config{}, errors.New("PORT must not be empty")
	}
	if cfg.dbDriver != "memory" && cfg.dbDriver != "postgres" && cfg.dbDriver != "mysql" {
		return config{}, fmt.Errorf("DB_DRIVER must be memory, postgres, or mysql")
	}
	if cfg.dbDriver == "memory" && cfg.appEnv != "test" && cfg.appEnv != "development" && cfg.appEnv != "dev" {
		return config{}, errors.New("DB_DRIVER=memory is only allowed for development or test")
	}
	if cfg.ipAllowlist != "" {
		for _, raw := range strings.Split(cfg.ipAllowlist, ",") {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			if strings.Contains(raw, "/") {
				if _, _, err := net.ParseCIDR(raw); err != nil {
					return config{}, fmt.Errorf("IP_ALLOWLIST contains invalid CIDR %q", raw)
				}
			} else if net.ParseIP(raw) == nil {
				return config{}, fmt.Errorf("IP_ALLOWLIST contains invalid IP %q", raw)
			}
		}
	}
	if cfg.dbDriver != "memory" && cfg.databaseURL == "" {
		return config{}, errors.New("DATABASE_URL is required when DB_DRIVER is not memory")
	}
	if cfg.maxOpenConns < 1 || cfg.maxIdleConns < 0 || cfg.maxIdleConns > cfg.maxOpenConns || cfg.connMaxLifetime <= 0 {
		return config{}, errors.New("database pool limits are invalid")
	}
	return cfg, nil
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(envOr(name, strconv.Itoa(fallback)))
	if err != nil {
		return -1
	}
	return value
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(envOr(name, fallback.String()))
	if err != nil {
		return -1
	}
	return value
}
