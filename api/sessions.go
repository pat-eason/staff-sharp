package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
)

type GenSpec struct {
	Domain     string `json:"domain"`
	Concept    string `json:"concept,omitempty"`
	Difficulty int    `json:"difficulty"`
	Type       string `json:"type"`
}

type ItemView struct {
	ID          string          `json:"id"`
	Position    int             `json:"position"`
	Status      string          `json:"status"` // open | submitted | skipped | generating
	Withheld    bool            `json:"withheld,omitempty"`
	Question    *PublicQuestion `json:"question,omitempty"`
	Response    json.RawMessage `json:"response,omitempty"`
	Confidence  *int            `json:"confidence"`
	TimeSpentMs int64           `json:"timeSpentMs"`
	Score       *float64        `json:"score"`
	Potential   *float64        `json:"potential"`
	GradeStatus string          `json:"gradeStatus"`
	GradedBy    *string         `json:"gradedBy"`
	GradeError  *string         `json:"gradeError,omitempty"`
	Grade       json.RawMessage `json:"grade,omitempty"`
	Reveal      *Reveal         `json:"reveal,omitempty"`
}

type SessionView struct {
	ID               string     `json:"id"`
	RegimentID       string     `json:"regimentId"`
	RegimentName     string     `json:"regimentName"`
	DayIndex         int        `json:"dayIndex"`
	Days             int        `json:"days"`
	Status           string     `json:"status"`
	Timed            bool       `json:"timed"`
	Feedback         string     `json:"feedback"`
	TimeLimitSeconds *int       `json:"timeLimitSeconds"`
	ElapsedMs        int64      `json:"elapsedMs"`
	Running          bool       `json:"running"`
	FocusLosses      int        `json:"focusLosses"`
	CurrentPosition  int        `json:"currentPosition"`
	ServerNow        string     `json:"serverNow"`
	Items            []ItemView `json:"items"`
	LLM              bool       `json:"llm"`
	Preset           string     `json:"preset"`
}

type sessionRow struct {
	ID, RegimentID, RegimentName, Status string
	DayIndex, FocusLosses, CurrentPos    int
	TimeLimit                            *int
	ElapsedMs                            int64
	Running                              bool
	Config                               RegimentConfig
}

const sessionSelect = `
	SELECT se.id::text, se.regiment_id::text, r.name, se.status, se.day_index, se.focus_losses, se.current_position,
	       se.time_limit_seconds,
	       se.elapsed_ms + COALESCE((extract(epoch FROM now() - se.running_since) * 1000)::bigint, 0),
	       se.running_since IS NOT NULL, r.config
	FROM sessions se JOIN regiments r ON r.id = se.regiment_id WHERE se.id = $1::uuid`

func (s *Server) loadSession(ctx context.Context, db dbtx, id string, lock bool) (*sessionRow, error) {
	q := sessionSelect
	if lock {
		q += " FOR UPDATE OF se"
	}
	var sr sessionRow
	var cfg []byte
	err := db.QueryRow(ctx, q, id).Scan(&sr.ID, &sr.RegimentID, &sr.RegimentName, &sr.Status, &sr.DayIndex, &sr.FocusLosses,
		&sr.CurrentPos, &sr.TimeLimit, &sr.ElapsedMs, &sr.Running, &cfg)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(cfg, &sr.Config)
	return &sr, nil
}

func (sr *sessionRow) timeUp() bool {
	return sr.Config.Timed && sr.TimeLimit != nil && sr.ElapsedMs > int64(*sr.TimeLimit)*1000+15_000
}

func shuffleFor(q *Question) Shuffle {
	ids := func(list []Option) []string {
		out := make([]string, len(list))
		for i, o := range list {
			out[i] = o.ID
		}
		rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
		return out
	}
	var sh Shuffle
	if q.Type == "mcq" || q.Type == "multi" {
		sh.Options = ids(q.Options)
	}
	if q.Type == "ordering" {
		sh.Items = ids(q.Items)
		// Never hand out the answer: reshuffle an order that happens to be correct.
		for tries := 0; tries < 5 && kendallTau(q.Items, sh.Items) > 0.999; tries++ {
			sh.Items = ids(q.Items)
		}
	}
	return sh
}

