package main

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"sort"

	"github.com/jackc/pgx/v5"
)

// The first-run calibration: one closed question per domain at deliberately spread difficulties, about
// 15 minutes on the clock, graded without a model. Its results estimate the user's level and seed the
// star plot like any other regiment.

const calibrationPreset = "calibration"

var calibrationTypes = []string{"mcq", "multi", "numeric", "ordering"}

// Each level is sampled three times across the twelve domains.
var calibrationLevels = []int{5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2}

type CalibrationRef struct {
	RegimentID string `json:"regimentId"`
	SessionID  string `json:"sessionId"`
	Status     string `json:"status"` // pending | in_progress | completed
}

func (s *Server) latestCalibration(ctx context.Context) (*CalibrationRef, error) {
	var ref CalibrationRef
	err := s.pool.QueryRow(ctx, `
		SELECT r.id::text, se.id::text, se.status FROM regiments r JOIN sessions se ON se.regiment_id = r.id AND se.day_index = 1
		WHERE r.config->>'preset' = $1 ORDER BY r.created_at DESC LIMIT 1`, calibrationPreset).Scan(&ref.RegimentID, &ref.SessionID, &ref.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &ref, err
}

// startCalibration returns the unfinished calibration if there is one, else builds a new one.
func (s *Server) startCalibration(ctx context.Context) (*CalibrationRef, error) {
	if ref, err := s.latestCalibration(ctx); err != nil || (ref != nil && ref.Status != "completed") {
		return ref, err
	}
	p, err := s.getProfile(ctx)
	if err != nil {
		return nil, err
	}
	// Every closed question, in any language the user reads.
	all, err := s.candidates(ctx, RegimentConfig{Types: calibrationTypes, DifficultyMin: 1, DifficultyMax: 5}, p)
	if err != nil {
		return nil, err
	}
	ids := calibrationPlan(all, s.tax.Domains)
	if len(ids) == 0 {
		return nil, bad("the question bank has no closed questions to calibrate with")
	}
	r, err := s.createRegiment(ctx, createRegimentReq{
		Name:        "Calibration",
		Description: "One question per domain at mixed levels, about 15 minutes. Sets your starting level and star plot.",
		Config: RegimentConfig{QuestionIDs: ids, Days: 1, PerDay: len(ids), Timed: true, TimeLimitMinutes: 15, Feedback: "end",
			DifficultyMin: 1, DifficultyMax: 5, Preset: calibrationPreset},
	})
	if err != nil {
		return nil, err
	}
	return &CalibrationRef{RegimentID: r.ID, SessionID: r.Sessions[0].ID, Status: "pending"}, nil
}

// calibrationPlan gives each domain one target level. Principal-level closed questions are rare, so the
// hardest targets go first to the domains that actually have them; the rest are shuffled so no domain is
// always the easy one.
func calibrationPlan(all []candidate, domains []Domain) []string {
	hardest := map[string]int{}
	for _, c := range all {
		hardest[c.Domain] = max(hardest[c.Domain], c.Difficulty)
	}
	order := make([]Domain, len(domains))
	copy(order, domains)
	rand.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
	sort.SliceStable(order, func(i, j int) bool { return hardest[order[i].Key] > hardest[order[j].Key] })
	var ids []string
	for i, d := range order {
		if c, ok := pickCalibration(all, d.Key, calibrationLevels[i%len(calibrationLevels)]); ok {
			ids = append(ids, c.ID)
		}
	}
	// Present easiest first so the quiz warms up.
	level := map[string]int{}
	for _, c := range all {
		level[c.ID] = c.Difficulty
	}
	sort.SliceStable(ids, func(i, j int) bool { return level[ids[i]] < level[ids[j]] })
	return ids
}

// pickCalibration chooses the domain's question closest to the target level, preferring short ones so
// twelve fit in about fifteen minutes; ties are broken at random so a retake gets different questions.
func pickCalibration(all []candidate, domain string, target int) (candidate, bool) {
	var pool []candidate
	for _, c := range all {
		if c.Domain == domain {
			pool = append(pool, c)
		}
	}
	if len(pool) == 0 {
		return candidate{}, false
	}
	rand.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	cost := func(c candidate) int {
		gap := abs(c.Difficulty - target)
		slow := 0
		if c.Est > 100 {
			slow = 1
		}
		return gap*10 + slow*3 + c.Est/60 // a level off outweighs a slow question
	}
	sort.SliceStable(pool, func(i, j int) bool { return cost(pool[i]) < cost(pool[j]) })
	return pool[0], true
}

type CalibrationResult struct {
	RegimentID   string      `json:"regimentId"`
	Theta        float64     `json:"theta"` // ability on the 1-5 difficulty scale
	Level        string      `json:"level"`
	Confidence   string      `json:"confidence"` // low | medium | high, from how many questions were answered
	Answered     int         `json:"answered"`
	Accuracy     float64     `json:"accuracy"`
	ByDifficulty []Breakdown `json:"byDifficulty"`
	ByDomain     []Breakdown `json:"byDomain"`
	Strongest    []string    `json:"strongest"`
	Weakest      []string    `json:"weakest"`
}

// estimateTheta fits a one-parameter logistic model, p(score) = 1 / (1 + e^(-1.4(θ - d))), by grid
// search with partial credit as fractional outcomes and a weak prior in the middle of the staff band (θ = 3.5).
func estimateTheta(atts []attempt) float64 {
	best, bestLL := 3.0, math.Inf(-1)
	for theta := 1.0; theta <= 6.0001; theta += 0.05 {
		ll := -0.5 * math.Pow((theta-3.5)/1.2, 2) // prior centred on the staff band
		for _, a := range atts {
			p := 1 / (1 + math.Exp(-1.4*(theta-float64(a.Difficulty))))
			p = math.Min(math.Max(p, 1e-6), 1-1e-6)
			ll += a.Score*math.Log(p) + (1-a.Score)*math.Log(1-p)
		}
		if ll > bestLL {
			best, bestLL = theta, ll
		}
	}
	return math.Round(best*100) / 100
}

// levelFor maps ability to a level. Cutoffs were set against the model: only the senior-tier questions
// right ≈ 2.85, half right ≈ 3.5, all but the hardest ≈ 4.45, everything ≈ 5.75 (see onboarding_test.go).
func levelFor(theta float64) string {
	switch {
	case theta < 3.1:
		return "senior"
	case theta < 4.0:
		return "staff"
	case theta < 4.9:
		return "senior_staff"
	default:
		return "principal"
	}
}

func (s *Server) calibrationResult(ctx context.Context) (*CalibrationResult, error) {
	ref, err := s.latestCalibration(ctx)
	if err != nil {
		return nil, err
	}
	if ref == nil || ref.Status != "completed" {
		return nil, conflict{"finish the calibration quiz first"}
	}
	atts, err := s.loadAttempts(ctx, `AND se.regiment_id = $1::uuid`, ref.RegimentID)
	if err != nil {
		return nil, err
	}
	// Questions the clock ran out on are left out: the estimate measures knowledge, not reading speed.
	var answered []attempt
	for _, a := range atts {
		if !a.Skipped {
			answered = append(answered, a)
		}
	}
	res := &CalibrationResult{RegimentID: ref.RegimentID, Theta: estimateTheta(answered)}
	res.Level = levelFor(res.Theta)
	res.Answered = len(answered)
	for _, a := range answered {
		res.Accuracy += a.Score
	}
	if len(answered) > 0 {
		res.Accuracy /= float64(len(answered))
	}
	switch {
	case res.Answered >= 10:
		res.Confidence = "high"
	case res.Answered >= 6:
		res.Confidence = "medium"
	default:
		res.Confidence = "low"
	}
	res.ByDifficulty = breakdown(answered, func(a attempt) string { return string(rune('0' + a.Difficulty)) },
		func(k string) string { return []string{"", "Senior", "Strong senior", "Staff", "Senior staff", "Principal"}[k[0]-'0'] })
	sort.Slice(res.ByDifficulty, func(i, j int) bool { return res.ByDifficulty[i].Key < res.ByDifficulty[j].Key })
	res.ByDomain = breakdown(answered, func(a attempt) string { return a.Domain }, s.tax.domainName)
	for _, b := range res.ByDomain { // sorted ascending by accuracy
		if b.Accuracy < 0.5 && len(res.Weakest) < 3 {
			res.Weakest = append(res.Weakest, b.Key)
		}
	}
	for i := len(res.ByDomain) - 1; i >= 0 && len(res.Strongest) < 3; i-- {
		if res.ByDomain[i].Accuracy >= 0.8 {
			res.Strongest = append(res.Strongest, res.ByDomain[i].Key)
		}
	}
	return res, nil
}
