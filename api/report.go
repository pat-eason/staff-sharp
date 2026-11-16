package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"sort"
	"strings"
	"time"
)

type ItemRef struct {
	QuestionID string  `json:"questionId"`
	Title      string  `json:"title"`
	Domain     string  `json:"domain"`
	Score      float64 `json:"score"`
}

type FocusArea struct {
	Domain   string `json:"domain"`
	Concept  string `json:"concept,omitempty"`
	Why      string `json:"why"`
	Practice string `json:"practice"`
}

type NextRegiment struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Config      RegimentConfig `json:"config"`
}

type Recommendation struct {
	Headline   string        `json:"headline"`
	Direction  string        `json:"direction"`
	FocusAreas []FocusArea   `json:"focusAreas"`
	Strengths  []string      `json:"strengths"`
	Next       *NextRegiment `json:"next,omitempty"`
}

type Report struct {
	Accuracy       float64        `json:"accuracy"`
	Potential      float64        `json:"potential"`
	Band           string         `json:"band"`
	Answered       int            `json:"answered"`
	Skipped        int            `json:"skipped"`
	Total          int            `json:"total"`
	TimeMs         int64          `json:"timeMs"`
	EstMs          int64          `json:"estMs"`
	FocusLosses    int            `json:"focusLosses"`
	PendingGrades  int            `json:"pendingGrades"`
	ByDomain       []Breakdown    `json:"byDomain"`
	BySkill        []Breakdown    `json:"bySkill"`
	ByType         []Breakdown    `json:"byType"`
	ByDay          []Breakdown    `json:"byDay"`
	BlindSpots     []ItemRef      `json:"blindSpots"`
	Missed         []ItemRef      `json:"missed"`
	WeakConcepts   []ConceptStat  `json:"weakConcepts"`
	Recommendation Recommendation `json:"recommendation"`
	GeneratedAt    string         `json:"generatedAt"`
}

func band(acc float64) string {
	switch {
	case acc >= 0.85:
		return "Razor sharp"
	case acc >= 0.7:
		return "Sharp"
	case acc >= 0.55:
		return "Serviceable edge"
	case acc >= 0.4:
		return "Dulling"
	default:
		return "Needs the whetstone"
	}
}

