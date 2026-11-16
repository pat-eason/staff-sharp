package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) loadQuestion(ctx context.Context, db dbtx, id string) (*Question, error) {
	var raw []byte
	err := db.QueryRow(ctx, `SELECT body FROM questions WHERE id = $1`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	var q Question
	if err := json.Unmarshal(raw, &q); err != nil {
		return nil, err
	}
	return &q, nil
}

// normalizeConfig fills defaults and clamps every field so a hand-crafted request cannot break selection.
func (s *Server) normalizeConfig(c RegimentConfig) (RegimentConfig, error) {
	domains := []string{}
	for _, d := range c.Domains {
		if s.tax.hasDomain(d) && !slices.Contains(domains, d) {
			domains = append(domains, d)
		}
	}
	c.Domains = domains
	types := []string{}
	for _, t := range c.Types {
		if s.tax.hasKey(s.tax.Types, t) && !slices.Contains(types, t) {
			types = append(types, t)
		}
	}
	c.Types = types
	if c.DifficultyMin == 0 {
		c.DifficultyMin = 1
	}
	if c.DifficultyMax == 0 {
		c.DifficultyMax = 5
	}
	c.DifficultyMin = max(1, min(5, c.DifficultyMin))
	c.DifficultyMax = max(c.DifficultyMin, min(5, c.DifficultyMax))
	c.Days = max(1, min(30, c.Days))
	c.PerDay = max(1, min(40, c.PerDay))
	c.GeneratedPerDay = max(0, min(c.PerDay, c.GeneratedPerDay))
	c.TimeLimitMinutes = max(0, min(600, c.TimeLimitMinutes))
	if c.Feedback != "immediate" && c.Feedback != "end" {
		c.Feedback = "end"
		if !c.Timed {
			c.Feedback = "immediate"
		}
	}
	if c.QuestionIDs == nil {
		c.QuestionIDs = []string{}
	}
	if c.FocusConcepts == nil {
		c.FocusConcepts = []string{}
	}
	if len(c.QuestionIDs) > 40 {
		return c, bad("too many pinned questions")
	}
	if len(c.QuestionIDs) > 0 {
		c.PerDay = max(c.PerDay, len(c.QuestionIDs))
	}
	for k, w := range c.DomainWeights {
		if !s.tax.hasDomain(k) || w <= 0 || w > 10 {
			delete(c.DomainWeights, k)
		}
	}
	return c, nil
}

// suggested normalizes a config the API proposes (rules recommendation, "tuned for me") so the UI always
// receives complete lists rather than nulls.
func (s *Server) suggested(c RegimentConfig) RegimentConfig {
	if n, err := s.normalizeConfig(c); err == nil {
		return n
	}
	return c
}

type createRegimentReq struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Config      RegimentConfig `json:"config"`
}

