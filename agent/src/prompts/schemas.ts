import * as v from 'valibot';

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const strings = v.array(v.string());

export const GradeResult = v.object({
  score: unit,
  potential: unit,
  verdict: v.picklist(['strong', 'solid', 'partial', 'weak', 'off_track']),
  summary: v.string(),
  strengths: strings,
  gaps: strings,
  keyPointsCovered: v.array(v.number()),
  redFlagsHit: v.array(v.number()),
  issuesIdentified: strings,
  feedback: v.string(),
  followUp: v.string(),
});

const Option = v.object({ id: v.string(), text: v.string() });

export const GeneratedQuestion = v.object({
  type: v.picklist(['mcq', 'multi', 'free_text']),
  title: v.string(),
  prompt: v.string(),
  context: v.optional(v.string()),
  concepts: strings,
  skill: v.picklist(['recall', 'apply', 'analyze', 'design', 'lead']),
  difficulty: v.number(),
  estSeconds: v.number(),
  explanation: v.string(),
  options: v.optional(v.array(Option)),
  answer: v.optional(strings),
  optionNotes: v.optional(v.array(v.object({ id: v.string(), note: v.string() }))),
  rubric: v.optional(
    v.object({
      keyPoints: strings,
      redFlags: v.optional(strings),
      exemplar: v.string(),
    }),
  ),
});

const FocusArea = v.object({
  domain: v.string(),
  concept: v.optional(v.string()),
  why: v.string(),
  practice: v.string(),
});

export const DebriefResult = v.object({
  headline: v.string(),
  direction: v.string(),
  strengths: strings,
  focusAreas: v.array(FocusArea),
  nextRegiment: v.object({
    name: v.string(),
    description: v.string(),
    domains: strings,
    types: strings,
    difficultyMin: v.number(),
    difficultyMax: v.number(),
    days: v.number(),
    perDay: v.number(),
    timed: v.boolean(),
  }),
});

export const InsightResult = v.object({
  summary: v.string(),
  strengths: strings,
  focusNext: v.array(FocusArea),
  archetypeNote: v.string(),
  weeklyPlan: strings,
});

/** optionNotes is an array for the model (records are awkward in JSON Schema); Go expects a map. */
export function normalizeGenerated(q: v.InferOutput<typeof GeneratedQuestion>): unknown {
  const { optionNotes, ...rest } = q;
  return optionNotes ? { ...rest, optionNotes: Object.fromEntries(optionNotes.map((n) => [n.id, n.note])) } : rest;
}
