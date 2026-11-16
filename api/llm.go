package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"
)

var errLLMOff = errors.New("no model provider configured")

// llmActive reports whether a model provider is configured (it does not check that it works).
func (s *Server) llmActive(ctx context.Context) bool {
	st, err := s.cfg.Get(ctx)
	if err != nil || st.LLMProvider == providerOff {
		return false
	}
	if st.LLMProvider == providerAPIKey {
		key, _ := s.cfg.APIKey(ctx)
		return key != ""
	}
	return true
}

// runLLM runs one structured agent ("grade", "generate", "debrief", "insight") on whichever
// provider the settings select. At most a few calls run at once so a long regiment cannot
// flood a subscription's rate limit.
func (s *Server) runLLM(ctx context.Context, kind, message string) (json.RawMessage, string, error) {
	st, err := s.cfg.Get(ctx)
	if err != nil {
		return nil, "", err
	}
	if st.LLMProvider == providerOff {
		return nil, "", errLLMOff
	}
	select {
	case s.llmSem <- struct{}{}:
		defer func() { <-s.llmSem }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	start := time.Now()
	runID := kind + "-" + randomID(8)
	var out json.RawMessage
	switch st.LLMProvider {
	case providerAPIKey:
		if key, _ := s.cfg.APIKey(ctx); key == "" {
			return nil, "", errLLMOff
		}
		out, err = s.agent.Run(ctx, kind, runID, message, nil)
	case providerClaudeCode:
		cfg, cerr := s.cfg.Agent(ctx)
		if cerr != nil {
			return nil, "", cerr
		}
		cfg.APIKey = ""
		out, err = s.runner.Run(ctx, kind, runID, message, &cfg)
	}
	level := slog.LevelInfo
	if err != nil {
		level = slog.LevelWarn
	}
	slog.Log(ctx, level, "llm run", "operation", "llm."+kind, "provider", st.LLMProvider, "runId", runID,
		"durationMs", time.Since(start).Milliseconds(), "ok", err == nil)
	return out, st.LLMProvider, err
}
