package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The Insights page: everything here is derived from the answer ledger (session_items) plus the saved
// coach summaries and regiment debriefs, so it needs no new tables.

type WeekPoint struct {
	Week       string   `json:"week"` // Monday, YYYY-MM-DD
	Answered   int      `json:"answered"`
	Accuracy   *float64 `json:"accuracy"`
	Potential  *float64 `json:"potential"`
	Minutes    int      `json:"minutes"`
	BlindSpots int      `json:"blindSpots"`
}

type DomainTrack struct {
	Key     string     `json:"key"`
	Name    string     `json:"name"`
	Mastery []*float64 `json:"mastery"` // aligned to History.Weeks; null before the first answer
	Now     float64    `json:"now"`
	Change  *float64   `json:"change"` // vs 30 days ago, when both exist
	Count   int        `json:"count"`
}

type DebriefEntry struct {
	RegimentID  string   `json:"regimentId"`
	Name        string   `json:"name"`
	CompletedAt string   `json:"completedAt"`
	Accuracy    *float64 `json:"accuracy"`
	Potential   *float64 `json:"potential"`
	Headline    string   `json:"headline"`
	Direction   string   `json:"direction"`
	Source      string   `json:"source"` // llm | rules
}

type RecurringMiss struct {
	QuestionID string  `json:"questionId"`
	Title      string  `json:"title"`
	Domain     string  `json:"domain"`
	Attempts   int     `json:"attempts"`
	Average    float64 `json:"average"`
	Last       float64 `json:"last"`
}

type History struct {
	Weeks     []WeekPoint     `json:"weeks"`
	Domains   []DomainTrack   `json:"domains"`
	Insights  []Insight       `json:"insights"`
	Debriefs  []DebriefEntry  `json:"debriefs"`
	Recurring []RecurringMiss `json:"recurring"`
	Answered  int             `json:"answered"`
	FirstAt   *string         `json:"firstAt"`
}

func weekStart(t time.Time) time.Time {
	t = t.Local()
	d := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	offset := (int(d.Weekday()) + 6) % 7 // Monday = 0
	return d.AddDate(0, 0, -offset)
}

const maxWeeks = 52

