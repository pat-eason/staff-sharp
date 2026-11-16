package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strings"
	"time"
)

type job struct {
	kind string // grade | generate | debrief
	id   string
}

// Jobs runs LLM work in the background so answering never waits on a model. Pending work is stored
// in Postgres (grade_status / gen_status / debrief_status), so a restart re-queues it.
type Jobs struct {
	s  *Server
	ch chan job
}

func newJobs(s *Server, workers int) *Jobs {
	j := &Jobs{s: s, ch: make(chan job, 2000)}
	for i := 0; i < workers; i++ {
		go j.loop()
	}
	return j
}

func (j *Jobs) enqueue(x job) {
	select {
	case j.ch <- x:
	default:
		slog.Warn("job queue full; work stays pending until restart", "operation", "jobs."+x.kind, "id", x.id)
	}
}

func (j *Jobs) enqueueGenerations(ctx context.Context, sessionID string) {
	rows, err := j.s.pool.Query(ctx, `SELECT id::text FROM session_items WHERE session_id = $1::uuid AND gen_status = 'pending'`, sessionID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			j.enqueue(job{kind: "generate", id: id})
		}
	}
}

// resume re-queues everything left pending by a previous process.
func (j *Jobs) resume(ctx context.Context) {
	queries := map[string]string{
		"grade":    `SELECT id::text FROM session_items WHERE grade_status = 'pending'`,
		"generate": `SELECT si.id::text FROM session_items si JOIN sessions se ON se.id = si.session_id WHERE si.gen_status = 'pending' AND se.status = 'in_progress'`,
		"debrief":  `SELECT id::text FROM regiments WHERE debrief_status = 'pending'`,
	}
	for kind, q := range queries {
		rows, err := j.s.pool.Query(ctx, q)
		if err != nil {
			slog.Error("resume jobs failed", "operation", "jobs.resume", "error", err)
			continue
		}
		n := 0
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				j.enqueue(job{kind: kind, id: id})
				n++
			}
		}
		rows.Close()
		if n > 0 {
			slog.Info("re-queued pending work", "operation", "jobs.resume", "kind", kind, "count", n)
		}
	}
}

func (j *Jobs) loop() {
	for x := range j.ch {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
		start := time.Now()
		var err error
		switch x.kind {
		case "grade":
			err = j.s.gradeWithLLM(ctx, x.id)
		case "generate":
			err = j.s.generateItem(ctx, x.id)
		case "debrief":
			err = j.s.debrief(ctx, x.id)
		}
		if err != nil {
			slog.Warn("job failed", "operation", "jobs."+x.kind, "id", x.id, "durationMs", time.Since(start).Milliseconds(), "error", err)
		}
		cancel()
	}
}

// ---------------------------------------------------------------- grading

type llmGrade struct {
	Score            float64  `json:"score"`
	Potential        float64  `json:"potential"`
	Verdict          string   `json:"verdict"`
	Summary          string   `json:"summary"`
	Strengths        []string `json:"strengths"`
	Gaps             []string `json:"gaps"`
	KeyPointsCovered []int    `json:"keyPointsCovered"`
	RedFlagsHit      []int    `json:"redFlagsHit"`
	IssuesIdentified []string `json:"issuesIdentified"`
	Feedback         string   `json:"feedback"`
	FollowUp         string   `json:"followUp"`
}

func numbered(code string) string {
	var b strings.Builder
	for i, line := range strings.Split(code, "\n") {
		fmt.Fprintf(&b, "%3d | %s\n", i+1, line)
	}
	return b.String()
}

func profileBlurb(p Profile, tax *Taxonomy) string {
	parts := []string{fmt.Sprintf("Level: %s, %d years of experience", strings.ReplaceAll(p.Level, "_", " "), p.YearsExperience)}
	if p.Archetype != "" {
		parts = append(parts, "Archetype: "+strings.ReplaceAll(p.Archetype, "_", " "))
	}
	parts = append(parts, "Primary language: "+p.PrimaryLanguage)
	if p.PrimaryFocus != "" {
		parts = append(parts, "Primary focus: "+tax.domainName(p.PrimaryFocus))
	}
	if p.Stack != "" {
		parts = append(parts, "Stack: "+p.Stack)
	}
	if p.Context != "" {
		parts = append(parts, "About them: "+p.Context)
	}
	return strings.Join(parts, "\n")
}

