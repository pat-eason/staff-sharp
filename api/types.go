package main

import "encoding/json"

// ---------------------------------------------------------------- taxonomy

type Taxonomy struct {
	Domains    []Domain   `json:"domains"`
	Skills     []KeyName  `json:"skills"`
	Types      []KeyName  `json:"types"`
	Languages  []KeyName  `json:"languages"`
	Archetypes []KeyName  `json:"archetypes"`
	Components []KeyName  `json:"components"`
}

type Domain struct {
	Key      string   `json:"key"`
	Name     string   `json:"name"`
	Short    string   `json:"short"`
	Blurb    string   `json:"blurb"`
	Concepts []string `json:"concepts"`
}

type KeyName struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Blurb string `json:"blurb,omitempty"`
}

// ---------------------------------------------------------------- questions

type Option struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type NumericSpec struct {
	Answer          float64 `json:"answer"`
	Unit            string  `json:"unit"`
	FullCreditRatio float64 `json:"fullCreditRatio"`
	ZeroCreditRatio float64 `json:"zeroCreditRatio"`
}

type Rubric struct {
	KeyPoints          []string `json:"keyPoints"`
	RedFlags           []string `json:"redFlags,omitempty"`
	Exemplar           string   `json:"exemplar"`
	RequiredComponents []string `json:"requiredComponents,omitempty"`
}

type Issue struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Summary  string `json:"summary"`
	Fix      string `json:"fix"`
}

// Question is the full question including its answer key. It is stored as JSONB in questions.body
// and never sent to the browser before the item is submitted (see publicQuestion).
type Question struct {
	ID          string            `json:"id"`
	Domain      string            `json:"domain"`
	Concepts    []string          `json:"concepts"`
	Skill       string            `json:"skill"`
	Type        string            `json:"type"`
	Difficulty  int               `json:"difficulty"`
	Title       string            `json:"title"`
	Prompt      string            `json:"prompt"`
	Context     string            `json:"context,omitempty"`
	Language    *string           `json:"language"`
	EstSeconds  int               `json:"estSeconds"`
	Explanation string            `json:"explanation"`
	References  []string          `json:"references,omitempty"`
	Tags        []string          `json:"tags,omitempty"`
	Options     []Option          `json:"options,omitempty"`
	Answer      []string          `json:"answer,omitempty"`
	OptionNotes map[string]string `json:"optionNotes,omitempty"`
	Numeric     *NumericSpec      `json:"numeric,omitempty"`
	Items       []Option          `json:"items,omitempty"`
	Rubric      *Rubric           `json:"rubric,omitempty"`
	Code        map[string]string `json:"code,omitempty"`
	Issues      []Issue           `json:"issues,omitempty"`
	// IssueLines is derived when loading: language -> issue id -> 1-based line numbers.
	IssueLines map[string]map[string][]int `json:"issueLines,omitempty"`
	Source     string                      `json:"source,omitempty"`
}

func (q *Question) Lang() string {
	if q.Language == nil {
		return ""
	}
	return *q.Language
}

func (q *Question) isCode() bool { return q.Type == "code_review" || q.Type == "bug_hunt" }

// isOpen reports whether grading the question needs judgment (LLM, heuristic or self-assessment).
func (q *Question) isOpen() bool {
	return q.Type == "free_text" || q.Type == "diagram" || q.isCode()
}

// ---------------------------------------------------------------- profile

type Profile struct {
	DisplayName     string   `json:"displayName"`
	PrimaryLanguage string   `json:"primaryLanguage"`
	ExtraLanguages  []string `json:"extraLanguages"`
	FocalDomains    []string `json:"focalDomains"`
	PrimaryFocus    string   `json:"primaryFocus"`
	Archetype       string   `json:"archetype"`
	Level           string   `json:"level"`
	YearsExperience int      `json:"yearsExperience"`
	Goal            string   `json:"goal"`
	Stack           string   `json:"stack"`
	Context         string   `json:"context"`
	WeeklyMinutes   int      `json:"weeklyMinutes"`
	Onboarded       bool     `json:"onboarded"`
}

// ---------------------------------------------------------------- regiments

type RegimentConfig struct {
	Domains          []string           `json:"domains"`          // empty = all
	DomainWeights    map[string]float64 `json:"domainWeights"`    // optional extra weights
	Types            []string           `json:"types"`            // empty = all
	DifficultyMin    int                `json:"difficultyMin"`    // 1-5
	DifficultyMax    int                `json:"difficultyMax"`    // 1-5
	Days             int                `json:"days"`             // 1-30
	PerDay           int                `json:"perDay"`           // 1-40
	Timed            bool               `json:"timed"`
	TimeLimitMinutes int                `json:"timeLimitMinutes"` // per day; 0 = auto from estimates
	Feedback         string             `json:"feedback"`         // immediate | end
	Adaptive         bool               `json:"adaptive"`         // weight toward weak domains
	GeneratedPerDay  int                `json:"generatedPerDay"`  // LLM-written scenarios per day
	QuestionIDs      []string           `json:"questionIds"`      // pin exact questions (drills)
	FocusConcepts    []string           `json:"focusConcepts"`    // optional concept boost
	Preset           string             `json:"preset"`
}

type Regiment struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Config         RegimentConfig  `json:"config"`
	Status         string          `json:"status"`
	Report         json.RawMessage `json:"report"`
	Debrief        json.RawMessage `json:"debrief"`
	DebriefStatus  string          `json:"debriefStatus"`
	DebriefError   *string         `json:"debriefError"`
	CreatedAt      string          `json:"createdAt"`
	CompletedAt    *string         `json:"completedAt"`
	Sessions       []SessionSummary `json:"sessions"`
	DaysCompleted  int             `json:"daysCompleted"`
	Accuracy       *float64        `json:"accuracy"`
	Potential      *float64        `json:"potential"`
}

type SessionSummary struct {
	ID               string   `json:"id"`
	DayIndex         int      `json:"dayIndex"`
	ScheduledFor     *string  `json:"scheduledFor"`
	Status           string   `json:"status"`
	TimeLimitSeconds *int     `json:"timeLimitSeconds"`
	ElapsedMs        int64    `json:"elapsedMs"`
	ItemCount        int      `json:"itemCount"`
	Answered         int      `json:"answered"`
	Accuracy         *float64 `json:"accuracy"`
	StartedAt        *string  `json:"startedAt"`
	CompletedAt      *string  `json:"completedAt"`
}