func (s *Server) history(ctx context.Context) (*History, error) {
	atts, err := s.loadAttempts(ctx, "")
	if err != nil {
		return nil, err
	}
	h := &History{Weeks: []WeekPoint{}, Domains: []DomainTrack{}, Insights: []Insight{}, Debriefs: []DebriefEntry{}, Recurring: []RecurringMiss{}, Answered: len(atts)}
	now := time.Now()

	// ---- weekly series, contiguous from the first answer (capped at a year)
	var weeks []time.Time
	if len(atts) > 0 {
		first := atts[0].At.Format(time.RFC3339)
		h.FirstAt = &first
		start := weekStart(atts[0].At)
		if earliest := weekStart(now).AddDate(0, 0, -7*(maxWeeks-1)); start.Before(earliest) {
			start = earliest
		}
		for w := start; !w.After(now); w = w.AddDate(0, 0, 7) {
			weeks = append(weeks, w)
		}
	}
	index := map[string]int{}
	for i, w := range weeks {
		key := w.Format("2006-01-02")
		index[key] = i
		h.Weeks = append(h.Weeks, WeekPoint{Week: key})
	}
	sums := make([][2]float64, len(weeks))
	for _, a := range atts {
		i, ok := index[weekStart(a.At).Format("2006-01-02")]
		if !ok {
			continue
		}
		wp := &h.Weeks[i]
		wp.Answered++
		wp.Minutes += int(a.TimeMs / 60000)
		if isBlindSpot(a) {
			wp.BlindSpots++
		}
		sums[i][0] += a.Score
		sums[i][1] += a.Potential
	}
	for i := range h.Weeks {
		if n := h.Weeks[i].Answered; n > 0 {
			acc, pot := sums[i][0]/float64(n), sums[i][1]/float64(n)
			h.Weeks[i].Accuracy, h.Weeks[i].Potential = &acc, &pot
		}
	}

	// ---- per-domain mastery as it stood at the end of each week
	byDomain := map[string][]attempt{}
	for _, a := range atts {
		byDomain[a.Domain] = append(byDomain[a.Domain], a)
	}
	monthAgo := now.AddDate(0, 0, -30)
	for _, d := range s.tax.Domains {
		list := byDomain[d.Key]
		tr := DomainTrack{Key: d.Key, Name: d.Name, Mastery: make([]*float64, len(weeks)), Count: len(list)}
		for i, w := range weeks {
			end := w.AddDate(0, 0, 7)
			if end.After(now) {
				end = now
			}
			var upTo []attempt
			for _, a := range list {
				if a.At.Before(end) {
					upTo = append(upTo, a)
				}
			}
			if len(upTo) > 0 {
				m, _, _ := masteryOf(upTo, end)
				tr.Mastery[i] = &m
			}
		}
		if len(list) > 0 {
			tr.Now, _, _ = masteryOf(list, now)
			var before []attempt
			for _, a := range list {
				if a.At.Before(monthAgo) {
					before = append(before, a)
				}
			}
			if len(before) > 0 {
				then, _, _ := masteryOf(before, monthAgo)
				c := tr.Now - then
				tr.Change = &c
			}
		}
		h.Domains = append(h.Domains, tr)
	}

	// ---- recurring misses: questions seen twice or more that keep scoring low
	type acc struct {
		title, domain string
		scores        []float64
	}
	seen := map[string]*acc{}
	var order []string
	for _, a := range atts {
		if seen[a.QuestionID] == nil {
			seen[a.QuestionID] = &acc{title: a.Title, domain: a.Domain}
			order = append(order, a.QuestionID)
		}
		seen[a.QuestionID].scores = append(seen[a.QuestionID].scores, a.Score)
	}
	for _, id := range order {
		v := seen[id]
		if len(v.scores) < 2 {
			continue
		}
		var sum float64
		for _, x := range v.scores {
			sum += x
		}
		avg := sum / float64(len(v.scores))
		if avg < 0.6 {
			h.Recurring = append(h.Recurring, RecurringMiss{QuestionID: id, Title: v.title, Domain: v.domain,
				Attempts: len(v.scores), Average: avg, Last: v.scores[len(v.scores)-1]})
		}
	}
	sort.Slice(h.Recurring, func(i, j int) bool { return h.Recurring[i].Average < h.Recurring[j].Average })
	if len(h.Recurring) > 12 {
		h.Recurring = h.Recurring[:12]
	}

	// ---- saved coach summaries, newest first
	rows, err := s.pool.Query(ctx, `SELECT body FROM insights ORDER BY created_at DESC LIMIT 40`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var raw []byte
		var in Insight
		if rows.Scan(&raw) == nil && json.Unmarshal(raw, &in) == nil {
			h.Insights = append(h.Insights, in)
		}
	}
	rows.Close()

	// ---- regiment debriefs: the model's when it wrote one, else the rules
	rows, err = s.pool.Query(ctx, `
		SELECT id::text, name, to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       (report->>'accuracy')::float8, (report->>'potential')::float8,
		       COALESCE(CASE WHEN debrief_status = 'ready' THEN debrief->>'headline' END, report->'recommendation'->>'headline', ''),
		       COALESCE(CASE WHEN debrief_status = 'ready' THEN debrief->>'direction' END, report->'recommendation'->>'direction', ''),
		       CASE WHEN debrief_status = 'ready' THEN 'llm' ELSE 'rules' END
		FROM regiments WHERE status = 'completed' AND completed_at IS NOT NULL
		ORDER BY completed_at DESC LIMIT 40`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d DebriefEntry
		if err := rows.Scan(&d.RegimentID, &d.Name, &d.CompletedAt, &d.Accuracy, &d.Potential, &d.Headline, &d.Direction, &d.Source); err == nil {
			h.Debriefs = append(h.Debriefs, d)
		}
	}
	rows.Close()
	return h, rows.Err()
}

