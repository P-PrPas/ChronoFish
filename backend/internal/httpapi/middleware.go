package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

func uuidV7() string {
	var b [16]byte
	now := time.Now().UnixMilli()
	binary.BigEndian.PutUint64(b[:8], uint64(now))
	if _, err := rand.Read(b[8:]); err != nil {
		copy(b[8:], []byte(hex.EncodeToString([]byte(strconv.FormatInt(now, 10)))))
	}
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", binary.BigEndian.Uint32(b[:4]), binary.BigEndian.Uint16(b[4:6]), binary.BigEndian.Uint16(b[6:8]), binary.BigEndian.Uint16(b[8:10]), b[10:])
}

func newHandler(buildVersion, allowedOrigins string) http.Handler {
	return newHandlerWithConfig(buildVersion, allowedOrigins, memoryStateStore{}, "")
}

func newHandlerWithStore(buildVersion, allowedOrigins string, store stateStore) http.Handler {
	return newHandlerWithConfig(buildVersion, allowedOrigins, store, "")
}

func newHandlerWithConfig(buildVersion, allowedOrigins string, store stateStore, ipAllowlist string) http.Handler {
	server := newAPIServer()
	server.buildVersion = buildVersion
	server.store = store
	if err := store.Load(context.Background(), server); err != nil {
		log.Printf("load runtime state: %v", err)
	}
	handler := http.HandlerFunc(server.ServeHTTP)
	return withSecurityPolicy(withCORS(handler, allowedOrigins), ipAllowlist)
}

func withSecurity(next http.Handler) http.Handler {
	return withSecurityPolicy(next, "")
}

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

type rateEntry struct {
	started time.Time
	count   int
}

func withSecurityPolicy(next http.Handler, allowlist string) http.Handler {
	limiter := &rateLimiter{entries: make(map[string]rateEntry)}
	allowed := parseCIDRs(allowlist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(allowed) > 0 && !ipAllowed(clientIP(r), allowed) {
			writeAPIError(w, http.StatusForbidden, "network_denied", "à¹€à¸„à¸£à¸·à¸­à¸‚à¹ˆà¸²à¸¢à¸™à¸µà¹‰à¹„à¸¡à¹ˆà¹„à¸”à¹‰à¸£à¸±à¸šà¸­à¸™à¸¸à¸à¸²à¸•")
			return
		}
		if !limiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			writeAPIError(w, http.StatusTooManyRequests, "rate_limited", "à¹€à¸£à¸µà¸¢à¸ API à¸–à¸µà¹ˆà¹€à¸à¸´à¸™à¹„à¸› à¸à¸£à¸¸à¸“à¸²à¸¥à¸­à¸‡à¹ƒà¸«à¸¡à¹ˆà¸ à¸²à¸¢à¸«à¸¥à¸±à¸‡")
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		defer func() {
			if recovered := recover(); recovered != nil {
				writeAPIError(w, 500, "internal_error", "à¹€à¸à¸´à¸”à¸‚à¹‰à¸­à¸œà¸´à¸”à¸žà¸¥à¸²à¸”à¸ à¸²à¸¢à¹ƒà¸™à¸£à¸°à¸šà¸š")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (l *rateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	item := l.entries[ip]
	if item.started.IsZero() || now.Sub(item.started) >= time.Minute {
		l.entries[ip] = rateEntry{started: now, count: 1}
		return true
	}
	if item.count >= 120 {
		return false
	}
	item.count++
	l.entries[ip] = item
	return true
}
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
func parseCIDRs(value string) []*net.IPNet {
	result := make([]*net.IPNet, 0)
	for _, raw := range strings.Split(value, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if strings.Contains(raw, "/") {
			if _, network, err := net.ParseCIDR(raw); err == nil {
				result = append(result, network)
			}
		} else if ip := net.ParseIP(raw); ip != nil {
			bits := 128
			if ip.To4() != nil {
				bits = 32
				ip = ip.To4()
			}
			result = append(result, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return result
}
func ipAllowed(value string, networks []*net.IPNet) bool {
	ip := net.ParseIP(value)
	for _, network := range networks {
		if ip != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func withCORS(next http.Handler, allowedOrigins string) http.Handler {
	allowed := make(map[string]struct{})
	for _, origin := range strings.Split(allowedOrigins, ",") {
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
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Operator-Id, X-Device-Id, X-Idempotency-Key")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
