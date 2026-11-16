package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
)

// Preferences are display choices (theme and code color scheme). They live in Postgres so they follow
// the user across browsers; the web app mirrors them in localStorage only to avoid a flash on load.
type Preferences struct {
	Theme     string `json:"theme"`     // system | light | dark
	CodeTheme string `json:"codeTheme"` // one of codeThemes
}

var (
	themes     = []string{"system", "light", "dark"}
	codeThemes = []string{"staff", "github-light", "github-dark", "one-dark", "dracula", "monokai", "solarized-light", "solarized-dark", "nord", "tokyo-night", "catppuccin-mocha", "shades-of-purple"}
)

func defaultPreferences() Preferences { return Preferences{Theme: "dark", CodeTheme: "staff"} }

func (s *Server) getPreferences(ctx context.Context) (Preferences, error) {
	p := defaultPreferences()
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT value FROM settings WHERE key = 'ui'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	_ = json.Unmarshal(raw, &p)
	if !slices.Contains(themes, p.Theme) {
		p.Theme = "dark"
	}
	if !slices.Contains(codeThemes, p.CodeTheme) {
		p.CodeTheme = "staff"
	}
	return p, nil
}

func (s *Server) putPreferences(ctx context.Context, patch Preferences) (Preferences, error) {
	p, err := s.getPreferences(ctx)
	if err != nil {
		return p, err
	}
	if patch.Theme != "" {
		if !slices.Contains(themes, patch.Theme) {
			return p, bad("theme must be system, light or dark")
		}
		p.Theme = patch.Theme
	}
	if patch.CodeTheme != "" {
		if !slices.Contains(codeThemes, patch.CodeTheme) {
			return p, bad("unknown code theme")
		}
		p.CodeTheme = patch.CodeTheme
	}
	raw, _ := json.Marshal(p)
	_, err = s.pool.Exec(ctx, `INSERT INTO settings (key, value) VALUES ('ui', $1::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, string(raw))
	return p, err
}