func (s *Server) gradeMessage(q *Question, variant string, resp Response, auto *AutoGrade, conf *int, p Profile, instructions string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Question\nDomain: %s · Type: %s · Difficulty: %d/5 (3 = staff) · Skill: %s\n\n## %s\n\n%s\n",
		s.tax.domainName(q.Domain), q.Type, q.Difficulty, q.Skill, q.Title, q.Prompt)
	if q.Context != "" {
		fmt.Fprintf(&b, "\n### Context\n%s\n", q.Context)
	}
	if q.isCode() {
		fmt.Fprintf(&b, "\n### Code shown to the candidate (%s, line numbers added)\n```\n%s```\n", variant, numbered(q.Code[variant]))
		b.WriteString("\n### Known issues (answer key)\n")
		for _, is := range q.Issues {
			fmt.Fprintf(&b, "- id %s [%s] lines %v: %s. Fix: %s\n", is.ID, is.Severity, q.IssueLines[variant][is.ID], is.Summary, is.Fix)
		}
	}
	if r := q.Rubric; r != nil {
		b.WriteString("\n### Rubric key points (0-based)\n")
		for i, k := range r.KeyPoints {
			fmt.Fprintf(&b, "%d. %s\n", i, k)
		}
		if len(r.RedFlags) > 0 {
			b.WriteString("\n### Red flags (0-based)\n")
			for i, k := range r.RedFlags {
				fmt.Fprintf(&b, "%d. %s\n", i, k)
			}
		}
		fmt.Fprintf(&b, "\n### Exemplar answer\n%s\n", r.Exemplar)
		if len(r.RequiredComponents) > 0 {
			fmt.Fprintf(&b, "\nExpected diagram components: %s\n", strings.Join(r.RequiredComponents, ", "))
		}
	}
	b.WriteString("\n# Candidate's answer\n")
	switch q.Type {
	case "code_review", "bug_hunt":
		if len(resp.Comments) == 0 {
			b.WriteString("(no line comments)\n")
		}
		for _, c := range resp.Comments {
			fmt.Fprintf(&b, "- line %d", c.Line)
			if c.Severity != "" {
				fmt.Fprintf(&b, " [%s]", c.Severity)
			}
			fmt.Fprintf(&b, ": %s\n", c.Text)
		}
		if resp.Text != "" {
			fmt.Fprintf(&b, "\nOverall notes:\n%s\n", resp.Text)
		}
		if auto != nil {
			fmt.Fprintf(&b, "\nAutomatic line matching (±1 line): found issues %v, missed %v, comments matching no issue on lines %v.\n",
				auto.FoundIssues, auto.MissedIssues, auto.FalseFlags)
		}
	case "diagram":
		b.WriteString("Diagram:\n" + diagramText(resp.Diagram))
		if resp.Text != "" {
			fmt.Fprintf(&b, "\nWritten explanation:\n%s\n", resp.Text)
		}
		if auto != nil {
			fmt.Fprintf(&b, "\nComponent check: present %v, missing %v.\n", auto.ComponentsFound, auto.ComponentsMissed)
		}
	default:
		if strings.TrimSpace(resp.Text) == "" {
			b.WriteString("(empty)\n")
		} else {
			b.WriteString(resp.Text + "\n")
		}
	}
	if conf != nil {
		fmt.Fprintf(&b, "\nStated confidence: %s\n", []string{"", "guessing", "fairly sure", "certain"}[*conf])
	}
	fmt.Fprintf(&b, "\n# Candidate\n%s\n", profileBlurb(p, s.tax))
	if strings.TrimSpace(instructions) != "" {
		fmt.Fprintf(&b, "\n# Extra grading instructions from the user\n%s\n", instructions)
	}
	return b.String()
}

