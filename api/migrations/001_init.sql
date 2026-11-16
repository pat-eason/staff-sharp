-- Staff Sharp schema. One local user: profile and settings are singleton rows.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

CREATE TABLE profile (
    id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    display_name     TEXT NOT NULL DEFAULT '',
    primary_language TEXT NOT NULL DEFAULT 'ts',
    extra_languages  TEXT[] NOT NULL DEFAULT '{}',
    focal_domains    TEXT[] NOT NULL DEFAULT '{}',
    primary_focus    TEXT NOT NULL DEFAULT '',
    archetype        TEXT NOT NULL DEFAULT '',
    level            TEXT NOT NULL DEFAULT 'staff',
    years_experience INT NOT NULL DEFAULT 10,
    goal             TEXT NOT NULL DEFAULT 'stay_sharp',
    stack            TEXT NOT NULL DEFAULT '',
    context          TEXT NOT NULL DEFAULT '',
    weekly_minutes   INT NOT NULL DEFAULT 90,
    onboarded        BOOLEAN NOT NULL DEFAULT false,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO profile (id) VALUES (1);

CREATE TABLE questions (
    id           TEXT PRIMARY KEY,
    domain       TEXT NOT NULL,
    concepts     TEXT[] NOT NULL,
    skill        TEXT NOT NULL,
    type         TEXT NOT NULL,
    difficulty   INT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    language     TEXT,
    title        TEXT NOT NULL,
    est_seconds  INT NOT NULL,
    body         JSONB NOT NULL,
    source       TEXT NOT NULL DEFAULT 'bank',
    content_hash TEXT NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX questions_domain_idx ON questions (domain) WHERE active;
CREATE INDEX questions_type_idx ON questions (type) WHERE active;

CREATE TABLE regiments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    config        JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',   -- active | completed
    report        JSONB,
    debrief       JSONB,
    debrief_status TEXT NOT NULL DEFAULT 'none',    -- none | pending | ready | failed | off
    debrief_error TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);

CREATE TABLE sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regiment_id        UUID NOT NULL REFERENCES regiments (id) ON DELETE CASCADE,
    day_index          INT NOT NULL,
    scheduled_for      DATE,
    status             TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | completed
    time_limit_seconds INT,
    elapsed_ms         BIGINT NOT NULL DEFAULT 0,
    running_since      TIMESTAMPTZ,
    focus_losses       INT NOT NULL DEFAULT 0,
    current_position   INT NOT NULL DEFAULT 0,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    UNIQUE (regiment_id, day_index)
);

CREATE TABLE session_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    position      INT NOT NULL,
    question_id   TEXT REFERENCES questions (id),
    gen_spec      JSONB,
    gen_status    TEXT NOT NULL DEFAULT 'none',   -- none | pending | ready | failed
    variant       TEXT,
    shuffle       JSONB,
    response      JSONB,
    confidence    INT,
    time_spent_ms BIGINT NOT NULL DEFAULT 0,
    submitted_at  TIMESTAMPTZ,
    skipped       BOOLEAN NOT NULL DEFAULT false,
    score         REAL,
    potential     REAL,
    grade         JSONB,
    grade_status  TEXT NOT NULL DEFAULT 'ungraded', -- ungraded | pending | graded | failed
    graded_by     TEXT,                              -- auto | llm | heuristic | self
    grade_error   TEXT,
    UNIQUE (session_id, position)
);
CREATE INDEX session_items_question_idx ON session_items (question_id);
CREATE INDEX session_items_pending_idx ON session_items (grade_status) WHERE grade_status = 'pending';

CREATE TABLE insights (
    id         BIGSERIAL PRIMARY KEY,
    body       JSONB NOT NULL,
    source     TEXT NOT NULL,          -- llm | rules
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
