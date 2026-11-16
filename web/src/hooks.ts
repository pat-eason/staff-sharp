import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Regiment, Session } from './types';

export const keys = {
  meta: ['meta'] as const,
  profile: ['profile'] as const,
  stats: ['stats'] as const,
  insight: ['insight'] as const,
  settings: ['settings'] as const,
  regiments: ['regiments'] as const,
  regiment: (id: string) => ['regiment', id] as const,
  session: (id: string) => ['session', id] as const,
};

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: api.meta, staleTime: 60_000 });
export const useProfile = () => useQuery({ queryKey: keys.profile, queryFn: api.profile });
export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: api.stats });
export const useInsight = () => useQuery({ queryKey: keys.insight, queryFn: api.insight });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings });
export const useRegiments = () => useQuery({ queryKey: keys.regiments, queryFn: api.regiments });

/** A regiment; polls while its report is still waiting on model grades or the debrief. */
export function useRegiment(id: string) {
  return useQuery({
    queryKey: keys.regiment(id),
    queryFn: () => api.regiment(id),
    refetchInterval: (q) => {
      const r = q.state.data as Regiment | undefined;
      return r && (r.debriefStatus === 'pending' || (r.report?.pendingGrades ?? 0) > 0) ? 4000 : false;
    },
  });
}

/** A day's session; polls while a grade or a generated question is pending. */
export function useSession(id: string) {
  return useQuery({
    queryKey: keys.session(id),
    queryFn: () => api.session(id),
    refetchInterval: (q) => {
      const s = q.state.data as Session | undefined;
      return s?.items?.some((i) => i.gradeStatus === 'pending' || i.status === 'generating') ? 3000 : false;
    },
  });
}

export function domainName(meta: { taxonomy: { domains: { key: string; name: string }[] } } | undefined, key: string): string {
  return meta?.taxonomy.domains.find((d) => d.key === key)?.name ?? key;
}

export function typeName(meta: { taxonomy: { types: { key: string; name: string }[] } } | undefined, key: string): string {
  return meta?.taxonomy.types.find((d) => d.key === key)?.name ?? key;
}