func (s *Server) gradeWithLLM(ctx context.Context, itemID string) error {
	var sessionID string
	var qid, variant *string
	var respRaw, gradeRaw []byte
	var conf *int
	var status string
	err := s.pool.QueryRow(ctx, `SELECT session_id::text, question_id, variant, response, grade, confidence, grade_status
		FROM session_items WHERE id = $1::uuid`, itemID).Scan(&sessionID, &qid, &variant, &respRaw, &gradeRaw, &conf, &status)
	if err != nil || status != "pending" || qid == nil {
		return err
	}
	q, err := s.loadQuestion(ctx, s.pool, *qid)
	if err != nil {
		return err
	}
	var resp Response
	_ = json.Unmarshal(respRaw, &resp)
	var g Grade
	_ = json.Unmarshal(gradeRaw, &g)
	p, _ := s.getProfile(ctx)
	st, _ := s.cfg.Get(ctx)

	out, _, err := s.runLLM(ctx, "grade", s.gradeMessage(q, deref(variant), resp, g.Auto, conf, p, st.GraderInstructions))
	if err != nil {
		msg := err.Error()
		if errors.Is(err, errLLMOff) {
			msg = "No model provider is configured; self-grade against the rubric instead."
		}
		// Keep the provisional score, mark the grade failed so the UI offers retry or self-grading.
		_, _ = s.pool.Exec(ctx, `UPDATE session_items SET grade_status = 'failed', grade_error = $2,
			graded_by = CASE WHEN $3 THEN 'heuristic' ELSE 'auto' END WHERE id = $1::uuid`,
			itemID, truncate(msg, 400), q.Type == "free_text" || q.Type == "diagram")
		s.afterGrade(ctx, sessionID)
		return err
	}
	var lg llmGrade
	if err := json.Unmarshal(out, &lg); err != nil {
		return err
	}
	lg.Score, lg.Potential = clamp01(lg.Score), clamp01(lg.Potential)
	score := lg.Score
	switch q.Type {
	case "diagram":
		cov := 1.0
		if g.Auto != nil && q.Rubric != nil && len(q.Rubric.RequiredComponents) > 0 {
			cov = float64(len(g.Auto.ComponentsFound)) / float64(len(q.Rubric.RequiredComponents))
		}
		score = 0.85*lg.Score + 0.15*cov
	case "code_review", "bug_hunt":
		// Detection counts issues found by line or described anywhere; the model's score weighs the explanations.
		found := map[string]bool{}
		if g.Auto != nil {
			for _, id := range g.Auto.FoundIssues {
				found[id] = true
			}
		}
		for _, id := range lg.IssuesIdentified {
			found[id] = true
		}
		var total, hit float64
		for _, is := range q.Issues {
			w := severityWeight[is.Severity]
			total += w
			if found[is.ID] {
				hit += w
			}
		}
		det := 0.0
		if total > 0 {
			det = hit / total
		}
		score = det * (0.55 + 0.45*lg.Score)
	}
	raw, _ := json.Marshal(lg)
	g.LLM = raw
	gradeJSON, _ := json.Marshal(g)
	if _, err := s.pool.Exec(ctx, `UPDATE session_items SET score = $2, potential = $3, grade = $4::jsonb, grade_status = 'graded',
		graded_by = 'llm', grade_error = NULL WHERE id = $1::uuid AND grade_status = 'pending'`,
		itemID, score, lg.Potential, string(gradeJSON)); err != nil {
		return err
	}
	s.afterGrade(ctx, sessionID)
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---------------------------------------------------------------- generation

func (s *Server) generationMessage(ctx context.Context, spec GenSpec, p Profile) string {
	var titles []string
	rows, err := s.pool.Query(ctx, `SELECT title FROM questions WHERE domain = $1 AND active ORDER BY random() LIMIT 40`, spec.Domain)
	if err == nil {
		for rows.Next() {
			var t string
			if rows.Scan(&t) == nil {
				titles = append(titles, t)
			}
		}
		rows.Close()
	}
	var d Domain
	for _, x := range s.tax.Domains {
		if x.Key == spec.Domain {
			d = x
		}
	}
	return fmt.Sprintf(`Write one new question.

Domain: %s (%s)
Domain concepts: %s
Concept to target: %s
Type: %s
Difficulty: %d/5 (1 solid senior, 3 staff, 5 principal)

# The engineer who will answer it
%s

Make it a fresh, realistic scenario that fits their stack and context where that helps. Do not repeat these existing questions:
- %s`,
		d.Name, d.Blurb, strings.Join(d.Concepts, ", "), spec.Concept, spec.Type, spec.Difficulty,
		profileBlurb(p, s.tax), strings.Join(titles, "\n- "))
}

func (s *Server) generateItem(ctx context.Context, itemID string) error {
	var specRaw []byte
	var status, sessionID string
	err := s.pool.QueryRow(ctx, `SELECT session_id::text, gen_spec, gen_status FROM session_items WHERE id = $1::uuid`, itemID).
		Scan(&sessionID, &specRaw, &status)
	if err != nil || status != "pending" {
		return err
	}
	var spec GenSpec
	_ = json.Unmarshal(specRaw, &spec)
	p, _ := s.getProfile(ctx)
	out, _, err := s.runLLM(ctx, "generate", s.generationMessage(ctx, spec, p))
	var q Question
	if err == nil {
		err = json.Unmarshal(out, &q)
	}
	if err == nil {
		q.ID = "gen-" + randomID(6)
		q.Domain = spec.Domain
		q.Source = "generated"
		q.Language = nil
		q.Code, q.Issues, q.Numeric, q.Items = nil, nil, nil, nil
		if q.Type != "mcq" && q.Type != "multi" && q.Type != "free_text" {
			q.Type = spec.Type
		}
		if q.Difficulty == 0 {
			q.Difficulty = spec.Difficulty
		}
		if q.Type == "free_text" {
			q.Options, q.Answer, q.OptionNotes = nil, nil, nil
		} else {
			q.Rubric = nil
		}
		err = validateQuestion(s.tax, &q)
	}
	if err == nil {
		_, err = upsertQuestion(ctx, s.pool, &q)
	}
	if err != nil {
		// Fall back to an unseen bank question from the same domain so the day still has its slot.
		slog.Warn("generation failed, using a bank question", "operation", "jobs.generate", "id", itemID, "error", err)
		return s.fallbackItem(ctx, itemID, sessionID, spec, p)
	}
	sh, _ := json.Marshal(shuffleFor(&q))
	_, err = s.pool.Exec(ctx, `UPDATE session_items SET question_id = $2, shuffle = $3::jsonb, gen_status = 'ready'
		WHERE id = $1::uuid AND gen_status = 'pending'`, itemID, q.ID, string(sh))
	return err
}

func (s *Server) fallbackItem(ctx context.Context, itemID, sessionID string, spec GenSpec, p Profile) error {
	exclude := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT si.question_id FROM session_items si JOIN sessions se ON se.id = si.session_id
		JOIN sessions me ON me.regiment_id = se.regiment_id WHERE me.id = $1::uuid AND si.question_id IS NOT NULL`, sessionID)
	if err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				exclude[id] = true
			}
		}
		rows.Close()
	}
	picked, err := s.selectQuestions(ctx, RegimentConfig{Domains: []string{spec.Domain}, DifficultyMin: 1, DifficultyMax: 5}, p, 1, exclude)
	if err != nil || len(picked) == 0 {
		_, _ = s.pool.Exec(ctx, `UPDATE session_items SET gen_status = 'failed', skipped = true, submitted_at = now(), score = NULL
			WHERE id = $1::uuid`, itemID)
		return fmt.Errorf("no fallback question: %v", err)
	}
	q, err := s.loadQuestion(ctx, s.pool, picked[0].ID)
	if err != nil {
		return err
	}
	sh, _ := json.Marshal(shuffleFor(q))
	_, err = s.pool.Exec(ctx, `UPDATE session_items SET question_id = $2, shuffle = $3::jsonb, variant = NULLIF($4, ''), gen_status = 'fallback'
		WHERE id = $1::uuid AND gen_status = 'pending'`, itemID, q.ID, string(sh), pickVariant(q, p))
	return err
}

// ---------------------------------------------------------------- debrief and insight

func (s *Server) debrief(ctx context.Context, regimentID string) error {
	r, err := s.getRegiment(ctx, regimentID)
	if err != nil {
		return err
	}
	// Wait for outstanding grades (they re-trigger nothing, so poll briefly).
	for i := 0; i < 30; i++ {
		var pending int
		_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM session_items si JOIN sessions se ON se.id = si.session_id
			WHERE se.regiment_id = $1::uuid AND si.grade_status = 'pending'`, regimentID).Scan(&pending)
		if pending == 0 {
			break
		}
		time.Sleep(5 * time.Second)
	}
	rep, err := s.buildReport(ctx, regimentID)
	if err != nil {
		return err
	}
	repRaw, _ := json.Marshal(rep)
	_, _ = s.pool.Exec(ctx, `UPDATE regiments SET report = $2::jsonb WHERE id = $1::uuid`, regimentID, string(repRaw))
	p, _ := s.getProfile(ctx)
	st, _ := s.profileStats(ctx)

	var b strings.Builder
	fmt.Fprintf(&b, "# Regiment: %s\n%s\nDays: %d · Questions per day: %d · Timed: %v\n\n", r.Name, r.Description, r.Config.Days, r.Config.PerDay, r.Config.Timed)
	fmt.Fprintf(&b, "# Engineer\n%s\nFocal points: %s\nGoal: %s\n\n", profileBlurb(p, s.tax), strings.Join(namesOf(s, p.FocalDomains, "none"), ", "), p.Goal)
	b.WriteString("# Results for this regiment (accuracy and potential are 0-1)\n")
	b.WriteString(string(repRaw))
	b.WriteString("\n\n# Item-level feedback from grading\n")
	items, _ := s.itemViews(ctx, `si.session_id IN (SELECT id FROM sessions WHERE regiment_id = $1::uuid)`, regimentID)
	for _, it := range items {
		if it.Question == nil || it.Score == nil {
			continue
		}
		fmt.Fprintf(&b, "- [%s · %s · d%d] %s: score %.2f", it.Question.Domain, it.Question.Type, it.Question.Difficulty, it.Question.Title, *it.Score)
		var g Grade
		if json.Unmarshal(it.Grade, &g) == nil && len(g.LLM) > 0 {
			var lg llmGrade
			if json.Unmarshal(g.LLM, &lg) == nil && lg.Summary != "" {
				fmt.Fprintf(&b, " — %s", lg.Summary)
			}
		}
		b.WriteString("\n")
	}
	b.WriteString("\n# Long-term mastery by domain (0-1, count of answers)\n")
	for _, m := range st.Domains {
		fmt.Fprintf(&b, "- %s (%s): mastery %.2f, potential %.2f, n=%d\n", m.Name, m.Key, m.Mastery, m.Potential, m.Count)
	}
	keys := make([]string, len(s.tax.Domains))
	for i, d := range s.tax.Domains {
		keys[i] = d.Key
	}
	fmt.Fprintf(&b, "\nValid domain keys for nextRegiment.domains: %s\nValid types: mcq, multi, free_text, numeric, ordering, diagram, code_review, bug_hunt\n", strings.Join(keys, ", "))

	out, _, err := s.runLLM(ctx, "debrief", b.String())
	if err != nil {
		_, _ = s.pool.Exec(ctx, `UPDATE regiments SET debrief_status = 'failed', debrief_error = $2 WHERE id = $1::uuid`, regimentID, truncate(err.Error(), 400))
		return err
	}
	var rec struct {
		Recommendation
		NextRegiment *struct {
			Name          string   `json:"name"`
			Description   string   `json:"description"`
			Domains       []string `json:"domains"`
			Types         []string `json:"types"`
			DifficultyMin int      `json:"difficultyMin"`
			DifficultyMax int      `json:"difficultyMax"`
			Days          int      `json:"days"`
			PerDay        int      `json:"perDay"`
			Timed         bool     `json:"timed"`
		} `json:"nextRegiment"`
	}
	if err := json.Unmarshal(out, &rec); err != nil {
		return err
	}
	final := rec.Recommendation
	if n := rec.NextRegiment; n != nil {
		cfg, err := s.normalizeConfig(RegimentConfig{Domains: n.Domains, Types: n.Types, DifficultyMin: n.DifficultyMin,
			DifficultyMax: n.DifficultyMax, Days: n.Days, PerDay: n.PerDay, Timed: n.Timed, Adaptive: true})
		if err == nil {
			final.Next = &NextRegiment{Name: n.Name, Description: n.Description, Config: cfg}
		}
	}
	if final.Next == nil {
		final.Next = rep.Recommendation.Next
	}
	raw, _ := json.Marshal(final)
	_, err = s.pool.Exec(ctx, `UPDATE regiments SET debrief = $2::jsonb, debrief_status = 'ready', debrief_error = NULL WHERE id = $1::uuid`,
		regimentID, string(raw))
	return err
}

