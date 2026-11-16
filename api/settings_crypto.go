package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Adapted from standup-buddy: the Anthropic API key is stored AES-256-GCM encrypted, keyed by APP_SECRET.

func (c *Config) encrypt(plain string) (string, error) {
	block, err := aes.NewCipher(c.secret[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (c *Config) decrypt(enc string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(c.secret[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	return string(plain), err
}

// APIKey returns the stored key, else the ANTHROPIC_API_KEY environment value.
func (c *Config) APIKey(ctx context.Context) (key string, source string) {
	var enc string
	err := c.store.pool.QueryRow(ctx, `SELECT value #>> '{}' FROM settings WHERE key = 'anthropic_api_key'`).Scan(&enc)
	if err == nil {
		if k, derr := c.decrypt(enc); derr == nil && k != "" {
			return k, "stored"
		}
	}
	if c.envKey != "" {
		return c.envKey, "env"
	}
	return "", "none"
}

func (c *Config) SetAPIKey(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		_, err := c.store.pool.Exec(ctx, `DELETE FROM settings WHERE key = 'anthropic_api_key'`)
		return err
	}
	enc, err := c.encrypt(key)
	if err != nil {
		return err
	}
	encJSON, _ := json.Marshal(enc)
	_, err = c.store.pool.Exec(ctx, `INSERT INTO settings (key, value) VALUES ('anthropic_api_key', $1::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, string(encJSON))
	return err
}

func (c *Config) View(ctx context.Context) (SettingsView, error) {
	s, err := c.Get(ctx)
	if err != nil {
		return SettingsView{}, err
	}
	key, source := c.APIKey(ctx)
	v := SettingsView{Settings: s, APIKeySource: source}
	if key != "" {
		hint := key
		if len(key) > 11 {
			hint = key[:7] + "…" + key[len(key)-4:]
		}
		v.APIKeyHint = &hint
	}
	return v, nil
}

func (c *Config) Agent(ctx context.Context) (AgentConfig, error) {
	s, err := c.Get(ctx)
	if err != nil {
		return AgentConfig{}, err
	}
	key, _ := c.APIKey(ctx)
	return AgentConfig{Settings: s, APIKey: key}, nil
}

// TestKey makes a tiny Anthropic Messages request to prove the key and model work.
func (c *Config) TestKey(ctx context.Context) (string, error) {
	key, _ := c.APIKey(ctx)
	if key == "" {
		return "", bad("no Anthropic API key configured")
	}
	s, err := c.Get(ctx)
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(os.Getenv("ANTHROPIC_BASE_URL"), "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	body, _ := json.Marshal(map[string]any{
		"model":      s.GraderModel,
		"max_tokens": 16,
		"messages":   []map[string]string{{"role": "user", "content": "Reply with the single word: ready"}},
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/messages", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := e.Error.Message
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return "", fmt.Errorf("Anthropic returned %d: %s", res.StatusCode, msg)
	}
	var ok struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(raw, &ok)
	if len(ok.Content) > 0 {
		return strings.TrimSpace(ok.Content[0].Text), nil
	}
	return "ok", nil
}
