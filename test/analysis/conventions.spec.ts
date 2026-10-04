import { describe, expect, it } from 'vitest';
import { classifyFileName, detectConventions } from '../../src/analysis/conventions';
import { buildModel } from '../../src/analysis/model';
import { refreshGraph } from '../../src/analysis/refresh';
import { openMemoryGraph } from '../../src/graph/db';
import { tempDir, writeFiles } from '../helpers';

function detect(files: Record<string, string>) {
  const root = tempDir('ctxkeep-conv-');
  writeFiles(root, files);
  const db = openMemoryGraph();
  refreshGraph(db, root);
  return detectConventions(buildModel(db, root));
}

const named = (n: string) => `export function ${n}() {}\n`;

describe('convention inference is strict: well-sampled and near-unanimous, or nothing', () => {
  it('proposes named-exports-only when every file agrees, with a count-free statement', () => {
    const found = detect({ 'src/api/a.ts': named('a'), 'src/api/b.ts': named('b'), 'src/api/c.ts': named('c') });
    const c = found.find((x) => x.patternType === 'export-style')!;
    expect(c).toMatchObject({ moduleId: 'src/api', value: 'named', matched: 3, sampleSize: 3 });
    expect(c.statement).toBe('Files in `src/api/` use named exports only (no default exports).');
  });

  it('proposes nothing below 80% agreement (v0.1 proposed 2-of-3 "conventions")', () => {
    const found = detect({
      'src/api/a.ts': named('a'),
      'src/api/b.ts': named('b'),
      'src/api/c.ts': 'export default function c() {}\n',
    });
    expect(found.some((x) => x.patternType === 'export-style')).toBe(false);
  });

  it('proposes nothing from fewer than 3 samples', () => {
    expect(detect({ 'src/api/a.ts': named('a'), 'src/api/b.ts': named('b') })).toEqual([]);
  });

  it('never proposes "absence" patterns such as missing try/catch', () => {
    const found = detect({ 'src/x/a.ts': named('a'), 'src/x/b.ts': named('b'), 'src/x/c.ts': named('c') });
    expect(found.map((x) => x.patternType)).not.toContain('error-handling');
  });

  it('detects file naming only from multi-word names (single words fit every style)', () => {
    expect(classifyFileName('index')).toBeNull();
    expect(classifyFileName('User')).toBeNull();
    expect(classifyFileName('format-price')).toBe('kebab-case');
    expect(classifyFileName('ProductCard')).toBe('PascalCase');
    expect(classifyFileName('tool_registry')).toBe('snake_case');
    expect(classifyFileName('apiClient')).toBe('camelCase');

    const found = detect({
      'src/ui/ProductCard.tsx': named('A'),
      'src/ui/CartButton.tsx': named('B'),
      'src/ui/NavBar.tsx': named('C'),
      'src/ui/index.ts': named('D'),
    });
    expect(found.find((x) => x.patternType === 'file-naming')).toMatchObject({ value: 'PascalCase', matched: 3, sampleSize: 3 });
  });

  it('detects where tests live and how they are named, ignoring fixtures', () => {
    const found = detect({
      'src/a.ts': named('a'),
      'tests/test_a.py': 'def test_a():\n    pass\n',
      'tests/test_b.py': 'def test_b():\n    pass\n',
      'tests/test_c.py': 'def test_c():\n    pass\n',
      'tests/fixtures/sample/x_test.py': 'X = 1\n',
    });
    expect(found.find((x) => x.patternType === 'test-location')).toMatchObject({ value: 'dir:tests', matched: 3 });
    expect(found.find((x) => x.patternType === 'test-naming')).toMatchObject({ value: 'test-prefix', matched: 3 });
  });

  it('detects colocated tests', () => {
    const found = detect({
      'src/a.ts': named('a'),
      'src/a.test.ts': 'test("x", () => {});\n',
      'src/b.test.ts': 'test("x", () => {});\n',
      'src/c.test.ts': 'test("x", () => {});\n',
    });
    expect(found.find((x) => x.patternType === 'test-location')?.statement).toBe('Tests are colocated with the source files they cover.');
  });
});