func (s *Server) generateInsight(ctx context.Context) (*Insight, error) {
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	st, err := s.profileStats(ctx)
	if err != nil {
		return nil, err
	}
	rules := s.rulesInsight(st, p)
	in := rules
	if s.llmActive(ctx) && st.Answered > 0 {
		var b strings.Builder
		fmt.Fprintf(&b, "# Engineer\n%s\nGoal: %s\nFocal points: %s\nWeekly practice budget: %d minutes\n\n", profileBlurb(p, s.tax), p.Goal,
			strings.Join(namesOf(s, p.FocalDomains, "none"), ", "), p.WeeklyMinutes)
		statsRaw, _ := json.Marshal(st)
		b.WriteString("# Stats (mastery/potential/accuracy 0-1)\n" + string(statsRaw) + "\n\n")
		rows, err := s.pool.Query(ctx, `SELECT name, report->'recommendation'->>'headline', (report->>'accuracy')::float
			FROM regiments WHERE status = 'completed' AND report IS NOT NULL ORDER BY completed_at DESC LIMIT 8`)
		if err == nil {
			b.WriteString("# Recent regiments\n")
			for rows.Next() {
				var name string
				var headline *string
				var acc *float64
				if rows.Scan(&name, &headline, &acc) == nil {
					fmt.Fprintf(&b, "- %s: %s (accuracy %.2f)\n", name, deref(headline), valueOr(acc, 0))
				}
			}
			rows.Close()
		}
		keys := make([]string, len(s.tax.Domains))
		for i, d := range s.tax.Domains {
			keys[i] = d.Key
		}
		fmt.Fprintf(&b, "\nUse only these domain keys in focusNext[].domain: %s\n", strings.Join(keys, ", "))
		out, _, err := s.runLLM(ctx, "insight", b.String())
		if err != nil {
			return nil, err
		}
		var li Insight
		if err := json.Unmarshal(out, &li); err != nil {
			return nil, err
		}
		li.FocusNext = slices.DeleteFunc(li.FocusNext, func(f FocusArea) bool { return !s.tax.hasDomain(f.Domain) })
		if li.ArchetypeNote == "" {
			li.ArchetypeNote = rules.ArchetypeNote
		}
		li.Source, li.CreatedAt = "llm", time.Now().UTC().Format(time.RFC3339)
		in = li
	}
	raw, _ := json.Marshal(in)
	if _, err := s.pool.Exec(ctx, `INSERT INTO insights (body, source) VALUES ($1::jsonb, $2)`, string(raw), in.Source); err != nil {
		return nil, err
	}
	return &in, nil
}

func (s *Server) latestInsight(ctx context.Context) (*Insight, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT body FROM insights ORDER BY created_at DESC LIMIT 1`).Scan(&raw)
	if err != nil {
		// No stored insight yet: compute the rules version on the fly.
		p, perr := s.getProfile(ctx)
		st, serr := s.profileStats(ctx)
		if perr != nil || serr != nil {
			return nil, errors.Join(perr, serr)
		}
		in := s.rulesInsight(st, p)
		return &in, nil
	}
	var in Insight
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	return &in, nil
}

func valueOr(p *float64, d float64) float64 {
	if p == nil || math.IsNaN(*p) {
		return d
	}
	return *p
}
