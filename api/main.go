package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	appSecret := env("APP_SECRET", "")
	if appSecret == "" {
		appSecret = "dev-only-secret-change-me"
		slog.Warn("APP_SECRET is not set; the stored API key is encrypted with a development default")
	}
	tax, err := loadTaxonomy()
	if err != nil {
		slog.Error("taxonomy load failed", "error", err)
		os.Exit(1)
	}
	pool, err := connect(ctx, env("DATABASE_URL", "postgres://quiz:quiz@localhost:5432/quiz?sslmode=disable"))
	if err != nil {
		slog.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	version, applied, err := migrate(ctx, pool)
	if err != nil {
		slog.Error("migration failed", "error", err)
		os.Exit(1)
	}
	slog.Info("database ready", "schemaVersion", version, "migrationsApplied", applied)
	if err := seedBank(ctx, pool, tax); err != nil {
		slog.Error("seeding the question bank failed", "error", err)
		os.Exit(1)
	}

	store := &Store{pool: pool}
	token := env("INTERNAL_TOKEN", "dev-internal-token")
	concurrency, _ := strconv.Atoi(env("LLM_CONCURRENCY", "2"))
	srv := &Server{
		pool:  pool,
		store: store,
		tax:   tax,
		cfg:   newConfig(store, appSecret, os.Getenv("ANTHROPIC_API_KEY")),
		agent: newAgentClient(env("AGENT_URL", "http://localhost:3000"), token,
			"The Flue agent service is not running. Check it with: docker compose ps agent"),
		runner: newAgentClient(env("CLAUDE_CODE_AGENT_URL", "http://localhost:3100"), token,
			"The Claude Code runner is not running. Check it with: docker compose ps claude-runner"),
		llmSem:        make(chan struct{}, max(1, concurrency)),
		internalToken: token,
	}
	srv.jobs = newJobs(srv, max(1, concurrency))
	srv.jobs.resume(ctx)

	httpSrv := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      6 * time.Minute, // the insight call waits on a model
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	slog.Info("api listening", "addr", httpSrv.Addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
