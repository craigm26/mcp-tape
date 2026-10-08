import { readFile } from 'node:fs/promises';
import { compilePath } from './jsonpath.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyPathRules, type PathRule, REPLACEMENT } from './redact.js';

interface RawRule {
  type: 'regex' | 'path';
  pattern?: string;
  path?: string;
}

interface RawFile {
  extends?: 'default' | null;
  rules?: RawRule[];
}

export interface CompiledRedact {
  regexes: RegExp[];
  pathRules: PathRule[];
  replacement: string;
}

interface LoadOpts {
  overridePath: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dirname, '..', 'default-redact.json');

export async function loadRedactConfig(opts: LoadOpts): Promise<CompiledRedact> {
  const defaults = await readJson(DEFAULT_PATH);
  const defaultRules = (defaults.rules ?? []) as RawRule[];

  let rules: RawRule[];
  if (opts.overridePath) {
    const user = await readJson(opts.overridePath);
    const userRules = (user.rules ?? []) as RawRule[];
    const extendsDefault = user.extends === undefined || user.extends === 'default';
    rules = extendsDefault ? [...defaultRules, ...userRules] : userRules;
  } else {
    rules = defaultRules;
  }

  return compile(rules);
}

async function readJson(path: string): Promise<RawFile> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text) as RawFile;
}

function compile(rules: readonly RawRule[]): CompiledRedact {
  const regexes: RegExp[] = [];
  const pathRules: PathRule[] = [];
  for (const r of rules) {
    if (r.type === 'regex') {
      if (!r.pattern) throw new Error(`redact rule: regex missing pattern`);
      regexes.push(new RegExp(r.pattern, 'g'));
    } else if (r.type === 'path') {
      if (!r.path) throw new Error(`redact rule: path missing path`);
      pathRules.push({ path: r.path, segments: compilePath(r.path) });
    } else {
      throw new Error(`redact rule: unknown type ${(r as RawRule).type}`);
    }
  }
  return { regexes, pathRules, replacement: REPLACEMENT };
}

export function redactWithConfig(value: unknown, cfg: CompiledRedact): unknown {
  const afterPath = applyPathRules(value, cfg.pathRules);
  return applyRegexes(afterPath, cfg);
}

/** The string rules alone, for text that isn't under any key (the command line). */
export function redactStringWithConfig(value: string, cfg: CompiledRedact): string {
  return applyRegexes(value, cfg) as string;
}

function applyRegexes(value: unknown, cfg: CompiledRedact): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const r of cfg.regexes) {
      r.lastIndex = 0;
      out = out.replace(r, cfg.replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => applyRegexes(v, cfg));
  if (value && typeof value === 'object') {
    // fromEntries defines each member, so a member named `__proto__` stays a
    // member (assigning to obj['__proto__'] would set the prototype instead).
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, applyRegexes(v, cfg)]),
    );
  }
  return value;
}