// fillSession chooses the day's questions when the day starts, so later days adapt to earlier results.
func (s *Server) fillSession(ctx context.Context, tx pgx.Tx, sr *sessionRow) (genCount int, limit int, err error) {
	p, err := s.getProfile(ctx)
	if err != nil {
		return 0, 0, err
	}
	cfg := sr.Config
	exclude := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT si.question_id FROM session_items si JOIN sessions se ON se.id = si.session_id
		WHERE se.regiment_id = $1::uuid AND si.question_id IS NOT NULL`, sr.RegimentID)
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			exclude[id] = true
		}
	}
	rows.Close()

	var ids []string
	estTotal := 0
	if sr.DayIndex == 1 && len(cfg.QuestionIDs) > 0 {
		ids = cfg.QuestionIDs
	} else {
		gen := 0
		if s.llmActive(ctx) {
			gen = cfg.GeneratedPerDay
		}
		picked, err := s.selectQuestions(ctx, cfg, p, cfg.PerDay-gen, exclude)
		if err != nil {
			return 0, 0, err
		}
		for _, c := range picked {
			ids = append(ids, c.ID)
		}
		genCount = gen
	}
	pos := 0
	for _, id := range ids {
		q, err := s.loadQuestion(ctx, tx, id)
		if err != nil {
			continue
		}
		sh, _ := json.Marshal(shuffleFor(q))
		variant := pickVariant(q, p)
		if _, err := tx.Exec(ctx, `INSERT INTO session_items (session_id, position, question_id, variant, shuffle)
			VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5::jsonb)`, sr.ID, pos, id, variant, string(sh)); err != nil {
			return 0, 0, err
		}
		estTotal += q.EstSeconds
		pos++
	}
	for i := 0; i < genCount; i++ {
		spec := s.genSpecFor(cfg, p, i)
		raw, _ := json.Marshal(spec)
		if _, err := tx.Exec(ctx, `INSERT INTO session_items (session_id, position, gen_spec, gen_status)
			VALUES ($1::uuid, $2, $3::jsonb, 'pending')`, sr.ID, pos, string(raw)); err != nil {
			return 0, 0, err
		}
		estTotal += 360
		pos++
	}
	if pos == 0 {
		return 0, 0, bad("no questions left that match this regiment's filters")
	}
	limit = cfg.TimeLimitMinutes * 60
	if limit == 0 {
		limit = max(120, int(math.Ceil(float64(estTotal)/60))*60)
	}
	return genCount, limit, nil
}

// genSpecFor picks what an LLM-written scenario should cover: the regiment's domains first, then the
// profile's primary focus and focal points, rotating so a day gets variety.
func (s *Server) genSpecFor(cfg RegimentConfig, p Profile, i int) GenSpec {
	pool := cfg.Domains
	if len(pool) == 0 {
		if p.PrimaryFocus != "" {
			pool = append(pool, p.PrimaryFocus)
		}
		pool = append(pool, p.FocalDomains...)
	}
	if len(pool) == 0 {
		for _, d := range s.tax.Domains {
			pool = append(pool, d.Key)
		}
	}
	domain := pool[(i+rand.IntN(len(pool)))%len(pool)]
	types := []string{"free_text", "mcq", "free_text", "multi"}
	if len(cfg.Types) > 0 {
		var allowed []string
		for _, t := range cfg.Types {
			if t == "free_text" || t == "mcq" || t == "multi" {
				allowed = append(allowed, t)
			}
		}
		if len(allowed) > 0 {
			types = allowed
		}
	}
	diff := cfg.DifficultyMin + rand.IntN(cfg.DifficultyMax-cfg.DifficultyMin+1)
	var concept string
	if len(cfg.FocusConcepts) > 0 {
		concept = cfg.FocusConcepts[rand.IntN(len(cfg.FocusConcepts))]
	} else {
		for _, d := range s.tax.Domains {
			if d.Key == domain && len(d.Concepts) > 0 {
				concept = d.Concepts[rand.IntN(len(d.Concepts))]
			}
		}
	}
	return GenSpec{Domain: domain, Concept: concept, Difficulty: diff, Type: types[i%len(types)]}
}

func (s *Server) startSession(ctx context.Context, id string) (*SessionView, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	sr, err := s.loadSession(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	genCount := 0
	switch sr.Status {
	case "completed":
		return nil, conflict{"this day is already complete"}
	case "pending":
		var prev string
		err := tx.QueryRow(ctx, `SELECT status FROM sessions WHERE regiment_id = $1::uuid AND day_index = $2`, sr.RegimentID, sr.DayIndex-1).Scan(&prev)
		if err == nil && prev != "completed" {
			return nil, conflict{"finish the previous day first"}
		}
		n, limit, err := s.fillSession(ctx, tx, sr)
		if err != nil {
			return nil, err
		}
		genCount = n
		var tl *int
		if sr.Config.Timed {
			tl = &limit
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET status = 'in_progress', started_at = now(), running_since = now(),
			time_limit_seconds = $2 WHERE id = $1::uuid`, id, tl); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if genCount > 0 {
		s.jobs.enqueueGenerations(ctx, id)
	}
	return s.sessionView(ctx, id)
}

