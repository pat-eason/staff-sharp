package main

import (
	"context"
	"math"
	"math/rand/v2"
	"slices"
	"sort"
	"time"
)

type candidate struct {
	ID         string
	Domain     string
	Type       string
	Skill      string
	Difficulty int
	Language   *string
	Concepts   []string
	Est        int
	weight     float64
	key        float64
}

type seenStat struct {
	last      time.Time
	count     int
	lastScore float64
}

// pool loads the questions that match a regiment's filters.
func (s *Server) candidates(ctx context.Context, cfg RegimentConfig, p Profile) ([]candidate, error) {
	langs := append([]string{p.PrimaryLanguage}, p.ExtraLanguages...)
	rows, err := s.pool.Query(ctx, `
		SELECT id, domain, type, skill, difficulty, language, concepts, est_seconds FROM questions
		WHERE active AND source = 'bank'
		  AND (cardinality($1::text[]) = 0 OR domain = ANY($1))
		  AND (cardinality($2::text[]) = 0 OR type = ANY($2))
		  AND difficulty BETWEEN $3 AND $4
		  AND (language IS NULL OR language = ANY($5))`,
		nonNil(cfg.Domains), nonNil(cfg.Types), cfg.DifficultyMin, cfg.DifficultyMax, langs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.ID, &c.Domain, &c.Type, &c.Skill, &c.Difficulty, &c.Language, &c.Concepts, &c.Est); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func (s *Server) seenStats(ctx context.Context) (map[string]seenStat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT question_id, max(submitted_at), count(*), (array_agg(score ORDER BY submitted_at DESC))[1]
		FROM session_items WHERE submitted_at IS NOT NULL AND question_id IS NOT NULL AND score IS NOT NULL
		GROUP BY question_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]seenStat{}
	for rows.Next() {
		var id string
		var st seenStat
		var score float32
		if err := rows.Scan(&id, &st.last, &st.count, &score); err != nil {
			return nil, err
		}
		st.lastScore = float64(score)
		out[id] = st
	}
	return out, rows.Err()
}

// selectQuestions picks n questions with weighted sampling without replacement (Efraimidis–Spirakis).
// Weights favour the profile's focal points and primary focus, weak domains (when adaptive), questions
// not seen yet, and questions answered badly a while ago (spaced repetition). Soft caps keep a mix of
// domains and types, and a time budget keeps a timed day finishable.
func (s *Server) selectQuestions(ctx context.Context, cfg RegimentConfig, p Profile, n int, exclude map[string]bool) ([]candidate, error) {
	cands, err := s.candidates(ctx, cfg, p)
	if err != nil {
		return nil, err
	}
	seen, err := s.seenStats(ctx)
	if err != nil {
		return nil, err
	}
	mastery := map[string]float64{}
	if cfg.Adaptive {
		atts, err := s.loadAttempts(ctx, "")
		if err != nil {
			return nil, err
		}
		for _, m := range s.domainMastery(atts, p, time.Now()) {
			if m.Count > 0 {
				mastery[m.Key] = m.Mastery
			}
		}
	}
	target := levels[p.Level]
	if target == 0 {
		target = 3
	}
	target = math.Max(float64(cfg.DifficultyMin), math.Min(float64(cfg.DifficultyMax), target))

	now := time.Now()
	pool := cands[:0]
	for _, c := range cands {
		if exclude[c.ID] {
			continue
		}
		w := 1.0
		if slices.Contains(p.FocalDomains, c.Domain) {
			w *= 1.6
		}
		if p.PrimaryFocus == c.Domain {
			w *= 2.0
		}
		if dw, ok := cfg.DomainWeights[c.Domain]; ok && dw > 0 {
			w *= dw
		}
		if cfg.Adaptive {
			m, ok := mastery[c.Domain]
			if !ok {
				m = 0.45 // unexplored domains are worth a look
			}
			w *= 1.6 - m
		}
		if c.Language != nil && *c.Language == p.PrimaryLanguage {
			w *= 1.4
		}
		for _, fc := range cfg.FocusConcepts {
			if slices.Contains(c.Concepts, fc) {
				w *= 2.5
				break
			}
		}
		d := float64(c.Difficulty) - target
		w *= math.Exp(-d * d / 2.5)
		if st, ok := seen[c.ID]; ok {
			ago := now.Sub(st.last)
			switch {
			case ago < 72*time.Hour:
				w *= 0.05
			case st.lastScore < 0.6:
				w *= 1.25 // missed before: bring it back
			default:
				w *= 0.3
			}
		} else {
			w *= 1.3
		}
		c.weight = w
		c.key = -math.Log(1-rand.Float64()) / w
		pool = append(pool, c)
	}
	sort.Slice(pool, func(i, j int) bool { return pool[i].key < pool[j].key })

	domains, types := map[string]bool{}, map[string]bool{}
	for _, c := range pool {
		domains[c.Domain], types[c.Type] = true, true
	}
	domainCap, typeCap := n, n
	if len(domains) > 1 {
		domainCap = max(1, int(math.Ceil(float64(n)*0.45)))
	}
	if len(types) > 1 {
		typeCap = max(1, int(math.Ceil(float64(n)*0.4)))
	}
	budget := math.Inf(1)
	if cfg.Timed && cfg.TimeLimitMinutes > 0 {
		budget = float64(cfg.TimeLimitMinutes*60) * 1.1
	}

	var picked []candidate
	taken := map[string]bool{}
	byDomain, byType := map[string]int{}, map[string]int{}
	spent := 0.0
	pass := func(strict bool) {
		for _, c := range pool {
			if len(picked) >= n {
				return
			}
			if taken[c.ID] {
				continue
			}
			if strict && (byDomain[c.Domain] >= domainCap || byType[c.Type] >= typeCap) {
				continue
			}
			// A timed day never outgrows its budget (the first question always fits).
			if len(picked) > 0 && spent+float64(c.Est) > budget {
				continue
			}
			picked = append(picked, c)
			taken[c.ID] = true
			byDomain[c.Domain]++
			byType[c.Type]++
			spent += float64(c.Est)
		}
	}
	pass(true)
	pass(false)
	// Shorter questions first so a session warms up before the long design prompts.
	sort.SliceStable(picked, func(i, j int) bool { return picked[i].Est < picked[j].Est })
	return picked, nil
}