func (s *Server) createRegiment(ctx context.Context, req createRegimentReq) (*Regiment, error) {
	cfg, err := s.normalizeConfig(req.Config)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Regiment " + time.Now().Format("Jan 2")
	}
	if len(name) > 120 || len(req.Description) > 2000 {
		return nil, bad("name or description is too long")
	}
	// Make sure the filters can actually fill a day before creating anything.
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	if len(cfg.QuestionIDs) == 0 {
		cands, err := s.candidates(ctx, cfg, p)
		if err != nil {
			return nil, err
		}
		if len(cands) == 0 {
			return nil, bad("no questions match these filters; widen the domains, types or difficulty")
		}
	}
	cfgJSON, _ := json.Marshal(cfg)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO regiments (name, description, config) VALUES ($1, $2, $3::jsonb) RETURNING id::text`,
		name, req.Description, string(cfgJSON)).Scan(&id); err != nil {
		return nil, err
	}
	for day := 1; day <= cfg.Days; day++ {
		if _, err := tx.Exec(ctx, `INSERT INTO sessions (regiment_id, day_index, scheduled_for) VALUES ($1::uuid, $2, current_date + $3::int)`,
			id, day, day-1); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getRegiment(ctx, id)
}

const regimentCols = `r.id::text, r.name, r.description, r.config, r.status, r.report, r.debrief, r.debrief_status, r.debrief_error,
	to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func scanRegiment(row pgx.Row) (*Regiment, error) {
	var r Regiment
	var cfg []byte
	var report, debrief []byte
	if err := row.Scan(&r.ID, &r.Name, &r.Description, &cfg, &r.Status, &report, &debrief, &r.DebriefStatus, &r.DebriefError,
		&r.CreatedAt, &r.CompletedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(cfg, &r.Config)
	r.Report, r.Debrief = report, debrief
	return &r, nil
}

func (s *Server) sessionSummaries(ctx context.Context, regimentID string) ([]SessionSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT se.id::text, se.day_index, to_char(se.scheduled_for, 'YYYY-MM-DD'), se.status, se.time_limit_seconds,
		       se.elapsed_ms + COALESCE((extract(epoch FROM now() - se.running_since) * 1000)::bigint, 0),
		       count(si.id), count(si.submitted_at) FILTER (WHERE NOT si.skipped), avg(si.score) FILTER (WHERE si.submitted_at IS NOT NULL),
		       to_char(se.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       to_char(se.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM sessions se LEFT JOIN session_items si ON si.session_id = se.id
		WHERE se.regiment_id = $1::uuid GROUP BY se.id ORDER BY se.day_index`, regimentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionSummary{}
	for rows.Next() {
		var ss SessionSummary
		if err := rows.Scan(&ss.ID, &ss.DayIndex, &ss.ScheduledFor, &ss.Status, &ss.TimeLimitSeconds, &ss.ElapsedMs,
			&ss.ItemCount, &ss.Answered, &ss.Accuracy, &ss.StartedAt, &ss.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, ss)
	}
	return out, rows.Err()
}

func (s *Server) decorate(ctx context.Context, r *Regiment) error {
	ss, err := s.sessionSummaries(ctx, r.ID)
	if err != nil {
		return err
	}
	r.Sessions = ss
	var sum float64
	var n int
	for _, x := range ss {
		if x.Status == "completed" {
			r.DaysCompleted++
		}
		if x.Accuracy != nil {
			sum += *x.Accuracy
			n++
		}
	}
	if n > 0 {
		a := sum / float64(n)
		r.Accuracy = &a
	}
	var rep struct {
		Potential float64 `json:"potential"`
	}
	if len(r.Report) > 0 && json.Unmarshal(r.Report, &rep) == nil {
		r.Potential = &rep.Potential
	}
	return nil
}

func (s *Server) getRegiment(ctx context.Context, id string) (*Regiment, error) {
	r, err := scanRegiment(s.pool.QueryRow(ctx, `SELECT `+regimentCols+` FROM regiments r WHERE r.id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return r, s.decorate(ctx, r)
}

func (s *Server) listRegiments(ctx context.Context) ([]*Regiment, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+regimentCols+` FROM regiments r ORDER BY r.status = 'completed', r.created_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	var out []*Regiment
	for rows.Next() {
		r, err := scanRegiment(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		r.Report = nil // the list stays light
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, r := range out {
		if err := s.decorate(ctx, r); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Server) deleteRegiment(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM regiments WHERE id = $1::uuid`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// previewConfig tells the builder how many questions match and roughly how long a day takes.
func (s *Server) previewConfig(ctx context.Context, cfg RegimentConfig) (map[string]any, error) {
	cfg, err := s.normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	cands, err := s.candidates(ctx, cfg, p)
	if err != nil {
		return nil, err
	}
	byDomain := map[string]int{}
	byType := map[string]int{}
	var est float64
	for _, c := range cands {
		byDomain[c.Domain]++
		byType[c.Type]++
		est += float64(c.Est)
	}
	avg := 180.0
	if len(cands) > 0 {
		avg = est / float64(len(cands))
	}
	bank := cfg.PerDay - cfg.GeneratedPerDay
	minutes := (avg*float64(bank) + 300*float64(cfg.GeneratedPerDay)) / 60
	if cfg.Timed && cfg.TimeLimitMinutes > 0 {
		minutes = float64(cfg.TimeLimitMinutes)
	}
	return map[string]any{
		"matching":         len(cands),
		"byDomain":         byDomain,
		"byType":           byType,
		"minutesPerDay":    int(minutes + 0.5),
		"totalQuestions":   cfg.PerDay * cfg.Days,
		"enoughForAllDays": len(cands) >= bank*cfg.Days,
		"llm":              s.llmActive(ctx),
	}, nil
}
