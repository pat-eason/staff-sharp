# Question bank schema

The bank lives in `api/seed/questions/*.json`. The Go API embeds these files and upserts them on every
start (by `id`), so editing a file and restarting the `api` service updates the bank. Taxonomy
(domains, concepts, skills, types, languages, diagram components) is in `api/seed/domains.json`.

Validate after every edit:

```bash
node scripts/validate-questions.mjs                 # every file
node scripts/validate-questions.mjs api/seed/questions/security.json
```

## File shape

```json
{ "file": "security", "questions": [ { ...question }, ... ] }
```

## Common fields (every question)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique across the whole bank, kebab-case, prefixed by the file's prefix (for example `sec-ssrf-metadata-01`). Never rename once shipped. |
| `domain` | string | A domain `key` from `domains.json`. |
| `concepts` | string[] | 1 to 3 kebab-case concepts. Prefer the domain's list; a new concept is allowed when none fits. |
| `skill` | string | `recall` \| `apply` \| `analyze` \| `design` \| `lead`. |
| `type` | string | `mcq` \| `multi` \| `free_text` \| `numeric` \| `ordering` \| `diagram` \| `code_review` \| `bug_hunt`. |
| `difficulty` | int | 1 = solid senior, 2 = strong senior, 3 = staff, 4 = senior staff, 5 = principal. |
| `title` | string | Short, specific, no trailing period (≤ 70 chars). |
| `prompt` | markdown | The question itself. |
| `context` | markdown | Optional scenario material: logs, metrics, tables, a Slack thread, a diff summary. |
| `language` | string \| null | Only for language-specific questions: `ts` \| `go` \| `rust` \| `csharp` \| `java`. |
| `estSeconds` | int | Realistic time a strong staff engineer needs (30 to 1800). |
| `explanation` | markdown | Shown after grading: why the answer is right, why the tempting wrong answers are wrong, and the staff-level takeaway. |
| `references` | string[] | Optional pointers (book chapter, paper, RFC, well-known postmortem). |
| `tags` | string[] | Optional: `interview`, `classic`, `on-the-job`, `gotcha`. |

## Type-specific fields

### `mcq` (one answer) and `multi` (select all that apply)

```json
"options": [ { "id": "a", "text": "..." }, { "id": "b", "text": "..." } ],
"answer": ["c"],
"optionNotes": { "a": "Why this is tempting but wrong", "c": "Why this is right" }
```

- 4 or 5 options. `mcq` has exactly one answer, `multi` has two or more (and at least one wrong option).
- Options are shuffled at runtime, so never write "all of the above" or "both A and B".
- Distractors must be plausible to a senior engineer and similar in length to the answer.

### `numeric` (estimation)

```json
"numeric": { "answer": 11600, "unit": "requests/second", "fullCreditRatio": 1.5, "zeroCreditRatio": 4 }
```

Credit is based on the ratio `max(given/answer, answer/given)`: full credit up to `fullCreditRatio`,
falling linearly to zero at `zeroCreditRatio`. Put the assumptions in the prompt so the answer is
derivable, and show the arithmetic in `explanation`.

### `ordering`

```json
"items": [ { "id": "1", "text": "first step" }, { "id": "2", "text": "second" } ]
```

List items in the CORRECT order (3 to 7 items). They are shuffled at runtime and scored by rank
correlation.

### `free_text`

```json
"rubric": {
  "keyPoints": ["A concrete thing a strong answer covers", "..."],
  "redFlags": ["A common wrong move"],
  "exemplar": "A concise model answer in markdown"
}
```

3 to 6 key points, each specific enough to grade against. Graded by the LLM (or by self-assessment
against the key points when no model is configured).

### `diagram`

Same `rubric` as `free_text`, plus `requiredComponents`: diagram component keys from `domains.json`.
Use `a|b` for "either is fine".

```json
"rubric": { "keyPoints": [...], "redFlags": [...], "exemplar": "...", "requiredComponents": ["load_balancer", "cache", "queue|stream", "database"] }
```

### `code_review` and `bug_hunt`

```json
"code": {
  "ts":     "source code ...",
  "go":     "...",
  "rust":   "...",
  "csharp": "...",
  "java":   "..."
},
"issues": [
  { "id": "1", "severity": "critical", "summary": "Shared map mutated without a lock", "fix": "Guard with a mutex or use a concurrent map" }
]
```

- Mark every line that belongs to an issue by appending ` //!issue:<id>` (or `//!issue:1,2`) to the end of
  the line. The loader strips the markers and records the line numbers, so never count lines by hand.
  Markers must not change the code's meaning.
- Language-agnostic questions (`language: null`) must provide all five variants with the same issues.
  Language-specific questions provide exactly their own language.
- `bug_hunt`: one issue (the bug) in most cases, possibly spanning several lines. `code_review`: 2 to 5
  issues of mixed severity (`critical` \| `major` \| `minor`).
- Keep snippets 8 to 40 lines, idiomatic, compilable-looking, and free of hint comments like `// BUG`.
- `rubric` is optional here; `issues[].fix` drives the feedback.