func (s *Server) buildReport(ctx context.Context, regimentID string) (*Report, error) {
	atts, err := s.loadAttempts(ctx, `AND se.regiment_id = $1::uuid`, regimentID)
	if err != nil {
		return nil, err
	}
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	rep := &Report{GeneratedAt: time.Now().UTC().Format(time.RFC3339)}
	_ = s.pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE si.grade_status = 'pending')
		FROM session_items si JOIN sessions se ON se.id = si.session_id
		WHERE se.regiment_id = $1::uuid`, regimentID).Scan(&rep.Total, &rep.PendingGrades)
	_ = s.pool.QueryRow(ctx, `SELECT COALESCE(sum(focus_losses), 0), COALESCE(sum(elapsed_ms), 0) FROM sessions WHERE regiment_id = $1::uuid`,
		regimentID).Scan(&rep.FocusLosses, &rep.TimeMs)

	dayOf := map[string]int{}
	rows, err := s.pool.Query(ctx, `SELECT si.question_id, se.day_index, q.est_seconds FROM session_items si
		JOIN sessions se ON se.id = si.session_id JOIN questions q ON q.id = si.question_id WHERE se.regiment_id = $1::uuid`, regimentID)
	if err == nil {
		for rows.Next() {
			var qid string
			var day, est int
			if rows.Scan(&qid, &day, &est) == nil {
				dayOf[qid] = day
				rep.EstMs += int64(est) * 1000
			}
		}
		rows.Close()
	}

	for _, a := range atts {
		rep.Accuracy += a.Score
		rep.Potential += a.Potential
		if a.Skipped {
			rep.Skipped++
		} else {
			rep.Answered++
		}
		if isBlindSpot(a) {
			rep.BlindSpots = append(rep.BlindSpots, ItemRef{a.QuestionID, a.Title, a.Domain, a.Score})
		}
		if a.Score < 0.5 {
			rep.Missed = append(rep.Missed, ItemRef{a.QuestionID, a.Title, a.Domain, a.Score})
		}
	}
	if n := len(atts); n > 0 {
		rep.Accuracy /= float64(n)
		rep.Potential /= float64(n)
	}
	rep.Band = band(rep.Accuracy)
	domainName := func(k string) string { return s.tax.domainName(k) }
	rep.ByDomain = breakdown(atts, func(a attempt) string { return a.Domain }, domainName)
	rep.BySkill = breakdown(atts, func(a attempt) string { return a.Skill }, s.nameOf(s.tax.Skills))
	rep.ByType = breakdown(atts, func(a attempt) string { return a.Type }, s.nameOf(s.tax.Types))
	rep.ByDay = breakdown(atts, func(a attempt) string { return fmt.Sprintf("%02d", dayOf[a.QuestionID]) },
		func(k string) string { return "Day " + strings.TrimLeft(k, "0") })
	sort.Slice(rep.ByDay, func(i, j int) bool { return rep.ByDay[i].Key < rep.ByDay[j].Key })
	rep.WeakConcepts = weakConcepts(atts, 6)
	rep.Recommendation = s.rulesRecommendation(rep, p)
	return rep, nil
}

// rulesRecommendation is the deterministic coach: it always exists, and the LLM debrief builds on it.
func (s *Server) rulesRecommendation(rep *Report, p Profile) Recommendation {
	rec := Recommendation{}
	if rep.Answered == 0 {
		rec.Headline = "Nothing answered yet"
		rec.Direction = "Answer at least a few questions to get a direction."
		return rec
	}
	// Weakest domains first; a focal point or the primary focus breaks ties toward what the user cares about.
	weak := slices.Clone(rep.ByDomain)
	sort.SliceStable(weak, func(i, j int) bool {
		wi, wj := weak[i].Accuracy, weak[j].Accuracy
		if slices.Contains(p.FocalDomains, weak[i].Key) || p.PrimaryFocus == weak[i].Key {
			wi -= 0.08
		}
		if slices.Contains(p.FocalDomains, weak[j].Key) || p.PrimaryFocus == weak[j].Key {
			wj -= 0.08
		}
		return wi < wj
	})
	for _, b := range rep.ByDomain {
		if b.Accuracy >= 0.8 {
			rec.Strengths = append(rec.Strengths, b.Name)
		}
	}
	gap := rep.Potential - rep.Accuracy
	switch {
	case len(rep.BlindSpots) >= 2:
		rec.Headline = fmt.Sprintf("%d confident misses: your riskiest gaps are the ones you don't feel", len(rep.BlindSpots))
	case gap > 0.12:
		rec.Headline = "Your reasoning is ahead of your recall"
	case gap < -0.12:
		rec.Headline = "Right answers, thin reasoning: push for depth"
	default:
		rec.Headline = band(rep.Accuracy) + fmt.Sprintf(" at %d%%", int(math.Round(rep.Accuracy*100)))
	}
	var focusKeys []string
	for _, b := range weak {
		if len(rec.FocusAreas) >= 3 || b.Accuracy >= 0.75 {
			break
		}
		fa := FocusArea{Domain: b.Key, Why: fmt.Sprintf("%d%% across %d question(s) in %s.", int(math.Round(b.Accuracy*100)), b.Count, b.Name)}
		for _, c := range rep.WeakConcepts {
			if c.Domain == b.Key {
				fa.Concept = c.Concept
				fa.Why += fmt.Sprintf(" Weakest concept: %s.", strings.ReplaceAll(c.Concept, "-", " "))
				break
			}
		}
		fa.Practice = practiceHint(b.Key, rep)
		rec.FocusAreas = append(rec.FocusAreas, fa)
		focusKeys = append(focusKeys, b.Key)
	}
	var parts []string
	if len(rec.FocusAreas) > 0 {
		names := make([]string, len(rec.FocusAreas))
		for i, f := range rec.FocusAreas {
			names[i] = s.tax.domainName(f.Domain)
		}
		parts = append(parts, "Put your next reps into "+joinAnd(names)+".")
	} else {
		parts = append(parts, "No domain fell below 75%: raise the difficulty floor and add open-ended design and leadership prompts.")
	}
	if gap > 0.12 {
		parts = append(parts, "You reason well but miss specifics: drill fundamentals with short multiple-choice and estimation sets.")
	} else if gap < -0.12 {
		parts = append(parts, "Your answers land but lack depth or calibration: practise written answers that name tradeoffs and second-order effects.")
	}
	if len(rep.BlindSpots) > 0 {
		parts = append(parts, "Revisit the questions you were certain about and got wrong before anything else.")
	}
	for _, sk := range rep.BySkill {
		if sk.Count >= 2 && sk.Accuracy < 0.5 {
			parts = append(parts, fmt.Sprintf("Your %s questions scored %d%%, the weakest skill.", strings.ToLower(sk.Name), int(math.Round(sk.Accuracy*100))))
			break
		}
	}
	if rep.EstMs > 0 && rep.TimeMs > rep.EstMs*3/2 {
		parts = append(parts, "You took well over the expected time: try a timed regiment to rebuild speed.")
	}
	rec.Direction = strings.Join(parts, " ")

	minD, maxD := 2, 4
	if rep.Accuracy >= 0.8 {
		minD, maxD = 3, 5
	} else if rep.Accuracy < 0.5 {
		minD, maxD = 1, 3
	}
	if len(focusKeys) == 0 {
		focusKeys = nil
	}
	rec.Next = &NextRegiment{
		Name:        "Follow-up: " + joinAnd(namesOf(s, focusKeys, "mixed set")),
		Description: "Generated from your last regiment: weakest areas, adaptive, a notch " + map[bool]string{true: "harder", false: "steadier"}[rep.Accuracy >= 0.8] + ".",
		Config: s.suggested(RegimentConfig{Domains: focusKeys, DifficultyMin: minD, DifficultyMax: maxD, Days: 5, PerDay: 4,
			Adaptive: true, Feedback: "immediate"}),
	}
	return rec
}

func namesOf(s *Server, keys []string, fallback string) []string {
	if len(keys) == 0 {
		return []string{fallback}
	}
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = s.tax.domainName(k)
	}
	return out
}

func practiceHint(domain string, rep *Report) string {
	hints := map[string]string{
		"system_design":       "Do one diagram question a day and say the numbers out loud: QPS, storage, the bottleneck.",
		"distributed_systems": "Pick one failure mode per day (lag, partition, duplicate delivery) and trace it through a system you own.",
		"reliability":         "Re-read your last incident through an SLO lens: what burned, what alerted, what should have.",
		"debugging":           "Bug hunts in your primary language, timed, then explain the fix as if in a review.",
		"code_quality":        "Review one real PR a day with the severity labels: what blocks, what is a nit.",
		"performance":         "Estimate before you measure: write down the expected latency, then profile to check.",
		"security":            "Threat-model one feature per week with STRIDE and write down the top three mitigations.",
		"delivery":            "Walk through an expand/contract migration and a canary rollback for something you shipped.",
		"leadership":          "Write a one-page decision memo for a real open question and get one person to poke holes in it.",
		"execution":           "Plan tomorrow the night before: one leverage task, one unblock, one thing you will say no to.",
		"problem_solving":     "Five back-of-envelope estimates a week; check them against real dashboards.",
		"ai_systems":          "Build a 20-case eval for an LLM feature you use and track it across one prompt change.",
	}
	return hints[domain]
}

func joinAnd(xs []string) string {
	switch len(xs) {
	case 0:
		return ""
	case 1:
		return xs[0]
	case 2:
		return xs[0] + " and " + xs[1]
	}
	return strings.Join(xs[:len(xs)-1], ", ") + " and " + xs[len(xs)-1]
}

// refreshReport recomputes and stores the regiment report. finished queues the LLM debrief.
func (s *Server) refreshReport(ctx context.Context, regimentID string, finished bool) error {
	rep, err := s.buildReport(ctx, regimentID)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(rep)
	if _, err := s.pool.Exec(ctx, `UPDATE regiments SET report = $2::jsonb WHERE id = $1::uuid`, regimentID, string(raw)); err != nil {
		return err
	}
	if finished {
		status := "off"
		if s.llmActive(ctx) {
			status = "pending"
		}
		if _, err := s.pool.Exec(ctx, `UPDATE regiments SET debrief_status = $2, debrief_error = NULL WHERE id = $1::uuid`, regimentID, status); err != nil {
			return err
		}
		if status == "pending" {
			s.jobs.enqueue(job{kind: "debrief", id: regimentID})
		}
		s.snapshotInsight(ctx)
	}
	return nil
}

// snapshotInsight stores a rules-based profile summary so the Insights page has a point in its history
// for every finished regiment, even when no model is configured. It never calls a model.
func (s *Server) snapshotInsight(ctx context.Context) {
	p, err := s.getProfile(ctx)
	if err != nil {
		return
	}
	st, err := s.profileStats(ctx)
	if err != nil {
		return
	}
	raw, _ := json.Marshal(s.rulesInsight(st, p))
	if _, err := s.pool.Exec(ctx, `INSERT INTO insights (body, source) VALUES ($1::jsonb, 'rules')`, string(raw)); err != nil {
		slog.Warn("insight snapshot failed", "operation", "insights.snapshot", "error", err)
	}
}

// ---------------------------------------------------------------- profile insight

type Insight struct {
	Summary       string      `json:"summary"`
	Strengths     []string    `json:"strengths"`
	FocusNext     []FocusArea `json:"focusNext"`
	ArchetypeNote string      `json:"archetypeNote"`
	WeeklyPlan    []string    `json:"weeklyPlan"`
	Source        string      `json:"source"`
	CreatedAt     string      `json:"createdAt"`
}

var archetypeNotes = map[string]string{
	"tech_lead":  "Tech Leads are judged on how well their team executes: keep execution, delivery and code-review reps high, and practise unblocking under ambiguity.",
	"architect":  "Architects own direction for a critical area: weight system design, distributed systems and written decision-making, and keep one foot in the code.",
	"solver":     "Solvers are dropped into the hardest problem of the quarter: debugging, performance and deep distributed-systems knowledge are your edge, so keep them razor sharp.",
	"right_hand": "Right Hands extend an executive's reach: leadership, execution and strategy dominate, but credibility comes from staying technically current across the whole org.",
}

func (s *Server) rulesInsight(st ProfileStats, p Profile) Insight {
	in := Insight{Source: "rules", CreatedAt: time.Now().UTC().Format(time.RFC3339), ArchetypeNote: archetypeNotes[p.Archetype]}
	var tried, untried []Mastery
	for _, m := range st.Domains {
		if m.Count > 0 {
			tried = append(tried, m)
		} else {
			untried = append(untried, m)
		}
	}
	sort.Slice(tried, func(i, j int) bool { return tried[i].Mastery > tried[j].Mastery })
	if len(tried) == 0 {
		in.Summary = "No answers yet. Start with a short mixed regiment so the profile has something to measure."
	} else {
		in.Summary = fmt.Sprintf("%d answers so far at %d%% accuracy and %d%% potential.", st.Answered,
			int(math.Round(st.Accuracy*100)), int(math.Round(st.Potential*100)))
		top := tried[0]
		low := tried[len(tried)-1]
		in.Summary += fmt.Sprintf(" Strongest: %s (%d%%). Weakest so far: %s (%d%%).", top.Name, int(math.Round(top.Mastery*100)),
			low.Name, int(math.Round(low.Mastery*100)))
		if st.BlindSpots > 0 {
			in.Summary += fmt.Sprintf(" %d confident miss(es) are worth revisiting first.", st.BlindSpots)
		}
		if len(untried) > 0 {
			in.Summary += fmt.Sprintf(" %d domain(s) are still unmeasured.", len(untried))
		}
	}
	for _, m := range tried {
		if m.Mastery >= 0.7 && len(in.Strengths) < 3 {
			in.Strengths = append(in.Strengths, m.Name)
		}
	}
	// Focus: the primary focus if it is not yet strong, then weak focal points, then the weakest overall.
	addFocus := func(m Mastery, why string) {
		for _, f := range in.FocusNext {
			if f.Domain == m.Key {
				return
			}
		}
		if len(in.FocusNext) < 3 {
			in.FocusNext = append(in.FocusNext, FocusArea{Domain: m.Key, Why: why, Practice: practiceHint(m.Key, nil)})
		}
	}
	byKey := map[string]Mastery{}
	for _, m := range st.Domains {
		byKey[m.Key] = m
	}
	if m, ok := byKey[p.PrimaryFocus]; ok && (m.Count == 0 || m.Mastery < 0.8) {
		addFocus(m, "Your primary focus: the area you most want to hone.")
	}
	for _, k := range p.FocalDomains {
		if m := byKey[k]; m.Count == 0 || m.Mastery < 0.65 {
			addFocus(m, "A focal point that is not yet at 65% mastery.")
		}
	}
	for i := len(tried) - 1; i >= 0; i-- {
		addFocus(tried[i], fmt.Sprintf("Lowest mastery among measured domains (%d%%).", int(math.Round(tried[i].Mastery*100))))
	}
	sessions := max(2, min(6, p.WeeklyMinutes/20))
	per := p.WeeklyMinutes / sessions
	in.WeeklyPlan = []string{fmt.Sprintf("%d sessions of about %d minutes this week.", sessions, per)}
	for _, f := range in.FocusNext {
		in.WeeklyPlan = append(in.WeeklyPlan, s.tax.domainName(f.Domain)+": "+f.Practice)
	}
	return in
}

// recommendRegiment builds the "make me a regiment" config from the profile and stats.
func (s *Server) recommendRegiment(ctx context.Context) (*NextRegiment, error) {
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	st, err := s.profileStats(ctx)
	if err != nil {
		return nil, err
	}
	in := s.rulesInsight(st, p)
	var domains []string
	for _, f := range in.FocusNext {
		domains = append(domains, f.Domain)
	}
	if p.PrimaryFocus != "" && !slices.Contains(domains, p.PrimaryFocus) {
		domains = append(domains, p.PrimaryFocus)
	}
	perDay := max(3, min(8, p.WeeklyMinutes/5/4))
	gen := 0
	if s.llmActive(ctx) {
		gen = 1
	}
	minD, maxD := 2, 4
	if p.Level == "principal" || p.Level == "senior_staff" {
		minD, maxD = 3, 5
	}
	return &NextRegiment{
		Name:        "Tuned for you: " + joinAnd(namesOf(s, domains, "mixed")),
		Description: "Five days built from your profile: primary focus, focal points and weakest measured areas, adaptive as you go.",
		Config: s.suggested(RegimentConfig{Domains: domains, DifficultyMin: minD, DifficultyMax: maxD, Days: 5, PerDay: perDay,
			Adaptive: true, Feedback: "immediate", GeneratedPerDay: gen, Preset: "tuned"}),
	}, nil
}
