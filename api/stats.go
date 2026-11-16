package main

import (
	"context"
	"math"
	"slices"
	"sort"
	"time"
)

// attempt is one graded answer joined with its question, the raw material for every statistic.
type attempt struct {
	QuestionID string
	Title      string
	Domain     string
	Skill      string
	Type       string
	Difficulty int
	Language   *string
	Concepts   []string
	Score      float64
	Potential  float64
	Confidence *int
	At         time.Time
	TimeMs     int64
	Skipped    bool
	RegimentID string
}

func (s *Server) loadAttempts(ctx context.Context, where string, args ...any) ([]attempt, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.id, q.title, q.domain, q.skill, q.type, q.difficulty, q.language, q.concepts,
		       si.score, COALESCE(si.potential, si.score), si.confidence, si.submitted_at, si.time_spent_ms, si.skipped,
		       se.regiment_id::text
		FROM session_items si
		JOIN questions q ON q.id = si.question_id
		JOIN sessions se ON se.id = si.session_id
		WHERE si.score IS NOT NULL AND si.submitted_at IS NOT NULL `+where+`
		ORDER BY si.submitted_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []attempt
	for rows.Next() {
		var a attempt
		var score, pot float32
		if err := rows.Scan(&a.QuestionID, &a.Title, &a.Domain, &a.Skill, &a.Type, &a.Difficulty, &a.Language, &a.Concepts,
			&score, &pot, &a.Confidence, &a.At, &a.TimeMs, &a.Skipped, &a.RegimentID); err != nil {
			return nil, err
		}
		a.Score, a.Potential = float64(score), float64(pot)
		out = append(out, a)
	}
	return out, rows.Err()
}

type Mastery struct {
	Key       string  `json:"key"`
	Name      string  `json:"name"`
	Short     string  `json:"short"`
	Mastery   float64 `json:"mastery"`   // 0-1, difficulty weighted and shrunk toward 0.5 with few answers
	Potential float64 `json:"potential"` // 0-1, same treatment over potential
	Accuracy  float64 `json:"accuracy"`  // raw mean score
	Count     int     `json:"count"`
	Recent    int     `json:"recent"` // answers in the last 30 days
	Trend     float64 `json:"trend"`  // recent mean minus older mean (0 when either side is empty)
	Focal     bool    `json:"focal"`
	Primary   bool    `json:"primary"`
}

const (
	priorWeight = 2.0  // pseudo-answers at the prior
	priorValue  = 0.5  // what we assume before evidence
	halfLife    = 45.0 // days
)

func attemptWeight(a attempt, now time.Time) float64 {
	days := now.Sub(a.At).Hours() / 24
	recency := math.Pow(0.5, days/halfLife)
	return recency * (0.6 + 0.2*float64(a.Difficulty))
}

// masteryOf is the shared aggregation: weighted mean shrunk toward the prior.
func masteryOf(list []attempt, now time.Time) (mastery, potential, accuracy float64) {
	var w, ws, wp, raw float64
	for _, a := range list {
		aw := attemptWeight(a, now)
		w += aw
		ws += aw * a.Score
		wp += aw * a.Potential
		raw += a.Score
	}
	mastery = (ws + priorWeight*priorValue) / (w + priorWeight)
	potential = (wp + priorWeight*priorValue) / (w + priorWeight)
	if len(list) > 0 {
		accuracy = raw / float64(len(list))
	}
	if len(list) == 0 {
		mastery, potential = 0, 0
	}
	return
}

func (s *Server) domainMastery(atts []attempt, p Profile, now time.Time) []Mastery {
	by := map[string][]attempt{}
	for _, a := range atts {
		by[a.Domain] = append(by[a.Domain], a)
	}
	out := make([]Mastery, 0, len(s.tax.Domains))
	for _, d := range s.tax.Domains {
		list := by[d.Key]
		m := Mastery{Key: d.Key, Name: d.Name, Short: d.Short, Count: len(list),
			Focal: slices.Contains(p.FocalDomains, d.Key), Primary: p.PrimaryFocus == d.Key}
		m.Mastery, m.Potential, m.Accuracy = masteryOf(list, now)
		var recentSum, olderSum float64
		var older int
		for _, a := range list {
			if now.Sub(a.At) < 30*24*time.Hour {
				m.Recent++
				recentSum += a.Score
			} else {
				older++
				olderSum += a.Score
			}
		}
		if m.Recent > 0 && older > 0 {
			m.Trend = recentSum/float64(m.Recent) - olderSum/float64(older)
		}
		out = append(out, m)
	}
	return out
}

type ConceptStat struct {
	Domain   string  `json:"domain"`
	Concept  string  `json:"concept"`
	Accuracy float64 `json:"accuracy"`
	Count    int     `json:"count"`
}

