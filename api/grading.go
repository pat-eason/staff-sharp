package main

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Response shapes sent by the browser, one per question type.
type Response struct {
	Selected []string    `json:"selected,omitempty"` // mcq, multi
	Value    *float64    `json:"value,omitempty"`    // numeric
	Order    []string    `json:"order,omitempty"`    // ordering
	Text     string      `json:"text,omitempty"`     // free_text, and overall notes for diagram/code
	Comments []Comment   `json:"comments,omitempty"` // code_review, bug_hunt
	Diagram  *Diagram    `json:"diagram,omitempty"`  // diagram
}

type Comment struct {
	Line     int    `json:"line"`
	Text     string `json:"text"`
	Severity string `json:"severity,omitempty"`
}

type Diagram struct {
	Nodes []DiagramNode `json:"nodes"`
	Edges []DiagramEdge `json:"edges"`
}

type DiagramNode struct {
	ID    string  `json:"id"`
	Type  string  `json:"type"`
	Label string  `json:"label"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

type DiagramEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label"`
}

// Grade is stored in session_items.grade. Auto holds the deterministic findings, LLM the model's
// verdict and Self the user's self-assessment.
type Grade struct {
	Auto *AutoGrade      `json:"auto,omitempty"`
	LLM  json.RawMessage `json:"llm,omitempty"`
	Self *SelfGrade      `json:"self,omitempty"`
}

type AutoGrade struct {
	Correct          *bool    `json:"correct,omitempty"`
	Ratio            *float64 `json:"ratio,omitempty"`            // numeric
	Tau              *float64 `json:"tau,omitempty"`              // ordering
	FoundIssues      []string `json:"foundIssues,omitempty"`      // code
	MissedIssues     []string `json:"missedIssues,omitempty"`     // code
	FalseFlags       []int    `json:"falseFlags,omitempty"`       // code: lines flagged that match no issue
	Detection        *float64 `json:"detection,omitempty"`        // code: severity-weighted share found
	ComponentsFound  []string `json:"componentsFound,omitempty"`  // diagram
	ComponentsMissed []string `json:"componentsMissed,omitempty"` // diagram
	KeyPointsCovered []int    `json:"keyPointsCovered,omitempty"` // heuristic keyword match
	Heuristic        bool     `json:"heuristic,omitempty"`
}

type SelfGrade struct {
	Covered []int `json:"covered"`
}

func ptr[T any](v T) *T { return &v }

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// calibratedPotential turns a score and the stated confidence (1 guess, 2 fairly sure, 3 certain) into
// a potential estimate: a hedged miss shows awareness, a confident miss is a blind spot.
func calibratedPotential(score float64, confidence *int) float64 {
	if confidence == nil {
		return score
	}
	c := *confidence
	switch {
	case score >= 0.7:
		return []float64{0, 0.75, 0.9, 1}[c] * (0.7 + 0.3*score)
	case score >= 0.3:
		return clamp01(score + 0.1)
	default:
		return []float64{0, 0.45, 0.3, 0.1}[c]
	}
}

var severityWeight = map[string]float64{"critical": 3, "major": 2, "minor": 1}

