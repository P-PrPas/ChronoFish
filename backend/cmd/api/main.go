package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

var version = "dev"

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

func newHandler(buildVersion, allowedOrigins string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if err := json.NewEncoder(w).Encode(healthResponse{Status: "ok", Version: buildVersion}); err != nil {
			log.Printf("write health response: %v", err)
		}
	})
	return withCORS(mux, allowedOrigins)
}

func withCORS(next http.Handler, allowedOrigins string) http.Handler {
	allowed := make(map[string]struct{})
	for origin := range strings.SplitSeq(allowedOrigins, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed[origin] = struct{}{}
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Operator-Id, X-Device-Id")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           newHandler(version, os.Getenv("CORS_ALLOWED_ORIGINS")),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("ChronoFish API %s listening on %s", version, server.Addr)
	log.Fatal(server.ListenAndServe())
}
