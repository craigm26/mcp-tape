import { matchPath, matchSegments, compilePath, type Segment } from './jsonpath.js';

// Field names whose values are always replaced with `[REDACTED]`.
// Matched case-insensitively as a substring of the key.
const DEFAULT_FIELDS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /authorization/i,
  /^bearer$/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
];

// Regex patterns applied to every string value (and the contents of any
// string field whose name didn't trigger a field-name redaction).
const DEFAULT_PATTERNS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // generic sk-* secret (OpenAI/Anthropic-shape)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub personal/oauth/server/user/refresh tokens
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
];

export const REPLACEMENT = '[REDACTED]';

export interface RedactConfig {
  fields: RegExp[];
  patterns: RegExp[];
  replacement: string;
}

export function buildConfig(opts: {
  extraPatterns: readonly string[];
  useDefaults: boolean;
}): RedactConfig {
  const patterns = opts.useDefaults ? [...DEFAULT_PATTERNS] : [];
  for (const p of opts.extraPatterns) patterns.push(new RegExp(p, 'g'));
  const fields = opts.useDefaults ? [...DEFAULT_FIELDS] : [];
  return { fields, patterns, replacement: REPLACEMENT };
}

export function describeDefaults(): string {
  const lines = ['Default field-name patterns:'];
  for (const r of DEFAULT_FIELDS) lines.push(`  ${r}`);
  lines.push('', 'Default value patterns:');
  for (const r of DEFAULT_PATTERNS) lines.push(`  ${r}`);
  return lines.join('\n');
}

export interface PathRule {
  path: string;
  segments?: Segment[]; // pre-compiled; populated by redact-config.ts at load time
}

export function applyPathRules(value: unknown, rules: readonly PathRule[]): unknown {
  if (rules.length === 0) return value;
  // Ensure compiled segments are available; compile lazily for callers that pass raw paths.
  const compiled = rules.map((r) => r.segments ?? compilePath(r.path));
  return walk(value, compiled, []);
}

function walk(value: unknown, compiled: Segment[][], path: string[]): unknown {
  if (pathMatches(compiled, path)) return REPLACEMENT;
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, compiled, [...path, String(i)]));
  }
  if (value && typeof value === 'object') {
    // fromEntries defines each member, so a member named `__proto__` stays a
    // member (assigning to obj['__proto__'] would set the prototype instead).
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, walk(v, compiled, [...path, k])]),
    );
  }
  return value;
}

function pathMatches(compiled: Segment[][], path: readonly string[]): boolean {
  for (const segs of compiled) {
    if (matchSegments(segs, path)) return true;
  }
  return false;
}

export function redact(value: unknown, cfg: RedactConfig, parentKey = ''): unknown {
  if (typeof value === 'string') {
    if (parentKey && cfg.fields.some((r) => r.test(parentKey))) {
      return cfg.replacement;
    }
    let out = value;
    for (const p of cfg.patterns) out = out.replace(p, cfg.replacement);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, cfg, parentKey));
  }
  if (value && typeof value === 'object') {
    // See walk(): fromEntries keeps a `__proto__` member as a member.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        cfg.fields.some((r) => r.test(k))
          ? typeof v === 'string' || (v && typeof v === 'object')
            ? cfg.replacement
            : v
          : redact(v, cfg, k),
      ]),
    );
  }
  return value;
}
