package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed seed
var seedFS embed.FS

var issueMarker = regexp.MustCompile(`\s*//!issue:([A-Za-z0-9_,-]+)\s*$`)

func loadTaxonomy() (*Taxonomy, error) {
	raw, err := seedFS.ReadFile("seed/domains.json")
	if err != nil {
		return nil, err
	}
	var t Taxonomy
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("domains.json: %w", err)
	}
	return &t, nil
}

func (t *Taxonomy) hasDomain(k string) bool {
	return slices.ContainsFunc(t.Domains, func(d Domain) bool { return d.Key == k })
}

func (t *Taxonomy) hasKey(list []KeyName, k string) bool {
	return slices.ContainsFunc(list, func(x KeyName) bool { return x.Key == k })
}

func (t *Taxonomy) domainName(k string) string {
	for _, d := range t.Domains {
		if d.Key == k {
			return d.Name
		}
	}
	return k
}

// prepareCode strips the //!issue markers from every variant and records the marked line numbers.
func prepareCode(q *Question) {
	if len(q.Code) == 0 {
		return
	}
	q.IssueLines = map[string]map[string][]int{}
	for lang, src := range q.Code {
		lines := strings.Split(src, "\n")
		byIssue := map[string][]int{}
		for i, line := range lines {
			if m := issueMarker.FindStringSubmatch(line); m != nil {
				for _, id := range strings.Split(m[1], ",") {
					byIssue[id] = append(byIssue[id], i+1)
				}
				lines[i] = issueMarker.ReplaceAllString(line, "")
			}
		}
		q.Code[lang] = strings.Join(lines, "\n")
		q.IssueLines[lang] = byIssue
	}
}

// validateQuestion applies the bank rules (a lighter version of scripts/validate-questions.mjs).
// Generated questions go through the same check before they are stored.
func validateQuestion(t *Taxonomy, q *Question) error {
	switch {
	case q.ID == "":
		return fmt.Errorf("missing id")
	case !t.hasDomain(q.Domain):
		return fmt.Errorf("unknown domain %q", q.Domain)
	case !t.hasKey(t.Skills, q.Skill):
		return fmt.Errorf("unknown skill %q", q.Skill)
	case !t.hasKey(t.Types, q.Type):
		return fmt.Errorf("unknown type %q", q.Type)
	case q.Difficulty < 1 || q.Difficulty > 5:
		return fmt.Errorf("difficulty out of range")
	case strings.TrimSpace(q.Title) == "" || strings.TrimSpace(q.Prompt) == "":
		return fmt.Errorf("title and prompt are required")
	case q.Language != nil && !t.hasKey(t.Languages, *q.Language):
		return fmt.Errorf("unknown language")
	}
	if len(q.Concepts) == 0 {
		q.Concepts = []string{"general"}
	}
	if q.EstSeconds <= 0 {
		q.EstSeconds = 120
	}
	switch q.Type {
	case "mcq", "multi":
		if len(q.Options) < 3 {
			return fmt.Errorf("needs at least 3 options")
		}
		ids := map[string]bool{}
		for _, o := range q.Options {
			ids[o.ID] = true
		}
		if len(q.Answer) == 0 {
			return fmt.Errorf("answer missing")
		}
		for _, a := range q.Answer {
			if !ids[a] {
				return fmt.Errorf("answer %q is not an option", a)
			}
		}
		if q.Type == "mcq" && len(q.Answer) != 1 {
			return fmt.Errorf("mcq needs exactly one answer")
		}
	case "numeric":
		if q.Numeric == nil || q.Numeric.Answer <= 0 || q.Numeric.FullCreditRatio < 1 || q.Numeric.ZeroCreditRatio <= q.Numeric.FullCreditRatio {
			return fmt.Errorf("bad numeric spec")
		}
	case "ordering":
		if len(q.Items) < 3 {
			return fmt.Errorf("ordering needs 3+ items")
		}
	case "free_text", "diagram":
		if q.Rubric == nil || len(q.Rubric.KeyPoints) == 0 {
			return fmt.Errorf("rubric.keyPoints required")
		}
	case "code_review", "bug_hunt":
		if len(q.Code) == 0 || len(q.Issues) == 0 {
			return fmt.Errorf("code and issues required")
		}
		for lang, byIssue := range q.IssueLines {
			for _, is := range q.Issues {
				if len(byIssue[is.ID]) == 0 {
					return fmt.Errorf("%s: issue %s has no marked lines", lang, is.ID)
				}
			}
		}
	}
	return nil
}

func hashQuestion(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func upsertQuestion(ctx context.Context, db dbtx, q *Question) (changed bool, err error) {
	body, err := json.Marshal(q)
	if err != nil {
		return false, err
	}
	tag, err := db.Exec(ctx, `
		INSERT INTO questions (id, domain, concepts, skill, type, difficulty, language, title, est_seconds, body, source, content_hash)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
		ON CONFLICT (id) DO UPDATE SET
			domain = excluded.domain, concepts = excluded.concepts, skill = excluded.skill, type = excluded.type,
			difficulty = excluded.difficulty, language = excluded.language, title = excluded.title,
			est_seconds = excluded.est_seconds, body = excluded.body, content_hash = excluded.content_hash,
			active = true, updated_at = now()
		WHERE questions.content_hash <> excluded.content_hash OR NOT questions.active`,
		q.ID, q.Domain, q.Concepts, q.Skill, q.Type, q.Difficulty, q.Language, q.Title, q.EstSeconds, string(body), q.Source, hashQuestion(body))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// seedBank upserts every embedded bank question and retires bank questions that were removed.
// Invalid questions are skipped with a warning so one bad entry never blocks startup.
func seedBank(ctx context.Context, pool *pgxpool.Pool, t *Taxonomy) error {
	files, err := fs.Glob(seedFS, "seed/questions/*.json")
	if err != nil {
		return err
	}
	sort.Strings(files)
	seen := map[string]bool{}
	var total, changed, skipped int
	for _, f := range files {
		raw, err := seedFS.ReadFile(f)
		if err != nil {
			return err
		}
		var doc struct {
			Questions []Question `json:"questions"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			slog.Warn("skipping unreadable question file", "file", f, "error", err)
			continue
		}
		for i := range doc.Questions {
			q := &doc.Questions[i]
			q.Source = "bank"
			prepareCode(q)
			if err := validateQuestion(t, q); err != nil || seen[q.ID] {
				reason := "duplicate id"
				if err != nil {
					reason = err.Error()
				}
				slog.Warn("skipping invalid question", "file", f, "id", q.ID, "reason", reason)
				skipped++
				continue
			}
			seen[q.ID] = true
			c, err := upsertQuestion(ctx, pool, q)
			if err != nil {
				return fmt.Errorf("upsert %s: %w", q.ID, err)
			}
			total++
			if c {
				changed++
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	tag, err := pool.Exec(ctx, `UPDATE questions SET active = false WHERE source = 'bank' AND active AND NOT (id = ANY($1))`, ids)
	if err != nil {
		return err
	}
	slog.Info("question bank ready", "questions", total, "changed", changed, "skipped", skipped, "retired", tag.RowsAffected())
	return nil
}
