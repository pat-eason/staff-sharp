# Staff Sharp

Single-user quiz and interview-prep app for staff+ engineers. See [README.md](README.md) for features.

## Layout and ownership

| Path | What |
| --- | --- |
| `api/` | Go API, one flat `package main`. All data, selection (`selection.go`), deterministic grading (`grading.go`), reports and rules-based coaching (`report.go`), calibration (`onboarding.go`), model jobs (`jobs.go`). Migrations in `api/migrations/`, applied on start; never edit an applied one |
| `api/seed/` | `domains.json` (taxonomy) and `questions/*.json`, embedded and upserted by id on every start. Removed questions are retired, not deleted |
| `agent/` | Flue service (API-key provider) and `src/claude-code/` (subscription runner). Keep it thin: Go builds every message; prompts and schemas live once in `agent/src/prompts/` |
| `web/` | React UI only, talks to the API through `web/src/api.ts`. Server state goes through React Query (`hooks.ts`) |

## Rules

- Never send answer keys to the browser before an item is submitted: `publicQuestion` strips them and `reveal` is filled only when feedback is due. A paused timed session withholds question text entirely.
- Code questions mark issue lines with `//!issue:<id>`; `prepareCode` strips the markers and records the lines. Never hand-number lines.
- Run `node scripts/validate-questions.mjs` after any bank edit. A wrong answer key is the worst bug this product can have.
- Go returns `[]T{}`, not nil, for any list the UI iterates.
- Claude runner rules (from standup-buddy): `strictMcpConfig: true`, a scrubbed env, never bare mode, strip `$schema` from output schemas, `maxTurns` of at least 3.
- No native browser UI: never the `title` attribute, `window.confirm`, `window.prompt` or `window.alert`. Hover descriptions use `data-tip` (and optional `data-tip-side`), rendered by `TooltipLayer`; confirmations and text input use `useDialog()` (`components/Overlay.tsx`).
- Grading that falls back (no model, model failure) is labelled in the UI (`gradedBy`: auto, llm, heuristic or self). Keep fallbacks visible.
- Theme tokens: use `--text*`, `--line`, `rgba(var(--ink-rgb), a)` and `rgba(var(--well-rgb), a)`, never raw porcelain or navy alphas, so light mode keeps working. Code colors come from `--code-*` and `--tk-*` (`styles/themes.css`).

## Commands

```bash
docker compose up -d --build                         # http://localhost:8484
ANTHROPIC_API_KEY= docker compose up -d api          # keep your shell's key out of the container
(cd api && go build ./... && go vet ./... && go test ./...)
(cd agent && npm run typecheck)
(cd web && npm run build)
```