// ---------------------------------------------------------------- ledger

type LedgerRow struct {
	ItemID       string   `json:"itemId"`
	SessionID    string   `json:"sessionId"`
	RegimentID   string   `json:"regimentId"`
	RegimentName string   `json:"regimentName"`
	DayIndex     int      `json:"dayIndex"`
	QuestionID   string   `json:"questionId"`
	Title        string   `json:"title"`
	Domain       string   `json:"domain"`
	Type         string   `json:"type"`
	Difficulty   int      `json:"difficulty"`
	Score        float64  `json:"score"`
	Potential    *float64 `json:"potential"`
	Confidence   *int     `json:"confidence"`
	GradedBy     *string  `json:"gradedBy"`
	Skipped      bool     `json:"skipped"`
	TimeMs       int64    `json:"timeMs"`
	At           string   `json:"at"`
}

var ledgerResults = map[string]string{
	"correct": "si.score >= 0.7 AND NOT si.skipped",
	"partial": "si.score >= 0.4 AND si.score < 0.7 AND NOT si.skipped",
	"missed":  "si.score < 0.4 AND NOT si.skipped",
	"skipped": "si.skipped",
	"blind":   "si.score < 0.4 AND si.confidence = 3 AND NOT si.skipped",
}

// ledger lists every graded answer, newest first. Filters: domain, type, result, q (title search).
func (s *Server) ledger(r *http.Request) (any, error) {
	qv := r.URL.Query()
	where := []string{"si.submitted_at IS NOT NULL", "si.score IS NOT NULL"}
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if d := qv.Get("domain"); d != "" {
		where = append(where, "q.domain = "+arg(d))
	}
	if t := qv.Get("type"); t != "" {
		where = append(where, "q.type = "+arg(t))
	}
	if res := qv.Get("result"); res != "" {
		cond, ok := ledgerResults[res]
		if !ok {
			return nil, bad("result must be correct, partial, missed, skipped or blind")
		}
		where = append(where, cond)
	}
	if text := strings.TrimSpace(qv.Get("q")); text != "" {
		where = append(where, "q.title ILIKE '%' || "+arg(text)+" || '%'")
	}
	limit, _ := strconv.Atoi(qv.Get("limit"))
	limit = max(1, min(200, limit))
	if qv.Get("limit") == "" {
		limit = 50
	}
	offset, _ := strconv.Atoi(qv.Get("offset"))
	offset = max(0, offset)

	from := ` FROM session_items si JOIN questions q ON q.id = si.question_id
		JOIN sessions se ON se.id = si.session_id JOIN regiments rg ON rg.id = se.regiment_id
		WHERE ` + strings.Join(where, " AND ")
	var total int
	if err := s.pool.QueryRow(r.Context(), `SELECT count(*)`+from, args...).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT si.id::text, se.id::text, rg.id::text, rg.name, se.day_index, q.id, q.title, q.domain, q.type, q.difficulty,
		       si.score, si.potential, si.confidence, si.graded_by, si.skipped, si.time_spent_ms,
		       to_char(si.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`+from+`
		ORDER BY si.submitted_at DESC LIMIT `+strconv.Itoa(limit)+` OFFSET `+strconv.Itoa(offset), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LedgerRow{}
	for rows.Next() {
		var lr LedgerRow
		var score float32
		var pot *float32
		if err := rows.Scan(&lr.ItemID, &lr.SessionID, &lr.RegimentID, &lr.RegimentName, &lr.DayIndex, &lr.QuestionID, &lr.Title,
			&lr.Domain, &lr.Type, &lr.Difficulty, &score, &pot, &lr.Confidence, &lr.GradedBy, &lr.Skipped, &lr.TimeMs, &lr.At); err != nil {
			return nil, err
		}
		lr.Score = float64(score)
		if pot != nil {
			v := float64(*pot)
			lr.Potential = &v
		}
		out = append(out, lr)
	}
	return map[string]any{"rows": out, "total": total, "limit": limit, "offset": offset}, rows.Err()
}
