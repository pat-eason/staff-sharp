package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"time"
)

type badRequest struct{ msg string }

func (e badRequest) Error() string { return e.msg }

func bad(format string, args ...any) error { return badRequest{fmt.Sprintf(format, args...)} }

// conflict is a 409 the UI handles (time is up, session paused, already submitted).
type conflict struct{ msg string }

func (e conflict) Error() string { return e.msg }

var errNotFound = errors.New("not found")

type ctxKey string

const reqIDKey ctxKey = "requestId"

type jsonRaw json.RawMessage

func (j jsonRaw) MarshalJSON() ([]byte, error) {
	if len(j) == 0 {
		return []byte("null"), nil
	}
	return j, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decode(r *http.Request, dst any) error {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return bad("invalid JSON body: %v", err)
	}
	return nil
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func pathUUID(r *http.Request, name string) (string, error) {
	v := r.PathValue(name)
	if !uuidRe.MatchString(v) {
		return "", bad("invalid %s", name)
	}
	return v, nil
}

func reqID(r *http.Request) string {
	v, _ := r.Context().Value(reqIDKey).(string)
	return v
}

func randomID(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var br badRequest
	var cf conflict
	var ae agentError
	switch {
	case errors.As(err, &br):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": br.msg})
	case errors.As(err, &cf):
		writeJSON(w, http.StatusConflict, map[string]string{"error": cf.msg})
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, errLLMOff):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "No model provider is configured. Choose one in Settings."})
	case errors.As(err, &ae):
		slog.Warn("agent failure", "requestId", reqID(r), "operation", r.Method+" "+r.URL.Path, "error", ae.msg)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": ae.msg})
	default:
		slog.Error("request failed", "requestId", reqID(r), "operation", r.Method+" "+r.URL.Path, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

// handle wraps a handler that returns (value, error); a nil value responds 204.
func (s *Server) handle(fn func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out, err := fn(r)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if out == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := randomID(6)
		r = r.WithContext(context.WithValue(r.Context(), reqIDKey, id))
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		w.Header().Set("x-request-id", id)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic", "requestId", id, "panic", fmt.Sprint(rec))
				writeJSON(sw, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			}
			if r.URL.Path != "/healthz" && r.URL.Path != "/internal/config" {
				slog.Debug("request", "requestId", id, "operation", r.Method+" "+r.URL.Path, "status", sw.status,
					"durationMs", time.Since(start).Milliseconds())
			}
		}()
		next.ServeHTTP(sw, r)
	})
}
