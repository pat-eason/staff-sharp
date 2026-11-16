export interface KeyName { key: string; name: string; blurb?: string }
export interface Domain extends KeyName { short: string; blurb: string; concepts: string[] }
export interface Taxonomy {
  domains: Domain[];
  skills: KeyName[];
  types: KeyName[];
  languages: KeyName[];
  archetypes: KeyName[];
  components: KeyName[];
}
export interface Meta {
  taxonomy: Taxonomy;
  bank: { total: number; counts: { domain: string; type: string; n: number }[] };
  llm: { active: boolean; provider: LlmProvider };
}

export type LlmProvider = 'off' | 'api_key' | 'claude_code';
export type Lang = 'ts' | 'go' | 'rust' | 'csharp' | 'java';
export type QType = 'mcq' | 'multi' | 'free_text' | 'numeric' | 'ordering' | 'diagram' | 'code_review' | 'bug_hunt';

export interface Profile {
  displayName: string;
  primaryLanguage: Lang;
  extraLanguages: Lang[];
  focalDomains: string[];
  primaryFocus: string;
  archetype: string;
  level: 'senior' | 'staff' | 'senior_staff' | 'principal';
  yearsExperience: number;
  goal: 'stay_sharp' | 'interview_prep' | 'promotion' | 'new_role';
  stack: string;
  context: string;
  weeklyMinutes: number;
  onboarded: boolean;
}

export interface RegimentConfig {
  domains: string[];
  domainWeights?: Record<string, number> | null;
  types: string[];
  difficultyMin: number;
  difficultyMax: number;
  days: number;
  perDay: number;
  timed: boolean;
  timeLimitMinutes: number;
  feedback: 'immediate' | 'end';
  adaptive: boolean;
  generatedPerDay: number;
  questionIds?: string[] | null;
  focusConcepts?: string[] | null;
  preset?: string;
}

