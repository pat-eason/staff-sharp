/** A deliberately small syntax highlighter for the five supported languages: keywords, types, strings, comments, numbers. */
import type { Lang } from '../types';

export type Token = { t: 'kw' | 'ty' | 'str' | 'com' | 'num' | 'fn' | 'plain'; v: string };

const KEYWORDS: Record<Lang, string[]> = {
  ts: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'return', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'while', 'yield', 'private', 'public', 'readonly', 'static', 'implements', 'as', 'enum', 'null', 'undefined', 'true', 'false', 'this'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var', 'nil', 'true', 'false'],
  rust: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
  csharp: ['abstract', 'async', 'await', 'base', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'false', 'finally', 'for', 'foreach', 'if', 'in', 'interface', 'internal', 'is', 'lock', 'namespace', 'new', 'null', 'out', 'override', 'private', 'protected', 'public', 'readonly', 'record', 'ref', 'return', 'sealed', 'static', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'using', 'var', 'virtual', 'void', 'while', 'when'],
  java: ['abstract', 'break', 'case', 'catch', 'class', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'implements', 'import', 'instanceof', 'interface', 'new', 'null', 'package', 'private', 'protected', 'public', 'record', 'return', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'true', 'try', 'var', 'void', 'volatile', 'while'],
};

const RE = /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|(\s+|.)/g;

/** Tokenizes one line. Multi-line strings and block comments are rare in these snippets and degrade gracefully. */
export function tokenize(line: string, lang: Lang): Token[] {
  const kws = new Set(KEYWORDS[lang] ?? []);
  const out: Token[] = [];
  for (const m of line.matchAll(RE)) {
    if (m[1]) out.push({ t: 'com', v: m[1] });
    else if (m[2]) {
      // Rust lifetimes ('a) look like char literals; keep them plain.
      if (lang === 'rust' && m[2].startsWith("'") && !m[2].endsWith("'")) out.push({ t: 'plain', v: m[2] });
      else out.push({ t: 'str', v: m[2] });
    } else if (m[3]) out.push({ t: 'num', v: m[3] });
    else if (m[4]) {
      const w = m[4];
      if (kws.has(w)) out.push({ t: 'kw', v: w });
      else if (m[5]) out.push({ t: 'fn', v: w });
      else if (/^[A-Z]/.test(w)) out.push({ t: 'ty', v: w });
      else out.push({ t: 'plain', v: w });
      if (m[5]) out.push({ t: 'plain', v: m[5] });
    } else if (m[6]) out.push({ t: 'plain', v: m[6] });
  }
  return out;
}

export const LANG_NAMES: Record<Lang, string> = { ts: 'TypeScript', go: 'Go', rust: 'Rust', csharp: 'C#', java: 'Java' };
