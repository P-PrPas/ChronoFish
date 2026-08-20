package main

import (
	"errors"
	"fmt"
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
}

func loadConfig() (config, error) {
	cfg := config{
		port:            envOr("PORT", "8080"),
		dbDriver:        strings.ToLower(envOr("DB_DRIVER", "memory")),
		databaseURL:     strings.TrimSpace(os.Getenv("DATABASE_URL")),
		allowedOrigins:  strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS")),
		maxOpenConns:    envInt("DB_MAX_OPEN_CONNS", 10),
		maxIdleConns:    envInt("DB_MAX_IDLE_CONNS", 5),
		connMaxLifetime: envDuration("DB_CONN_MAX_LIFETIME", 5*time.Minute),
	}
	if cfg.port == "" {
		return config{}, errors.New("PORT must not be empty")
	}
	if cfg.dbDriver != "memory" && cfg.dbDriver != "postgres" && cfg.dbDriver != "mysql" {
		return config{}, fmt.Errorf("DB_DRIVER must be memory, postgres, or mysql")
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
