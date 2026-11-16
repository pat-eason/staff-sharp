import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import type { Preferences } from './types';

export const CODE_THEMES = [
  { key: 'staff', name: 'Staff Sharp', light: false },
  { key: 'github-light', name: 'GitHub Light', light: true },
  { key: 'github-dark', name: 'GitHub Dark', light: false },
  { key: 'one-dark', name: 'One Dark', light: false },
  { key: 'dracula', name: 'Dracula', light: false },
  { key: 'monokai', name: 'Monokai', light: false },
  { key: 'solarized-light', name: 'Solarized Light', light: true },
  { key: 'solarized-dark', name: 'Solarized Dark', light: false },
  { key: 'nord', name: 'Nord', light: false },
  { key: 'tokyo-night', name: 'Tokyo Night', light: false },
  { key: 'catppuccin-mocha', name: 'Catppuccin Mocha', light: false },
  { key: 'shades-of-purple', name: 'Shades of Purple', light: false },
] as const;

// Mirrored locally only so index.html can paint the right theme before the API answers.
const STORAGE_KEY = 'staff-sharp.preferences';
const DEFAULTS: Preferences = { theme: 'dark', codeTheme: 'staff' };

function readMirror(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Preferences>) } : DEFAULTS;
  } catch {
    return DEFAULTS; // storage blocked (private window): the server copy still applies
  }
}

function writeMirror(p: Preferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: nothing to mirror, the server copy is the source of truth */
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: light)');
function subscribeScheme(cb: () => void) {
  const m = media();
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
const systemPrefersLight = () => media().matches;

type Origin = { x: number; y: number };

function originOf(el: Element | null | undefined): Origin {
  const r = el && el !== document.body ? el.getBoundingClientRect() : null;
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: 0 };
}

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

/**
 * Swaps the theme with a circular reveal growing from `origin` (View Transitions API), a short colour
 * cross-fade where that API is missing, and no motion at all for users who ask for reduced motion.
 * `apply` must update the DOM synchronously.
 */
function transitionTheme(apply: () => void, origin: Origin) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  const doc = document as ViewTransitionDoc;
  if (!doc.startViewTransition) {
    const root = document.documentElement;
    root.classList.add('theme-fade');
    apply();
    window.setTimeout(() => root.classList.remove('theme-fade'), 450);
    return;
  }
  const transition = doc.startViewTransition(apply);
  const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y));
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 560, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => undefined); // a skipped transition just switches instantly
}

/**
 * The display preferences (theme and code color scheme), applied to <html> as data-theme and
 * data-code-theme. "system" follows the OS setting live.
 */
export function useAppearance() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['preferences'], queryFn: api.preferences, placeholderData: readMirror });
  const prefs = data ?? DEFAULTS;
  const prefersLight = useSyncExternalStore(subscribeScheme, systemPrefersLight);
  const resolved: 'light' | 'dark' = prefs.theme === 'system' ? (prefersLight ? 'light' : 'dark') : prefs.theme;

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = resolved;
    el.dataset.codeTheme = prefs.codeTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#fefffa' : '#092742');
    writeMirror(prefs);
  }, [resolved, prefs]);

  const save = useMutation({
    mutationFn: (patch: Partial<Preferences>) => api.savePreferences(patch),
    onMutate: (patch) => qc.setQueryData(['preferences'], { ...prefs, ...patch }),
    onSuccess: (p) => qc.setQueryData(['preferences'], p),
    onError: () => qc.invalidateQueries({ queryKey: ['preferences'] }),
  });

  /** Pass the control that was clicked so the reveal grows from it (defaults to the focused element). */
  const setTheme = (theme: Preferences['theme'], from?: Element | null) => {
    const next: 'light' | 'dark' = theme === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : theme;
    if (next !== resolved) {
      transitionTheme(() => {
        document.documentElement.dataset.theme = next;
      }, originOf(from ?? document.activeElement));
    }
    save.mutate({ theme });
  };

  return { prefs, resolved, setTheme, setCodeTheme: (codeTheme: string) => save.mutate({ codeTheme }) };
}
