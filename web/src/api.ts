import type {
  ClaudeStatus, Insight, Meta, Preview, Profile, ProfileStats, QuestionSummary, Regiment, RegimentConfig, Response,
  CalibrationRef, CalibrationResult, History, LedgerRow, NextRegiment, Preferences, Session, Settings,
} from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  meta: () => request<Meta>('GET', '/meta'),
  profile: () => request<Profile>('GET', '/profile'),
  saveProfile: (p: Profile) => request<Profile>('PUT', '/profile', p),
  stats: () => request<ProfileStats>('GET', '/profile/stats'),
  insight: () => request<Insight>('GET', '/profile/insight'),
  refreshInsight: () => request<Insight>('POST', '/profile/insight'),

  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (p: Partial<Settings> & { apiKey?: string }) => request<Settings>('PUT', '/settings', p),
  testSettings: () => request<{ reply: string }>('POST', '/settings/test'),
  claudeStatus: () => request<ClaudeStatus>('GET', '/claude/status'),
  claudeLogin: () => request<{ url: string }>('POST', '/claude/login').then((r) => r.url),
  claudeCode: (code: string) => request<ClaudeStatus>('POST', '/claude/login/code', { code }),
  claudeLogout: () => request<ClaudeStatus>('POST', '/claude/logout'),

  onboarding: () => request<{ calibration: CalibrationRef | null }>('GET', '/onboarding').then((r) => r.calibration),
  startCalibration: () => request<CalibrationRef>('POST', '/onboarding/calibration'),
  calibrationResult: () => request<CalibrationResult>('GET', '/onboarding/result'),

  history: () => request<History>('GET', '/history'),
  ledger: (q: Record<string, string>) =>
    request<{ rows: LedgerRow[]; total: number; limit: number; offset: number }>('GET', `/ledger?${new URLSearchParams(q)}`),

  preferences: () => request<Preferences>('GET', '/preferences'),
  savePreferences: (p: Partial<Preferences>) => request<Preferences>('PUT', '/preferences', p),

  questions: (q: Record<string, string>) =>
    request<{ questions: QuestionSummary[] }>('GET', `/questions?${new URLSearchParams(q)}`).then((r) => r.questions),

  regiments: () => request<Regiment[] | null>('GET', '/regiments').then((r) => r ?? []),
  regiment: (id: string) => request<Regiment>('GET', `/regiments/${id}`),
  createRegiment: (name: string, description: string, config: Partial<RegimentConfig>) =>
    request<Regiment>('POST', '/regiments', { name, description, config }),
  deleteRegiment: (id: string) => request<void>('DELETE', `/regiments/${id}`),
  preview: (config: Partial<RegimentConfig>) => request<Preview>('POST', '/regiments/preview', config),
  recommend: () => request<NextRegiment>('POST', '/regiments/recommend'),
  redebrief: (id: string) => request<Regiment>('POST', `/regiments/${id}/debrief`),

  session: (id: string) => request<Session>('GET', `/sessions/${id}`),
  startSession: (id: string) => request<Session>('POST', `/sessions/${id}/start`),
  pause: (id: string) => request<Session>('POST', `/sessions/${id}/pause`),
  resume: (id: string) => request<Session>('POST', `/sessions/${id}/resume`),
  finish: (id: string) => request<Session>('POST', `/sessions/${id}/finish`),
  focusLost: (id: string) => request<void>('POST', `/sessions/${id}/focus-lost`),

  answer: (itemId: string, response: Response, confidence: number | null, timeSpentMs: number) =>
    request<Session>('POST', `/items/${itemId}/answer`, { response, confidence, timeSpentMs }),
  setVariant: (itemId: string, language: string) => request<Session>('POST', `/items/${itemId}/variant`, { language }),
  selfGrade: (itemId: string, covered: number[]) => request<Session>('POST', `/items/${itemId}/self-grade`, { covered }),
  regrade: (itemId: string) => request<void>('POST', `/items/${itemId}/regrade`),
};

/** Create a regiment and return the first day's session id, the usual "start now" flow. */
export async function createAndStart(name: string, description: string, config: Partial<RegimentConfig>): Promise<string> {
  const r = await api.createRegiment(name, description, config);
  return r.sessions[0].id;
}
