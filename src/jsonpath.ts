export type Segment =
  | { type: 'field'; name: string }
  | { type: 'index'; idx: number }
  | { type: 'wildcard' }
  | { type: 'descend'; name: string };

export function compilePath(pattern: string): Segment[] {
  if (!pattern.startsWith('$')) {
    throw new Error(`JSONPath must start with $: ${pattern}`);
  }
  const segs: Segment[] = [];
  let i = 1;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '.') {
      if (pattern[i + 1] === '.') {
        let j = i + 2;
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j]!)) j++;
        const name = pattern.slice(i + 2, j);
        if (!name) throw new Error(`JSONPath descend missing field: ${pattern}`);
        segs.push({ type: 'descend', name });
        i = j;
      } else {
        let j = i + 1;
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j]!)) j++;
        const name = pattern.slice(i + 1, j);
        if (!name) throw new Error(`JSONPath field missing name: ${pattern}`);
        segs.push({ type: 'field', name });
        i = j;
      }
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) throw new Error(`JSONPath unclosed [: ${pattern}`);
      const inner = pattern.slice(i + 1, end);
      if (inner === '*') {
        segs.push({ type: 'wildcard' });
      } else {
        const n = Number(inner);
        if (!Number.isInteger(n)) throw new Error(`JSONPath bad index: ${inner}`);
        segs.push({ type: 'index', idx: n });
      }
      i = end + 1;
    } else {
      throw new Error(`JSONPath unexpected char at ${i}: ${pattern}`);
    }
  }
  return segs;
}

export function matchPath(pattern: string, path: readonly string[]): boolean {
  // Kept for back-compat. Prefer matchSegments(compilePath(pattern), path).
  return matchSegments(compilePath(pattern), path);
}

export function matchSegments(segs: Segment[], path: readonly string[]): boolean {
  return matchSegs(segs, 0, path, 0);
}

function matchSegs(segs: Segment[], si: number, path: readonly string[], pi: number): boolean {
  if (si === segs.length) return pi === path.length;
  const seg = segs[si]!;
  if (seg.type === 'descend') {
    for (let k = pi; k < path.length; k++) {
      if (path[k] === seg.name) {
        if (matchSegs(segs, si + 1, path, k + 1)) return true;
      }
    }
    return false;
  }
  if (pi >= path.length) return false;
  if (seg.type === 'field') {
    if (path[pi] !== seg.name) return false;
    return matchSegs(segs, si + 1, path, pi + 1);
  }
  if (seg.type === 'index') {
    if (path[pi] !== String(seg.idx)) return false;
    return matchSegs(segs, si + 1, path, pi + 1);
  }
  // wildcard
  return matchSegs(segs, si + 1, path, pi + 1);
}