func (s *Server) sessionView(ctx context.Context, id string) (*SessionView, error) {
	sr, err := s.loadSession(ctx, s.pool, id, false)
	if err != nil {
		return nil, err
	}
	var days int
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE regiment_id = $1::uuid`, sr.RegimentID).Scan(&days)
	v := &SessionView{
		ID: sr.ID, RegimentID: sr.RegimentID, RegimentName: sr.RegimentName, DayIndex: sr.DayIndex, Days: days,
		Status: sr.Status, Timed: sr.Config.Timed, Feedback: sr.Config.Feedback, TimeLimitSeconds: sr.TimeLimit,
		ElapsedMs: sr.ElapsedMs, Running: sr.Running, FocusLosses: sr.FocusLosses, CurrentPosition: sr.CurrentPos,
		ServerNow: time.Now().UTC().Format(time.RFC3339Nano), LLM: s.llmActive(ctx), Preset: sr.Config.Preset,
	}
	// A paused timed session hands out no question text at all: the client cannot peek at what it never received.
	withhold := sr.Config.Timed && sr.Status == "in_progress" && !sr.Running
	items, err := s.itemViews(ctx, `si.session_id = $1::uuid`, id)
	if err != nil {
		return nil, err
	}
	for i := range items {
		it := &items[i]
		revealed := sr.Status == "completed" || (sr.Config.Feedback == "immediate" && it.Status == "submitted")
		if !revealed {
			it.Reveal = nil
			it.Grade = nil
			it.Score, it.Potential = nil, nil
		}
		if withhold && it.Status == "open" {
			it.Question = nil
			it.Withheld = true
		}
	}
	v.Items = items
	return v, nil
}

// itemViews loads items with their questions. Reveal is always filled; callers strip it when not due.
func (s *Server) itemViews(ctx context.Context, where string, args ...any) ([]ItemView, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT si.id::text, si.position, si.question_id, si.gen_status, si.variant, si.shuffle, si.response, si.confidence,
		       si.time_spent_ms, si.submitted_at IS NOT NULL, si.skipped, si.score, si.potential, si.grade_status,
		       si.graded_by, si.grade_error, si.grade, q.body
		FROM session_items si LEFT JOIN questions q ON q.id = si.question_id
		WHERE `+where+` ORDER BY si.position`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ItemView{}
	for rows.Next() {
		var it ItemView
		var qid, variant *string
		var genStatus string
		var shuffle, response, grade, body []byte
		var submitted, skipped bool
		var score, potential *float32
		if err := rows.Scan(&it.ID, &it.Position, &qid, &genStatus, &variant, &shuffle, &response, &it.Confidence,
			&it.TimeSpentMs, &submitted, &skipped, &score, &potential, &it.GradeStatus, &it.GradedBy, &it.GradeError,
			&grade, &body); err != nil {
			return nil, err
		}
		switch {
		case skipped:
			it.Status = "skipped"
		case submitted:
			it.Status = "submitted"
		case qid == nil:
			it.Status = "generating"
		default:
			it.Status = "open"
		}
		if score != nil {
			v := float64(*score)
			it.Score = &v
		}
		if potential != nil {
			v := float64(*potential)
			it.Potential = &v
		}
		it.Response, it.Grade = response, grade
		if body != nil {
			var q Question
			if err := json.Unmarshal(body, &q); err == nil {
				var sh Shuffle
				_ = json.Unmarshal(shuffle, &sh)
				it.Question = publicQuestion(&q, deref(variant), sh)
				it.Reveal = reveal(&q, deref(variant))
			}
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Server) pauseSession(ctx context.Context, id string, running bool) (*SessionView, error) {
	var err error
	if running {
		_, err = s.pool.Exec(ctx, `UPDATE sessions SET running_since = now()
			WHERE id = $1::uuid AND status = 'in_progress' AND running_since IS NULL`, id)
	} else {
		_, err = s.pool.Exec(ctx, `UPDATE sessions SET running_since = NULL,
			elapsed_ms = elapsed_ms + (extract(epoch FROM now() - running_since) * 1000)::bigint
			WHERE id = $1::uuid AND status = 'in_progress' AND running_since IS NOT NULL`, id)
	}
	if err != nil {
		return nil, err
	}
	return s.sessionView(ctx, id)
}

func (s *Server) focusLost(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE sessions SET focus_losses = focus_losses + 1 WHERE id = $1::uuid AND status = 'in_progress'`, id)
	return err
}

type answerReq struct {
	Response    Response `json:"response"`
	Confidence  *int     `json:"confidence"`
	TimeSpentMs int64    `json:"timeSpentMs"`
}

func (s *Server) answerItem(ctx context.Context, itemID string, req answerReq) (*SessionView, error) {
	if req.Confidence != nil && (*req.Confidence < 1 || *req.Confidence > 3) {
		return nil, bad("confidence must be 1, 2 or 3")
	}
	if len(req.Response.Text) > 20_000 || len(req.Response.Comments) > 60 {
		return nil, bad("answer is too long")
	}
	if d := req.Response.Diagram; d != nil && (len(d.Nodes) > 80 || len(d.Edges) > 160) {
		return nil, bad("diagram is too large")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var sessionID string
	var position int
	var qid, variant *string
	var submitted bool
	err = tx.QueryRow(ctx, `SELECT session_id::text, position, question_id, variant, submitted_at IS NOT NULL
		FROM session_items WHERE id = $1::uuid FOR UPDATE`, itemID).Scan(&sessionID, &position, &qid, &variant, &submitted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	sr, err := s.loadSession(ctx, tx, sessionID, true)
	if err != nil {
		return nil, err
	}
	switch {
	case sr.Status != "in_progress":
		return nil, conflict{"this day is not in progress"}
	case sr.Config.Timed && !sr.Running:
		return nil, conflict{"the watch is paused: resume it to answer"}
	case sr.timeUp():
		return nil, conflict{"time is up"}
	case submitted:
		return nil, conflict{"already answered"}
	case qid == nil:
		return nil, conflict{"this question is still being written"}
	}
	q, err := s.loadQuestion(ctx, tx, *qid)
	if err != nil {
		return nil, err
	}
	score, auto := gradeAuto(q, deref(variant), req.Response)
	potential := calibratedPotential(score, req.Confidence)
	status, by := "graded", "auto"
	if q.isOpen() {
		switch {
		case s.llmActive(ctx):
			status, by = "pending", "llm"
		case q.Type == "free_text" || q.Type == "diagram":
			by = "heuristic"
		}
	}
	grade, _ := json.Marshal(Grade{Auto: auto})
	resp, _ := json.Marshal(req.Response)
	spent := max(0, min(req.TimeSpentMs, 6*3600*1000))
	if _, err := tx.Exec(ctx, `UPDATE session_items SET response = $2::jsonb, confidence = $3, time_spent_ms = $4,
		submitted_at = now(), score = $5, potential = $6, grade = $7::jsonb, grade_status = $8, graded_by = $9
		WHERE id = $1::uuid`, itemID, string(resp), req.Confidence, spent, score, potential, string(grade), status, by); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE sessions SET current_position = GREATEST(current_position, $2) WHERE id = $1::uuid`,
		sessionID, position+1); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if status == "pending" {
		s.jobs.enqueue(job{kind: "grade", id: itemID})
	}
	return s.sessionView(ctx, sessionID)
}

func (s *Server) setVariant(ctx context.Context, itemID, lang string) (*SessionView, error) {
	var sessionID string
	var qid *string
	err := s.pool.QueryRow(ctx, `SELECT session_id::text, question_id FROM session_items WHERE id = $1::uuid AND submitted_at IS NULL`,
		itemID).Scan(&sessionID, &qid)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, conflict{"only unanswered questions can switch language"}
	}
	if err != nil {
		return nil, err
	}
	if qid == nil {
		return nil, conflict{"question not ready"}
	}
	q, err := s.loadQuestion(ctx, s.pool, *qid)
	if err != nil {
		return nil, err
	}
	if _, ok := q.Code[lang]; !ok {
		return nil, bad("no %s version of this question", lang)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE session_items SET variant = $2 WHERE id = $1::uuid`, itemID, lang); err != nil {
		return nil, err
	}
	return s.sessionView(ctx, sessionID)
}

// selfGrade lets the user score an open answer against the rubric's key points (the offline path,
// or a correction when they disagree with the heuristic).
func (s *Server) selfGrade(ctx context.Context, itemID string, covered []int) (*SessionView, error) {
	var sessionID string
	var qid *string
	var conf *int
	var gradeRaw []byte
	var status string
	err := s.pool.QueryRow(ctx, `SELECT session_id::text, question_id, confidence, grade, grade_status FROM session_items
		WHERE id = $1::uuid AND submitted_at IS NOT NULL AND NOT skipped`, itemID).Scan(&sessionID, &qid, &conf, &gradeRaw, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if status == "pending" {
		return nil, conflict{"the model is still grading this answer"}
	}
	q, err := s.loadQuestion(ctx, s.pool, deref(qid))
	if err != nil {
		return nil, err
	}
	if q.Rubric == nil || len(q.Rubric.KeyPoints) == 0 {
		return nil, bad("this question has no rubric to self-grade against")
	}
	valid := []int{}
	for _, i := range covered {
		if i >= 0 && i < len(q.Rubric.KeyPoints) {
			valid = append(valid, i)
		}
	}
	var g Grade
	_ = json.Unmarshal(gradeRaw, &g)
	g.Self = &SelfGrade{Covered: valid}
	score := float64(len(valid)) / float64(len(q.Rubric.KeyPoints))
	if q.isCode() && g.Auto != nil && g.Auto.Detection != nil {
		score = 0.6**g.Auto.Detection + 0.4*score
	}
	raw, _ := json.Marshal(g)
	if _, err := s.pool.Exec(ctx, `UPDATE session_items SET score = $2, potential = $3, grade = $4::jsonb, graded_by = 'self',
		grade_status = 'graded' WHERE id = $1::uuid`, itemID, score, calibratedPotential(score, conf), string(raw)); err != nil {
		return nil, err
	}
	s.afterGrade(ctx, sessionID)
	return s.sessionView(ctx, sessionID)
}

func (s *Server) regrade(ctx context.Context, itemID string) error {
	if !s.llmActive(ctx) {
		return errLLMOff
	}
	tag, err := s.pool.Exec(ctx, `UPDATE session_items si SET grade_status = 'pending', grade_error = NULL
		FROM questions q WHERE si.id = $1::uuid AND q.id = si.question_id AND si.submitted_at IS NOT NULL AND NOT si.skipped
		AND q.type IN ('free_text', 'diagram', 'code_review', 'bug_hunt')`, itemID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return bad("only answered open questions can be regraded")
	}
	s.jobs.enqueue(job{kind: "grade", id: itemID})
	return nil
}

func (s *Server) finishSession(ctx context.Context, id string) (*SessionView, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	sr, err := s.loadSession(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	if sr.Status != "in_progress" {
		return nil, conflict{"this day is not in progress"}
	}
	if _, err := tx.Exec(ctx, `UPDATE session_items SET skipped = true, submitted_at = now(), score = 0, potential = 0.2,
		grade_status = 'graded', graded_by = 'auto', gen_status = CASE WHEN gen_status = 'pending' THEN 'failed' ELSE gen_status END
		WHERE session_id = $1::uuid AND submitted_at IS NULL`, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE sessions SET status = 'completed', completed_at = now(),
		elapsed_ms = elapsed_ms + COALESCE((extract(epoch FROM now() - running_since) * 1000)::bigint, 0), running_since = NULL
		WHERE id = $1::uuid`, id); err != nil {
		return nil, err
	}
	var remaining int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE regiment_id = $1::uuid AND status <> 'completed'`,
		sr.RegimentID).Scan(&remaining); err != nil {
		return nil, err
	}
	if remaining == 0 {
		if _, err := tx.Exec(ctx, `UPDATE regiments SET status = 'completed', completed_at = now() WHERE id = $1::uuid`, sr.RegimentID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if err := s.refreshReport(ctx, sr.RegimentID, remaining == 0); err != nil {
		return nil, err
	}
	return s.sessionView(ctx, id)
}

// afterGrade refreshes the report of a regiment whose items were (re)graded after the fact.
func (s *Server) afterGrade(ctx context.Context, sessionID string) {
	var regimentID, status string
	if err := s.pool.QueryRow(ctx, `SELECT r.id::text, r.status FROM sessions se JOIN regiments r ON r.id = se.regiment_id
		WHERE se.id = $1::uuid`, sessionID).Scan(&regimentID, &status); err != nil {
		return
	}
	_ = s.refreshReport(ctx, regimentID, false)
}
