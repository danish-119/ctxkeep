import { describe, expect, it } from 'vitest';
import { parseFile } from '../../src/analysis/parser';
import type { ParsedSymbol } from '../../src/analysis/types';

function extract(source: string, filename = 'fixture.ts'): ParsedSymbol[] {
  const parsed = parseFile(filename, filename, source);
  if (!parsed) throw new Error(`parseFile returned null for ${filename}`);
  return parsed.symbols;
}

/** Mirrors graph/write.ts's id formula — the thing that actually broke in Milestone 2. */
function symbolIds(symbols: ParsedSymbol[], filePath = 'fixture.ts'): string[] {
  return symbols.map((s) => `${filePath}:${s.startIndex}:${s.name}`);
}

function expectNoIdCollisions(symbols: ParsedSymbol[]): void {
  const ids = symbolIds(symbols);
  expect(new Set(ids).size).toBe(ids.length);
}

describe('export-clause id collision (Milestone 2 bug) — regression', () => {
  it('gives each specifier in `export { a, b, c }` its own span', () => {
    const symbols = extract('export { a, b, c };\n');
    expect(symbols.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    // The original bug: all three shared the enclosing statement's span.
    const spans = symbols.map((s) => `${s.startIndex}-${s.endIndex}`);
    expect(new Set(spans).size).toBe(3);
    expectNoIdCollisions(symbols);
  });
});

describe('other multi-binding / default export shapes (sanity check before Milestone 3)', () => {
  it('handles re-export with rename: export { a as b } from "./x"', () => {
    const symbols = extract(`export { a as b } from './x';\n`);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ kind: 'export', name: 'b', exported: true });
    expectNoIdCollisions(symbols);
  });

  it('handles multi-specifier re-export with rename without collisions', () => {
    // Two specifiers in one re-export clause — the exact shape of the Milestone 2 bug,
    // but with a `from` clause attached. Confirms the fix isn't specific to the
    // no-`from` form.
    const symbols = extract(`export { a as x, b as y } from './mod';\n`);
    expect(symbols.map((s) => s.name)).toEqual(['x', 'y']);
    expectNoIdCollisions(symbols);
  });

  it('star re-export (export * from "./x") produces no symbols, and does not crash', () => {
    // No local name is introduced by a bare star re-export, so emitting nothing
    // is correct — not a regression of the collision bug (there's nothing to collide).
    const symbols = extract(`export * from './x';\n`);
    expect(symbols).toEqual([]);
  });

  it('star-as re-export (export * as ns from "./x") does not crash (documented gap, not this bug class)', () => {
    // `ns` IS a real named binding our extractor currently misses entirely (produces
    // zero symbols instead of one). That's a coverage gap, not the Milestone 2 collision
    // bug (nothing collides — nothing is emitted at all). Left as a known gap per
    // the user's ask, which was scoped to the collision bug class specifically;
    // logged here so it isn't silently lost.
    const symbols = extract(`export * as ns from './x';\n`);
    expect(symbols).toEqual([]);
  });

  it('anonymous default function export: export default function() {}', () => {
    const symbols = extract('export default function() {\n  return 1;\n}\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ kind: 'export', name: 'default', exported: true });
  });

  it('anonymous default class export: export default class {}', () => {
    const symbols = extract('export default class {\n  foo() {}\n}\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ kind: 'export', name: 'default', exported: true });
  });

  it('anonymous default arrow export: export default () => {}', () => {
    const symbols = extract('export default () => {};\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ kind: 'export', name: 'default', exported: true });
  });

  it('a file combining several of the above shapes still has zero id collisions', () => {
    const symbols = extract(`
      export { a, b, c };
      export { x as y } from './mod';
      export * from './other';
      export default function () { return 42; }
    `);
    expectNoIdCollisions(symbols);
  });
});

describe('Python: no analogous multi-binding shape for this extraction method', () => {
  it('does not extract `from x import a, b, c` as symbols (imports are out of scope, not a bug)', () => {
    // Python has no "export" keyword; our extractor only pulls top-level
    // function/class definitions (build spec §4 Milestone 1 scope). Import
    // statements were never extracted, so there's no multi-binding shape
    // here for the Milestone 2 bug class to apply to. Asserting this explicitly
    // so it isn't rediscovered as a mystery gap later.
    const symbols = extract('from x import a, b, c\n', 'fixture.py');
    expect(symbols).toEqual([]);
  });

  it('does not extract `import a, b` as symbols, and does not crash', () => {
    const symbols = extract('import a, b\n', 'fixture.py');
    expect(symbols).toEqual([]);
  });

  it('still extracts ordinary top-level def/class correctly alongside unrelated imports', () => {
    const symbols = extract('import os\n\ndef foo():\n    pass\n\nclass Bar:\n    pass\n', 'fixture.py');
    expect(symbols.map((s) => s.name)).toEqual(['foo', 'Bar']);
    expectNoIdCollisions(symbols);
  });
});
