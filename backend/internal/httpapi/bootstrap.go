package httpapi

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"
)

func Run() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		response, err := http.Get("http://127.0.0.1:" + envOr("PORT", "8080") + "/api/v1/health")
		if err != nil || response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	store, err := openStateStore(context.Background(), cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	server := &http.Server{Addr: ":" + cfg.port, Handler: newHandlerWithConfig(version, cfg.allowedOrigins, store, cfg.ipAllowlist), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("ChronoFish API %s listening on %s", version, server.Addr)
	log.Fatal(server.ListenAndServe())
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