// gradeAuto computes everything that needs no judgment. For open questions the returned score is
// provisional (heuristic) until the LLM or the user's self-assessment replaces it.
func gradeAuto(q *Question, variant string, r Response) (score float64, auto *AutoGrade) {
	auto = &AutoGrade{}
	switch q.Type {
	case "mcq":
		ok := len(r.Selected) == 1 && slices.Contains(q.Answer, r.Selected[0])
		auto.Correct = &ok
		if ok {
			score = 1
		}
	case "multi":
		var tp, fp float64
		for _, s := range r.Selected {
			if slices.Contains(q.Answer, s) {
				tp++
			} else {
				fp++
			}
		}
		score = clamp01((tp - fp) / float64(len(q.Answer)))
		ok := tp == float64(len(q.Answer)) && fp == 0
		auto.Correct = &ok
	case "numeric":
		if r.Value != nil && *r.Value > 0 && q.Numeric != nil {
			ratio := math.Max(*r.Value/q.Numeric.Answer, q.Numeric.Answer / *r.Value)
			auto.Ratio = &ratio
			full, zero := q.Numeric.FullCreditRatio, q.Numeric.ZeroCreditRatio
			switch {
			case ratio <= full:
				score = 1
			case ratio >= zero:
				score = 0
			default:
				score = 1 - (ratio-full)/(zero-full)
			}
			ok := ratio <= full
			auto.Correct = &ok
		}
	case "ordering":
		tau := kendallTau(q.Items, r.Order)
		auto.Tau = &tau
		score = clamp01(tau)
		ok := tau >= 0.999
		auto.Correct = &ok
	case "code_review", "bug_hunt":
		lines := q.IssueLines[variant]
		var total, found float64
		matchedLine := map[int]bool{}
		for _, is := range q.Issues {
			w := severityWeight[is.Severity]
			total += w
			hit := false
			for _, c := range r.Comments {
				for _, l := range lines[is.ID] {
					if abs(c.Line-l) <= 1 {
						hit = true
						matchedLine[c.Line] = true
					}
				}
			}
			if hit {
				found += w
				auto.FoundIssues = append(auto.FoundIssues, is.ID)
			} else {
				auto.MissedIssues = append(auto.MissedIssues, is.ID)
			}
		}
		for _, c := range r.Comments {
			if !matchedLine[c.Line] && !slices.Contains(auto.FalseFlags, c.Line) {
				auto.FalseFlags = append(auto.FalseFlags, c.Line)
			}
		}
		det := 0.0
		if total > 0 {
			det = found / total
		}
		auto.Detection = &det
		penalty := 0.05
		if q.Type == "bug_hunt" {
			penalty = 0.12
		}
		score = clamp01(det - penalty*float64(len(auto.FalseFlags)))
	case "diagram":
		cov := componentCoverage(q, r.Diagram, auto)
		text := r.Text + " " + diagramText(r.Diagram)
		kp := keywordCoverage(q.Rubric.KeyPoints, text, auto)
		score = 0.5*cov + 0.5*kp
		auto.Heuristic = true
	case "free_text":
		score = keywordCoverage(q.Rubric.KeyPoints, r.Text, auto)
		auto.Heuristic = true
	}
	return score, auto
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// kendallTau compares the given order with the correct order: 1 identical, 0 random, -1 reversed.
func kendallTau(correct []Option, given []string) float64 {
	rank := map[string]int{}
	for i, it := range correct {
		rank[it.ID] = i
	}
	var seq []int
	for _, id := range given {
		if r, ok := rank[id]; ok {
			seq = append(seq, r)
		}
	}
	n := len(seq)
	if n < 2 || n != len(correct) {
		return 0
	}
	var conc, disc float64
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if seq[i] < seq[j] {
				conc++
			} else {
				disc++
			}
		}
	}
	return (conc - disc) / (conc + disc)
}

func componentCoverage(q *Question, d *Diagram, auto *AutoGrade) float64 {
	if q.Rubric == nil || len(q.Rubric.RequiredComponents) == 0 {
		return 1
	}
	have := map[string]bool{}
	if d != nil {
		for _, n := range d.Nodes {
			have[n.Type] = true
		}
	}
	for _, req := range q.Rubric.RequiredComponents {
		ok := false
		for _, alt := range strings.Split(req, "|") {
			if have[alt] {
				ok = true
			}
		}
		if ok {
			auto.ComponentsFound = append(auto.ComponentsFound, req)
		} else {
			auto.ComponentsMissed = append(auto.ComponentsMissed, req)
		}
	}
	return float64(len(auto.ComponentsFound)) / float64(len(q.Rubric.RequiredComponents))
}

func diagramText(d *Diagram) string {
	if d == nil {
		return ""
	}
	var b strings.Builder
	label := map[string]string{}
	for _, n := range d.Nodes {
		label[n.ID] = fmt.Sprintf("%s (%s)", n.Label, n.Type)
	}
	for _, n := range d.Nodes {
		fmt.Fprintf(&b, "- node %s: %s\n", n.ID, label[n.ID])
	}
	for _, e := range d.Edges {
		fmt.Fprintf(&b, "- %s -> %s", label[e.Source], label[e.Target])
		if e.Label != "" {
			fmt.Fprintf(&b, " [%s]", e.Label)
		}
		b.WriteString("\n")
	}
	return b.String()
}

var wordRe = regexp.MustCompile(`[a-z0-9][a-z0-9+#.-]*`)

var stopwords = map[string]bool{
	"about": true, "after": true, "again": true, "because": true, "before": true, "being": true, "between": true,
	"could": true, "every": true, "explains": true, "mentions": true, "should": true, "states": true, "their": true,
	"there": true, "these": true, "those": true, "under": true, "using": true, "where": true, "which": true,
	"while": true, "would": true, "names": true, "without": true, "within": true, "other": true, "rather": true,
}

func stems(text string) []string {
	var out []string
	for _, w := range wordRe.FindAllString(strings.ToLower(text), -1) {
		w = strings.TrimRight(w, ".-")
		if len(w) < 4 || stopwords[w] {
			continue
		}
		if len(w) > 6 {
			w = w[:6]
		}
		out = append(out, w)
	}
	return out
}

