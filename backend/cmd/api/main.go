package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

var version = "dev"

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

func newHandler(buildVersion string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(healthResponse{Status: "ok", Version: buildVersion}); err != nil {
			log.Printf("write health response: %v", err)
		}
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           newHandler(version),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("ChronoFish API %s listening on %s", version, server.Addr)
	log.Fatal(server.ListenAndServe())
}