func weakConcepts(atts []attempt, limit int) []ConceptStat {
	type acc struct {
		domain string
		sum    float64
		n      int
	}
	m := map[string]*acc{}
	for _, a := range atts {
		for _, c := range a.Concepts {
			k := a.Domain + "/" + c
			if m[k] == nil {
				m[k] = &acc{domain: a.Domain}
			}
			m[k].sum += a.Score
			m[k].n++
		}
	}
	var out []ConceptStat
	for k, v := range m {
		avg := v.sum / float64(v.n)
		if avg < 0.7 {
			out = append(out, ConceptStat{Domain: v.domain, Concept: k[len(v.domain)+1:], Accuracy: avg, Count: v.n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Accuracy != out[j].Accuracy {
			return out[i].Accuracy < out[j].Accuracy
		}
		return out[i].Count > out[j].Count
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

type Breakdown struct {
	Key       string  `json:"key"`
	Name      string  `json:"name"`
	Accuracy  float64 `json:"accuracy"`
	Potential float64 `json:"potential"`
	Count     int     `json:"count"`
}

func breakdown(atts []attempt, key func(attempt) string, name func(string) string) []Breakdown {
	type acc struct {
		s, p float64
		n    int
	}
	m := map[string]*acc{}
	var order []string
	for _, a := range atts {
		k := key(a)
		if k == "" {
			continue
		}
		if m[k] == nil {
			m[k] = &acc{}
			order = append(order, k)
		}
		m[k].s += a.Score
		m[k].p += a.Potential
		m[k].n++
	}
	out := make([]Breakdown, 0, len(order))
	for _, k := range order {
		v := m[k]
		out = append(out, Breakdown{Key: k, Name: name(k), Accuracy: v.s / float64(v.n), Potential: v.p / float64(v.n), Count: v.n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Accuracy < out[j].Accuracy })
	return out
}

func (s *Server) nameOf(list []KeyName) func(string) string {
	return func(k string) string {
		for _, x := range list {
			if x.Key == k {
				return x.Name
			}
		}
		return k
	}
}

type ProfileStats struct {
	Domains      []Mastery     `json:"domains"`
	Skills       []Breakdown   `json:"skills"`
	Types        []Breakdown   `json:"types"`
	Languages    []Breakdown   `json:"languages"`
	WeakConcepts []ConceptStat `json:"weakConcepts"`
	Answered     int           `json:"answered"`
	Accuracy     float64       `json:"accuracy"`
	Potential    float64       `json:"potential"`
	BlindSpots   int           `json:"blindSpots"`
	Minutes      int           `json:"minutes"`
	StreakDays   int           `json:"streakDays"`
	ActiveDays   []string      `json:"activeDays"` // YYYY-MM-DD with at least one answer, last 120 days
	Regiments    int           `json:"regiments"`
	Calibration  *float64      `json:"calibration"` // 0-1, how well confidence predicts correctness
}

func isBlindSpot(a attempt) bool {
	return a.Confidence != nil && *a.Confidence >= 3 && a.Score < 0.4 && !a.Skipped
}

func (s *Server) profileStats(ctx context.Context) (ProfileStats, error) {
	p, err := s.getProfile(ctx)
	if err != nil {
		return ProfileStats{}, err
	}
	atts, err := s.loadAttempts(ctx, "")
	if err != nil {
		return ProfileStats{}, err
	}
	now := time.Now()
	st := ProfileStats{
		Domains:      s.domainMastery(atts, p, now),
		Skills:       breakdown(atts, func(a attempt) string { return a.Skill }, s.nameOf(s.tax.Skills)),
		Types:        breakdown(atts, func(a attempt) string { return a.Type }, s.nameOf(s.tax.Types)),
		Languages:    breakdown(atts, func(a attempt) string { return deref(a.Language) }, s.nameOf(s.tax.Languages)),
		WeakConcepts: weakConcepts(atts, 8),
		Answered:     len(atts),
	}
	days := map[string]bool{}
	var conf, confHit float64
	for _, a := range atts {
		st.Accuracy += a.Score
		st.Potential += a.Potential
		st.Minutes += int(a.TimeMs / 60000)
		if isBlindSpot(a) {
			st.BlindSpots++
		}
		if a.Confidence != nil && !a.Skipped {
			conf++
			// confidence 1-3 predicts p(correct) of .33/.66/.9; reward predictions close to the outcome
			pred := []float64{0, 0.33, 0.66, 0.9}[max(1, min(3, *a.Confidence))]
			confHit += 1 - math.Abs(pred-a.Score)
		}
		if now.Sub(a.At) < 120*24*time.Hour {
			days[a.At.Format("2006-01-02")] = true
		}
	}
	if len(atts) > 0 {
		st.Accuracy /= float64(len(atts))
		st.Potential /= float64(len(atts))
	}
	if conf >= 3 {
		c := confHit / conf
		st.Calibration = &c
	}
	for d := range days {
		st.ActiveDays = append(st.ActiveDays, d)
	}
	sort.Strings(st.ActiveDays)
	// A streak survives until the end of today: count back from today, or from yesterday if today is empty.
	d := now
	if !days[d.Format("2006-01-02")] {
		d = d.AddDate(0, 0, -1)
	}
	for days[d.Format("2006-01-02")] {
		st.StreakDays++
		d = d.AddDate(0, 0, -1)
	}
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM regiments WHERE status = 'completed'`).Scan(&st.Regiments)
	return st, nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