// keywordCoverage is the offline fallback: a key point counts as covered when enough of its
// distinctive words appear in the answer. Crude on purpose; it is labelled as a heuristic in the UI.
func keywordCoverage(points []string, answer string, auto *AutoGrade) float64 {
	if len(points) == 0 {
		return 0
	}
	have := map[string]bool{}
	for _, s := range stems(answer) {
		have[s] = true
	}
	covered := 0
	for i, p := range points {
		ws := stems(p)
		if len(ws) == 0 {
			continue
		}
		hit := 0
		for _, w := range ws {
			if have[w] {
				hit++
			}
		}
		if float64(hit)/float64(len(ws)) >= 0.4 {
			covered++
			auto.KeyPointsCovered = append(auto.KeyPointsCovered, i)
		}
	}
	return float64(covered) / float64(len(points))
}

// ---------------------------------------------------------------- views

type PublicQuestion struct {
	ID           string   `json:"id"`
	Domain       string   `json:"domain"`
	Concepts     []string `json:"concepts"`
	Skill        string   `json:"skill"`
	Type         string   `json:"type"`
	Difficulty   int      `json:"difficulty"`
	Title        string   `json:"title"`
	Prompt       string   `json:"prompt"`
	Context      string   `json:"context,omitempty"`
	Language     *string  `json:"language"`
	EstSeconds   int      `json:"estSeconds"`
	Options      []Option `json:"options,omitempty"`
	Items        []Option `json:"items,omitempty"`
	Unit         string   `json:"unit,omitempty"`
	Code         string   `json:"code,omitempty"`
	CodeLanguage string   `json:"codeLanguage,omitempty"`
	CodeVariants []string `json:"codeVariants,omitempty"`
	Source       string   `json:"source"`
}

type Shuffle struct {
	Options []string `json:"options,omitempty"`
	Items   []string `json:"items,omitempty"`
}

func reorder(list []Option, order []string) []Option {
	if len(order) != len(list) {
		return list
	}
	byID := map[string]Option{}
	for _, o := range list {
		byID[o.ID] = o
	}
	out := make([]Option, 0, len(list))
	for _, id := range order {
		if o, ok := byID[id]; ok {
			out = append(out, o)
		}
	}
	if len(out) != len(list) {
		return list
	}
	return out
}

func publicQuestion(q *Question, variant string, sh Shuffle) *PublicQuestion {
	pq := &PublicQuestion{
		ID: q.ID, Domain: q.Domain, Concepts: q.Concepts, Skill: q.Skill, Type: q.Type, Difficulty: q.Difficulty,
		Title: q.Title, Prompt: q.Prompt, Context: q.Context, Language: q.Language, EstSeconds: q.EstSeconds, Source: q.Source,
	}
	switch q.Type {
	case "mcq", "multi":
		pq.Options = reorder(q.Options, sh.Options)
	case "ordering":
		pq.Items = reorder(q.Items, sh.Items)
	case "numeric":
		pq.Unit = q.Numeric.Unit
	case "code_review", "bug_hunt":
		pq.Code = q.Code[variant]
		pq.CodeLanguage = variant
		for _, l := range []string{"ts", "go", "rust", "csharp", "java"} {
			if _, ok := q.Code[l]; ok {
				pq.CodeVariants = append(pq.CodeVariants, l)
			}
		}
	}
	return pq
}

// Reveal is the answer key, sent only once an item is submitted and feedback is due.
type Reveal struct {
	Answer      []string          `json:"answer,omitempty"`
	OptionNotes map[string]string `json:"optionNotes,omitempty"`
	Order       []Option          `json:"order,omitempty"`
	Numeric     *NumericSpec      `json:"numeric,omitempty"`
	Rubric      *Rubric           `json:"rubric,omitempty"`
	Issues      []RevealIssue     `json:"issues,omitempty"`
	Explanation string            `json:"explanation"`
	References  []string          `json:"references,omitempty"`
}

type RevealIssue struct {
	Issue
	Lines []int `json:"lines"`
}

func reveal(q *Question, variant string) *Reveal {
	rv := &Reveal{Answer: q.Answer, OptionNotes: q.OptionNotes, Numeric: q.Numeric, Rubric: q.Rubric,
		Explanation: q.Explanation, References: q.References}
	if q.Type == "ordering" {
		rv.Order = q.Items
	}
	for _, is := range q.Issues {
		lines := slices.Clone(q.IssueLines[variant][is.ID])
		sort.Ints(lines)
		rv.Issues = append(rv.Issues, RevealIssue{Issue: is, Lines: lines})
	}
	return rv
}

// pickVariant returns the code variant shown to the user: their primary language when available.
func pickVariant(q *Question, p Profile) string {
	if len(q.Code) == 0 {
		return ""
	}
	for _, l := range append([]string{p.PrimaryLanguage}, p.ExtraLanguages...) {
		if _, ok := q.Code[l]; ok {
			return l
		}
	}
	for _, l := range []string{"ts", "go", "java", "csharp", "rust"} {
		if _, ok := q.Code[l]; ok {
			return l
		}
	}
	return ""
}
