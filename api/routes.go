package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	pool          *pgxpool.Pool
	store         *Store
	cfg           *Config
	tax           *Taxonomy
	agent         *AgentClient // Flue service (Anthropic API key)
	runner        *AgentClient // Claude Code runner (subscription)
	jobs          *Jobs
	llmSem        chan struct{}
	internalToken string
}

// detached keeps LLM-backed work alive when the browser disconnects.
func detached(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(r.Context()), d)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	h := s.handle

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Internal: the Flue agent fetches its config (with the API key) here. Not proxied by nginx.
	mux.HandleFunc("GET /internal/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-internal-token") != s.internalToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		cfg, err := s.cfg.Agent(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	})

	mux.HandleFunc("GET /api/meta", h(func(r *http.Request) (any, error) {
		type count struct {
			Domain string `json:"domain"`
			Type   string `json:"type"`
			N      int    `json:"n"`
		}
		rows, err := s.pool.Query(r.Context(), `SELECT domain, type, count(*) FROM questions WHERE active AND source = 'bank' GROUP BY 1, 2`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var counts []count
		total := 0
		for rows.Next() {
			var c count
			if err := rows.Scan(&c.Domain, &c.Type, &c.N); err != nil {
				return nil, err
			}
			total += c.N
			counts = append(counts, c)
		}
		st, _ := s.cfg.Get(r.Context())
		return map[string]any{"taxonomy": s.tax, "bank": map[string]any{"total": total, "counts": counts},
			"llm": map[string]any{"active": s.llmActive(r.Context()), "provider": st.LLMProvider}}, nil
	}))

	// ---- profile
	mux.HandleFunc("GET /api/profile", h(func(r *http.Request) (any, error) { return s.getProfile(r.Context()) }))
	mux.HandleFunc("PUT /api/profile", h(func(r *http.Request) (any, error) {
		var p Profile
		if err := decode(r, &p); err != nil {
			return nil, err
		}
		return s.putProfile(r.Context(), p)
	}))
	mux.HandleFunc("GET /api/profile/stats", h(func(r *http.Request) (any, error) { return s.profileStats(r.Context()) }))
	mux.HandleFunc("GET /api/profile/insight", h(func(r *http.Request) (any, error) { return s.latestInsight(r.Context()) }))
	mux.HandleFunc("POST /api/profile/insight", h(func(r *http.Request) (any, error) {
		ctx, cancel := detached(r, 5*time.Minute)
		defer cancel()
		return s.generateInsight(ctx)
	}))

	// ---- settings
	mux.HandleFunc("GET /api/settings", h(func(r *http.Request) (any, error) { return s.cfg.View(r.Context()) }))
	mux.HandleFunc("PUT /api/settings", h(func(r *http.Request) (any, error) {
		var p settingsPatch
		if err := decode(r, &p); err != nil {
			return nil, err
		}
		if _, err := s.cfg.Patch(r.Context(), p); err != nil {
			return nil, err
		}
		return s.cfg.View(r.Context())
	}))
	mux.HandleFunc("POST /api/settings/test", h(func(r *http.Request) (any, error) {
		st, err := s.cfg.Get(r.Context())
		if err != nil {
			return nil, err
		}
		var reply string
		switch st.LLMProvider {
		case providerAPIKey:
			reply, err = s.cfg.TestKey(r.Context())
		case providerClaudeCode:
			cfg, _ := s.cfg.Agent(r.Context())
			cfg.APIKey = ""
			reply, err = s.runner.Test(r.Context(), cfg)
		default:
			return nil, errLLMOff
		}
		if err != nil {
			return nil, err
		}
		return map[string]string{"reply": reply}, nil
	}))
	s.registerClaudeRoutes(mux)

	// ---- insights history and the answer ledger
	mux.HandleFunc("GET /api/history", h(func(r *http.Request) (any, error) { return s.history(r.Context()) }))
	mux.HandleFunc("GET /api/ledger", h(func(r *http.Request) (any, error) { return s.ledger(r) }))

	// ---- first-run calibration
	mux.HandleFunc("GET /api/onboarding", h(func(r *http.Request) (any, error) {
		ref, err := s.latestCalibration(r.Context())
		return map[string]any{"calibration": ref}, err
	}))
	mux.HandleFunc("POST /api/onboarding/calibration", h(func(r *http.Request) (any, error) { return s.startCalibration(r.Context()) }))
	mux.HandleFunc("GET /api/onboarding/result", h(func(r *http.Request) (any, error) { return s.calibrationResult(r.Context()) }))

	// ---- display preferences
	mux.HandleFunc("GET /api/preferences", h(func(r *http.Request) (any, error) { return s.getPreferences(r.Context()) }))
	mux.HandleFunc("PUT /api/preferences", h(func(r *http.Request) (any, error) {
		var p Preferences
		if err := decode(r, &p); err != nil {
			return nil, err
		}
		return s.putPreferences(r.Context(), p)
	}))

	// ---- question library
	mux.HandleFunc("GET /api/questions", h(func(r *http.Request) (any, error) { return s.listQuestions(r) }))

	// ---- regiments
	mux.HandleFunc("GET /api/regiments", h(func(r *http.Request) (any, error) { return s.listRegiments(r.Context()) }))
	mux.HandleFunc("POST /api/regiments", h(func(r *http.Request) (any, error) {
		var req createRegimentReq
		if err := decode(r, &req); err != nil {
			return nil, err
		}
		return s.createRegiment(r.Context(), req)
	}))
	mux.HandleFunc("POST /api/regiments/preview", h(func(r *http.Request) (any, error) {
		var cfg RegimentConfig
		if err := decode(r, &cfg); err != nil {
			return nil, err
		}
		return s.previewConfig(r.Context(), cfg)
	}))
	mux.HandleFunc("POST /api/regiments/recommend", h(func(r *http.Request) (any, error) { return s.recommendRegiment(r.Context()) }))
	mux.HandleFunc("GET /api/regiments/{id}", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		return s.getRegiment(r.Context(), id)
	}))
	mux.HandleFunc("DELETE /api/regiments/{id}", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		return nil, s.deleteRegiment(r.Context(), id)
	}))
	mux.HandleFunc("POST /api/regiments/{id}/debrief", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		if !s.llmActive(r.Context()) {
			return nil, errLLMOff
		}
		if _, err := s.pool.Exec(r.Context(), `UPDATE regiments SET debrief_status = 'pending', debrief_error = NULL
			WHERE id = $1::uuid AND status = 'completed'`, id); err != nil {
			return nil, err
		}
		s.jobs.enqueue(job{kind: "debrief", id: id})
		return s.getRegiment(r.Context(), id)
	}))

	// ---- sessions (one day of a regiment)
	sessionAction := func(fn func(ctx context.Context, id string) (*SessionView, error)) http.HandlerFunc {
		return h(func(r *http.Request) (any, error) {
			id, err := pathUUID(r, "id")
			if err != nil {
				return nil, err
			}
			return fn(r.Context(), id)
		})
	}
	mux.HandleFunc("GET /api/sessions/{id}", sessionAction(s.sessionView))
	mux.HandleFunc("POST /api/sessions/{id}/start", sessionAction(s.startSession))
	mux.HandleFunc("POST /api/sessions/{id}/pause", sessionAction(func(ctx context.Context, id string) (*SessionView, error) {
		return s.pauseSession(ctx, id, false)
	}))
	mux.HandleFunc("POST /api/sessions/{id}/resume", sessionAction(func(ctx context.Context, id string) (*SessionView, error) {
		return s.pauseSession(ctx, id, true)
	}))
	mux.HandleFunc("POST /api/sessions/{id}/finish", sessionAction(s.finishSession))
	mux.HandleFunc("POST /api/sessions/{id}/focus-lost", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		return nil, s.focusLost(r.Context(), id)
	}))

	// ---- items
	mux.HandleFunc("POST /api/items/{id}/answer", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		var req answerReq
		if err := decode(r, &req); err != nil {
			return nil, err
		}
		return s.answerItem(r.Context(), id, req)
	}))
	mux.HandleFunc("POST /api/items/{id}/variant", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		var b struct{ Language string }
		if err := decode(r, &b); err != nil {
			return nil, err
		}
		return s.setVariant(r.Context(), id, b.Language)
	}))
	mux.HandleFunc("POST /api/items/{id}/self-grade", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		var b struct{ Covered []int }
		if err := decode(r, &b); err != nil {
			return nil, err
		}
		return s.selfGrade(r.Context(), id, b.Covered)
	}))
	mux.HandleFunc("POST /api/items/{id}/regrade", h(func(r *http.Request) (any, error) {
		id, err := pathUUID(r, "id")
		if err != nil {
			return nil, err
		}
		return nil, s.regrade(r.Context(), id)
	}))

	return s.middleware(mux)
}

