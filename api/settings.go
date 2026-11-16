package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	providerOff        = "off"
	providerAPIKey     = "api_key"
	providerClaudeCode = "claude_code"
)

// Settings are the model provider choices. Everything else about the user lives in Profile.
type Settings struct {
	LLMProvider        string `json:"llmProvider"`
	GraderModel        string `json:"graderModel"`
	GeneratorModel     string `json:"generatorModel"`
	CoachModel         string `json:"coachModel"`
	ThinkingLevel      string `json:"thinkingLevel"`
	GraderInstructions string `json:"graderInstructions"`
}

type SettingsView struct {
	Settings
	APIKeySource string  `json:"apiKeySource"` // stored | env | none
	APIKeyHint   *string `json:"apiKeyHint"`
}

// AgentConfig is what the agent services receive. The Flue service fetches it (with the key) from
// /internal/config; the Claude Code runner gets it in every request body (key stripped).
type AgentConfig struct {
	Settings
	APIKey string `json:"apiKey"`
}

func defaultSettings() Settings {
	return Settings{
		LLMProvider:    providerOff,
		GraderModel:    "claude-sonnet-5-5",
		GeneratorModel: "claude-sonnet-5-5",
		CoachModel:     "claude-sonnet-5-5",
		ThinkingLevel:  "low",
	}
}

type settingsPatch struct {
	LLMProvider        *string `json:"llmProvider"`
	GraderModel        *string `json:"graderModel"`
	GeneratorModel     *string `json:"generatorModel"`
	CoachModel         *string `json:"coachModel"`
	ThinkingLevel      *string `json:"thinkingLevel"`
	GraderInstructions *string `json:"graderInstructions"`
	APIKey             *string `json:"apiKey"`
}

var thinkingLevels = map[string]bool{"off": true, "minimal": true, "low": true, "medium": true, "high": true}

type Store struct{ pool *pgxpool.Pool }

// Config owns settings persistence and API key encryption.
type Config struct {
	store  *Store
	secret [32]byte
	envKey string
}

func newConfig(store *Store, appSecret, envKey string) *Config {
	return &Config{store: store, secret: sha256.Sum256([]byte(appSecret)), envKey: envKey}
}

func (c *Config) Get(ctx context.Context) (Settings, error) {
	s := defaultSettings()
	var raw []byte
	err := c.store.pool.QueryRow(ctx, `SELECT value FROM settings WHERE key = 'config'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		// First run: an API key in the environment means the user wants the API-key provider.
		if c.envKey != "" {
			s.LLMProvider = providerAPIKey
		}
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return defaultSettings(), nil
	}
	return s, nil
}

func (c *Config) Patch(ctx context.Context, p settingsPatch) (Settings, error) {
	s, err := c.Get(ctx)
	if err != nil {
		return s, err
	}
	set := func(dst *string, src *string) {
		if src != nil {
			*dst = strings.TrimSpace(*src)
		}
	}
	set(&s.GraderModel, p.GraderModel)
	set(&s.GeneratorModel, p.GeneratorModel)
	set(&s.CoachModel, p.CoachModel)
	if p.GraderInstructions != nil {
		s.GraderInstructions = *p.GraderInstructions
	}
	if p.LLMProvider != nil {
		switch *p.LLMProvider {
		case providerOff, providerAPIKey, providerClaudeCode:
			s.LLMProvider = *p.LLMProvider
		default:
			return s, bad("invalid provider")
		}
	}
	if p.ThinkingLevel != nil {
		if !thinkingLevels[*p.ThinkingLevel] {
			return s, bad("invalid thinking level")
		}
		s.ThinkingLevel = *p.ThinkingLevel
	}
	if s.GraderModel == "" || s.GeneratorModel == "" || s.CoachModel == "" {
		return s, bad("model ids cannot be empty")
	}
	if p.APIKey != nil {
		if err := c.SetAPIKey(ctx, *p.APIKey); err != nil {
			return s, err
		}
	}
	raw, _ := json.Marshal(s)
	_, err = c.store.pool.Exec(ctx, `INSERT INTO settings (key, value) VALUES ('config', $1::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, string(raw))
	return s, err
}
