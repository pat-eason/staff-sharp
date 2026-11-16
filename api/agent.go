package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AgentClient talks to the Flue agent service. The agent service is a thin LLM
// runner: Go owns the data, builds the prompts and applies the structured results.
type AgentClient struct {
	baseURL string
	token   string
	hint    string // appended to "unreachable" errors
	http    *http.Client
}

func newAgentClient(baseURL, token, hint string) *AgentClient {
	return &AgentClient{baseURL: strings.TrimRight(baseURL, "/"), token: token, hint: hint, http: &http.Client{Timeout: 4 * time.Minute}}
}

type agentError struct{ msg string }

func (e agentError) Error() string { return e.msg }

// Run executes a one-shot agent ("grade", "generate", "debrief" or "insight") and returns its structured result.
// cfg is sent only to the Claude Code runner, which keeps no settings of its own.
func (a *AgentClient) Run(ctx context.Context, kind, runID, message string, cfg *AgentConfig) (json.RawMessage, error) {
	payload := map[string]any{"id": runID, "message": message}
	if cfg != nil {
		payload["config"] = cfg
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/run/"+kind, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-token", a.token)
	res, err := a.http.Do(req)
	if err != nil {
		return nil, a.unreachable(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode >= 300 || out.Error != "" {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("agent service returned %d", res.StatusCode)
		}
		return nil, agentError{msg}
	}
	return out.Result, nil
}

func (a *AgentClient) unreachable(err error) error {
	msg := "agent service unreachable: " + err.Error()
	if a.hint != "" {
		msg = a.hint
	}
	return agentError{msg}
}

// post sends a JSON request and returns the raw response; non-2xx becomes an agentError.
func (a *AgentClient) post(ctx context.Context, path string, payload any, timeout time.Duration) (*http.Response, error) {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-token", a.token)
	client := &http.Client{Timeout: timeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, a.unreachable(err)
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = fmt.Sprintf("agent service returned %d", res.StatusCode)
		}
		return nil, agentError{e.Error}
	}
	return res, nil
}

// Test makes a tiny request on the Claude Code subscription.
func (a *AgentClient) Test(ctx context.Context, cfg AgentConfig) (string, error) {
	res, err := a.post(ctx, "/test", map[string]any{"config": cfg}, 60*time.Second)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		Reply string `json:"reply"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	return out.Reply, nil
}