type QuestionSummary struct {
	ID         string   `json:"id"`
	Domain     string   `json:"domain"`
	Concepts   []string `json:"concepts"`
	Skill      string   `json:"skill"`
	Type       string   `json:"type"`
	Difficulty int      `json:"difficulty"`
	Language   *string  `json:"language"`
	Title      string   `json:"title"`
	EstSeconds int      `json:"estSeconds"`
	Attempts   int      `json:"attempts"`
	BestScore  *float64 `json:"bestScore"`
}

// listQuestions is the library: titles and metadata only, never prompts or answers.
func (s *Server) listQuestions(r *http.Request) (any, error) {
	qv := r.URL.Query()
	where := []string{"q.active", "q.source = 'bank'"}
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+strconv.Itoa(len(args))))
	}
	if d := qv.Get("domain"); d != "" {
		add("q.domain = ?", d)
	}
	if t := qv.Get("type"); t != "" {
		add("q.type = ?", t)
	}
	if d, err := strconv.Atoi(qv.Get("difficulty")); err == nil {
		add("q.difficulty = ?", d)
	}
	if l := qv.Get("language"); l != "" {
		add("q.language = ?", l)
	}
	if text := strings.TrimSpace(qv.Get("q")); text != "" {
		// both placeholders become the same $N
		add("(q.title ILIKE '%' || ? || '%' OR array_to_string(q.concepts, ' ') ILIKE '%' || ? || '%')", text)
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT q.id, q.domain, q.concepts, q.skill, q.type, q.difficulty, q.language, q.title, q.est_seconds,
		       count(si.id) FILTER (WHERE si.submitted_at IS NOT NULL AND NOT si.skipped), max(si.score)
		FROM questions q LEFT JOIN session_items si ON si.question_id = q.id
		WHERE `+strings.Join(where, " AND ")+`
		GROUP BY q.id ORDER BY q.domain, q.difficulty, q.title`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QuestionSummary{}
	for rows.Next() {
		var q QuestionSummary
		var best *float32
		if err := rows.Scan(&q.ID, &q.Domain, &q.Concepts, &q.Skill, &q.Type, &q.Difficulty, &q.Language, &q.Title, &q.EstSeconds,
			&q.Attempts, &best); err != nil {
			return nil, err
		}
		if best != nil {
			v := float64(*best)
			q.BestScore = &v
		}
		out = append(out, q)
	}
	return map[string]any{"questions": out}, rows.Err()
}
