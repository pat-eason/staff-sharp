#!/usr/bin/env node
// Validates the question bank. Usage: node scripts/validate-questions.mjs [file ...]
// With no arguments every file in api/seed/questions is checked, including id uniqueness across files.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxonomy = JSON.parse(readFileSync(join(root, 'api/seed/domains.json'), 'utf8'));
const DOMAINS = new Set(taxonomy.domains.map((d) => d.key));
const SKILLS = new Set(taxonomy.skills.map((s) => s.key));
const TYPES = new Set(taxonomy.types.map((t) => t.key));
const LANGS = taxonomy.languages.map((l) => l.key);
const COMPONENTS = new Set(taxonomy.components.map((c) => c.key));
const SEVERITIES = new Set(['critical', 'major', 'minor']);
const MARKER = /\s*\/\/!issue:([A-Za-z0-9_,-]+)\s*$/;

const dir = join(root, 'api/seed/questions');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));

const errors = [];
const seen = new Map();
const counts = { domain: {}, type: {}, difficulty: {}, language: {} };
let total = 0;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const bump = (k, v) => (counts[k][v] = (counts[k][v] ?? 0) + 1);

for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${basename(file)}: invalid JSON: ${e.message}`);
    continue;
  }
  if (!Array.isArray(doc.questions)) {
    errors.push(`${basename(file)}: missing "questions" array`);
    continue;
  }
  doc.questions.forEach((q, i) => {
    const where = `${basename(file)}#${i}${q?.id ? ` (${q.id})` : ''}`;
    const err = (m) => errors.push(`${where}: ${m}`);
    if (!q || typeof q !== 'object') return err('not an object');
    total++;

    if (!isStr(q.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(q.id)) err('id must be kebab-case');
    else if (seen.has(q.id)) err(`duplicate id (also in ${seen.get(q.id)})`);
    else seen.set(q.id, basename(file));
    if (!DOMAINS.has(q.domain)) err(`unknown domain "${q.domain}"`);
    if (!Array.isArray(q.concepts) || q.concepts.length < 1 || q.concepts.length > 3 || !q.concepts.every((c) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c)))
      err('concepts must be 1-3 kebab-case strings');
    if (!SKILLS.has(q.skill)) err(`unknown skill "${q.skill}"`);
    if (!TYPES.has(q.type)) err(`unknown type "${q.type}"`);
    if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 5) err('difficulty must be 1-5');
    if (!isStr(q.title) || q.title.length > 90) err('title missing or longer than 90 chars');
    if (!isStr(q.prompt)) err('prompt missing');
    if (q.context != null && typeof q.context !== 'string') err('context must be a string');
    if (q.language != null && !LANGS.includes(q.language)) err(`unknown language "${q.language}"`);
    if (!Number.isInteger(q.estSeconds) || q.estSeconds < 20 || q.estSeconds > 2400) err('estSeconds must be 20-2400');
    if (!isStr(q.explanation)) err('explanation missing');
    if (q.references != null && !(Array.isArray(q.references) && q.references.every(isStr))) err('references must be strings');

    switch (q.type) {
      case 'mcq':
      case 'multi': {
        const opts = q.options;
        if (!Array.isArray(opts) || opts.length < 4 || opts.length > 5) {
          err('options must have 4 or 5 entries');
          break;
        }
        const ids = new Set();
        for (const o of opts) {
          if (!isStr(o?.id) || !isStr(o?.text)) err('every option needs id and text');
          if (ids.has(o?.id)) err(`duplicate option id ${o?.id}`);
          ids.add(o?.id);
          if (/all of the above|none of the above|both (a|b|c)/i.test(o?.text ?? '')) err('options are shuffled: no "all/none of the above"');
        }
        if (!Array.isArray(q.answer) || !q.answer.every((a) => ids.has(a))) err('answer must list option ids');
        else if (q.type === 'mcq' && q.answer.length !== 1) err('mcq needs exactly one answer');
        else if (q.type === 'multi' && (q.answer.length < 2 || q.answer.length >= opts.length)) err('multi needs 2+ answers and at least one wrong option');
        if (q.optionNotes != null && (typeof q.optionNotes !== 'object' || Object.keys(q.optionNotes).some((k) => !ids.has(k))))
          err('optionNotes keys must be option ids');
        break;
      }
      case 'numeric': {
        const n = q.numeric;
        if (!n || typeof n.answer !== 'number' || !(n.answer > 0)) err('numeric.answer must be a positive number');
        if (!isStr(n?.unit)) err('numeric.unit missing');
        if (!(n?.fullCreditRatio >= 1) || !(n?.zeroCreditRatio > n?.fullCreditRatio)) err('need 1 <= fullCreditRatio < zeroCreditRatio');
        break;
      }
      case 'ordering': {
        if (!Array.isArray(q.items) || q.items.length < 3 || q.items.length > 7) err('ordering needs 3-7 items');
        else if (!q.items.every((it) => isStr(it?.id) && isStr(it?.text))) err('every item needs id and text');
        else if (new Set(q.items.map((it) => it.id)).size !== q.items.length) err('duplicate item ids');
        break;
      }
      case 'free_text':
      case 'diagram': {
        const r = q.rubric;
        if (!r || !Array.isArray(r.keyPoints) || r.keyPoints.length < 3 || r.keyPoints.length > 7 || !r.keyPoints.every(isStr))
          err('rubric.keyPoints needs 3-7 strings');
        if (r?.redFlags != null && !(Array.isArray(r.redFlags) && r.redFlags.every(isStr))) err('rubric.redFlags must be strings');
        if (!isStr(r?.exemplar)) err('rubric.exemplar missing');
        if (q.type === 'diagram') {
          if (!Array.isArray(r?.requiredComponents) || r.requiredComponents.length < 2) err('diagram needs 2+ requiredComponents');
          else
            for (const c of r.requiredComponents)
              for (const alt of String(c).split('|')) if (!COMPONENTS.has(alt)) err(`unknown component "${alt}"`);
        }
        break;
      }
      case 'code_review':
      case 'bug_hunt': {
        const issues = q.issues;
        if (!Array.isArray(issues) || issues.length < 1) {
          err('issues required');
          break;
        }
        const issueIds = new Set();
        for (const is of issues) {
          if (!isStr(is?.id) || !isStr(is?.summary) || !isStr(is?.fix)) err('every issue needs id, summary and fix');
          if (!SEVERITIES.has(is?.severity)) err(`issue ${is?.id}: severity must be critical|major|minor`);
          issueIds.add(is?.id);
        }
        if (q.type === 'code_review' && (issues.length < 2 || issues.length > 6)) err('code_review needs 2-6 issues');
        if (q.type === 'bug_hunt' && issues.length > 3) err('bug_hunt should have 1-3 issues');
        const code = q.code;
        if (!code || typeof code !== 'object') {
          err('code variants required');
          break;
        }
        const langs = Object.keys(code);
        if (q.language) {
          if (langs.length !== 1 || langs[0] !== q.language) err(`language-specific question must have exactly the "${q.language}" variant`);
        } else {
          const missing = LANGS.filter((l) => !isStr(code[l]));
          if (missing.length) err(`language-agnostic code needs all five variants; missing ${missing.join(', ')}`);
        }
        for (const lang of langs) {
          if (!LANGS.includes(lang)) {
            err(`unknown code language "${lang}"`);
            continue;
          }
          const lines = String(code[lang]).split('\n');
          if (lines.length < 6 || lines.length > 60) err(`${lang}: snippet should be 6-60 lines (has ${lines.length})`);
          const found = new Set();
          for (const line of lines) {
            const m = line.match(MARKER);
            if (m) for (const id of m[1].split(',')) found.add(id);
            if (/\/\/!issue/.test(line) && !m) err(`${lang}: malformed marker in "${line.trim()}"`);
          }
          for (const id of found) if (!issueIds.has(id)) err(`${lang}: marker for unknown issue ${id}`);
          for (const id of issueIds) if (!found.has(id)) err(`${lang}: issue ${id} has no //!issue marker`);
          bump('language', lang);
        }
        break;
      }
    }
    bump('domain', q.domain);
    bump('type', q.type);
    bump('difficulty', q.difficulty);
  });
}

const fmt = (o) => Object.entries(o).sort().map(([k, v]) => `${k}=${v}`).join('  ');
console.log(`questions: ${total} in ${files.length} file(s)`);
console.log(`by domain:     ${fmt(counts.domain)}`);
console.log(`by type:       ${fmt(counts.type)}`);
console.log(`by difficulty: ${fmt(counts.difficulty)}`);
console.log(`code variants: ${fmt(counts.language)}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nOK');