export interface SessionSummary {
  id: string;
  dayIndex: number;
  scheduledFor: string | null;
  status: 'pending' | 'in_progress' | 'completed';
  timeLimitSeconds: number | null;
  elapsedMs: number;
  itemCount: number;
  answered: number;
  accuracy: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Breakdown { key: string; name: string; accuracy: number; potential: number; count: number }
export interface ItemRef { questionId: string; title: string; domain: string; score: number }
export interface ConceptStat { domain: string; concept: string; accuracy: number; count: number }
export interface FocusArea { domain: string; concept?: string; why: string; practice: string }
export interface NextRegiment { name: string; description: string; config: RegimentConfig }
export interface Recommendation { headline: string; direction: string; focusAreas: FocusArea[]; strengths: string[] | null; next?: NextRegiment }

export interface Report {
  accuracy: number;
  potential: number;
  band: string;
  answered: number;
  skipped: number;
  total: number;
  timeMs: number;
  estMs: number;
  focusLosses: number;
  pendingGrades: number;
  byDomain: Breakdown[];
  bySkill: Breakdown[];
  byType: Breakdown[];
  byDay: Breakdown[];
  blindSpots: ItemRef[] | null;
  missed: ItemRef[] | null;
  weakConcepts: ConceptStat[] | null;
  recommendation: Recommendation;
  generatedAt: string;
}

export interface Regiment {
  id: string;
  name: string;
  description: string;
  config: RegimentConfig;
  status: 'active' | 'completed';
  report: Report | null;
  debrief: Recommendation | null;
  debriefStatus: 'none' | 'pending' | 'ready' | 'failed' | 'off';
  debriefError: string | null;
  createdAt: string;
  completedAt: string | null;
  sessions: SessionSummary[];
  daysCompleted: number;
  accuracy: number | null;
  potential: number | null;
}

export interface Option { id: string; text: string }

export interface PublicQuestion {
  id: string;
  domain: string;
  concepts: string[];
  skill: string;
  type: QType;
  difficulty: number;
  title: string;
  prompt: string;
  context?: string;
  language: Lang | null;
  estSeconds: number;
  options?: Option[];
  items?: Option[];
  unit?: string;
  code?: string;
  codeLanguage?: Lang;
  codeVariants?: Lang[];
  source: string;
}

export interface Comment { line: number; text: string; severity?: string }
export interface DiagramNode { id: string; type: string; label: string; x: number; y: number }
export interface DiagramEdge { id: string; source: string; target: string; label: string }
export interface Diagram { nodes: DiagramNode[]; edges: DiagramEdge[] }

export interface Response {
  selected?: string[];
  value?: number;
  order?: string[];
  text?: string;
  comments?: Comment[];
  diagram?: Diagram;
}

export interface AutoGrade {
  correct?: boolean;
  ratio?: number;
  tau?: number;
  foundIssues?: string[];
  missedIssues?: string[];
  falseFlags?: number[];
  detection?: number;
  componentsFound?: string[];
  componentsMissed?: string[];
  keyPointsCovered?: number[];
  heuristic?: boolean;
}
export interface LlmGrade {
  score: number;
  potential: number;
  verdict: 'strong' | 'solid' | 'partial' | 'weak' | 'off_track';
  summary: string;
  strengths: string[];
  gaps: string[];
  keyPointsCovered: number[];
  redFlagsHit: number[];
  issuesIdentified: string[];
  feedback: string;
  followUp: string;
}
export interface Grade { auto?: AutoGrade; llm?: LlmGrade; self?: { covered: number[] } }

export interface Rubric { keyPoints: string[]; redFlags?: string[]; exemplar: string; requiredComponents?: string[] }
export interface RevealIssue { id: string; severity: 'critical' | 'major' | 'minor'; summary: string; fix: string; lines: number[] }
export interface Reveal {
  answer?: string[];
  optionNotes?: Record<string, string>;
  order?: Option[];
  numeric?: { answer: number; unit: string; fullCreditRatio: number; zeroCreditRatio: number };
  rubric?: Rubric;
  issues?: RevealIssue[];
  explanation: string;
  references?: string[];
}

export interface Item {
  id: string;
  position: number;
  status: 'open' | 'submitted' | 'skipped' | 'generating';
  withheld?: boolean;
  question?: PublicQuestion;
  response?: Response;
  confidence: number | null;
  timeSpentMs: number;
  score: number | null;
  potential: number | null;
  gradeStatus: 'ungraded' | 'pending' | 'graded' | 'failed';
  gradedBy: 'auto' | 'llm' | 'heuristic' | 'self' | null;
  gradeError?: string;
  grade?: Grade;
  reveal?: Reveal;
}

export interface Session {
  id: string;
  regimentId: string;
  regimentName: string;
  dayIndex: number;
  days: number;
  status: 'pending' | 'in_progress' | 'completed';
  timed: boolean;
  feedback: 'immediate' | 'end';
  timeLimitSeconds: number | null;
  elapsedMs: number;
  running: boolean;
  focusLosses: number;
  currentPosition: number;
  serverNow: string;
  items: Item[];
  llm: boolean;
  preset: string;
}

export interface Mastery {
  key: string; name: string; short: string;
  mastery: number; potential: number; accuracy: number;
  count: number; recent: number; trend: number; focal: boolean; primary: boolean;
}
export interface ProfileStats {
  domains: Mastery[];
  skills: Breakdown[] | null;
  types: Breakdown[] | null;
  languages: Breakdown[] | null;
  weakConcepts: ConceptStat[] | null;
  answered: number;
  accuracy: number;
  potential: number;
  blindSpots: number;
  minutes: number;
  streakDays: number;
  activeDays: string[] | null;
  regiments: number;
  calibration: number | null;
}
export interface Insight {
  summary: string;
  strengths: string[] | null;
  focusNext: FocusArea[] | null;
  archetypeNote: string;
  weeklyPlan: string[] | null;
  source: 'llm' | 'rules';
  createdAt: string;
}

export interface Settings {
  llmProvider: LlmProvider;
  graderModel: string;
  generatorModel: string;
  coachModel: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  graderInstructions: string;
  apiKeySource: 'stored' | 'env' | 'none';
  apiKeyHint: string | null;
}
export interface ClaudeStatus {
  runner?: boolean;
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  message?: string;
}

export interface QuestionSummary {
  id: string; domain: string; concepts: string[]; skill: string; type: QType; difficulty: number;
  language: Lang | null; title: string; estSeconds: number; attempts: number; bestScore: number | null;
}

export interface Preview {
  matching: number;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
  minutesPerDay: number;
  totalQuestions: number;
  enoughForAllDays: boolean;
  llm: boolean;
}

export interface CalibrationRef { regimentId: string; sessionId: string; status: 'pending' | 'in_progress' | 'completed' }
export interface CalibrationResult {
  regimentId: string;
  theta: number;
  level: Profile['level'];
  confidence: 'low' | 'medium' | 'high';
  answered: number;
  accuracy: number;
  byDifficulty: Breakdown[];
  byDomain: Breakdown[];
  strongest: string[] | null;
  weakest: string[] | null;
}

export interface WeekPoint { week: string; answered: number; accuracy: number | null; potential: number | null; minutes: number; blindSpots: number }
export interface DomainTrack { key: string; name: string; mastery: (number | null)[]; now: number; change: number | null; count: number }
export interface DebriefEntry { regimentId: string; name: string; completedAt: string; accuracy: number | null; potential: number | null; headline: string; direction: string; source: 'llm' | 'rules' }
export interface RecurringMiss { questionId: string; title: string; domain: string; attempts: number; average: number; last: number }
export interface History { weeks: WeekPoint[]; domains: DomainTrack[]; insights: Insight[]; debriefs: DebriefEntry[]; recurring: RecurringMiss[]; answered: number; firstAt: string | null }
export interface LedgerRow {
  itemId: string; sessionId: string; regimentId: string; regimentName: string; dayIndex: number; questionId: string; title: string;
  domain: string; type: QType; difficulty: number; score: number; potential: number | null; confidence: number | null;
  gradedBy: string | null; skipped: boolean; timeMs: number; at: string;
}

export interface Preferences { theme: 'system' | 'light' | 'dark'; codeTheme: string }

export const MODEL_OPTIONS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
export const LEVELS: { key: Profile['level']; name: string }[] = [
  { key: 'senior', name: 'Senior' },
  { key: 'staff', name: 'Staff' },
  { key: 'senior_staff', name: 'Senior Staff' },
  { key: 'principal', name: 'Principal' },
];
export const GOALS: { key: Profile['goal']; name: string; blurb: string }[] = [
  { key: 'stay_sharp', name: 'Stay sharp', blurb: 'Keep breadth from eroding while I go deep elsewhere.' },
  { key: 'interview_prep', name: 'Interview prep', blurb: 'Loops coming up: timed, realistic, honest grading.' },
  { key: 'promotion', name: 'Promotion', blurb: 'Close the gaps between my level and the next one.' },
  { key: 'new_role', name: 'New role', blurb: 'Ramp onto an unfamiliar area quickly.' },
];
export const DIFFICULTY_NAMES = ['', 'Senior', 'Strong senior', 'Staff', 'Senior staff', 'Principal'];
/** Compact but unambiguous level names for tight spots like the knob readout. */
export const DIFFICULTY_SHORT = ['', 'Senior', 'Strong Sr', 'Staff', 'Sr Staff', 'Principal'];
