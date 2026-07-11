import { describe, expect, it } from 'vitest';
import { detectConventionsForModule } from '../../src/analysis/conventions';
import type { ParsedFile, ParsedSymbol } from '../../src/analysis/types';

let counter = 0;

function sym(partial: Partial<ParsedSymbol> & Pick<ParsedSymbol, 'kind' | 'name'>): ParsedSymbol {
  counter += 1;
  return {
    line: 1,
    startIndex: counter * 100,
    endIndex: counter * 100 + 10,
    exported: false,
    signatureHash: `hash-${counter}`,
    usesTryCatch: false,
    ...partial,
  };
}

function file(relPath: string, symbols: ParsedSymbol[]): ParsedFile {
  return { relPath, language: 'typescript', symbols };
}

describe('detectConventionsForModule — export style', () => {
  it('detects a dominant named-export style with correct confidence', () => {
    const files = [
      file('src/mod/a.ts', [sym({ kind: 'export', name: 'foo', exported: true })]),
      file('src/mod/b.ts', [sym({ kind: 'export', name: 'bar', exported: true })]),
      file('src/mod/c.ts', [sym({ kind: 'export', name: 'default', exported: true })]), // the odd one out
    ];

    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'export-style');
    expect(convention.confidence).toBeCloseTo(2 / 3);
    expect(convention.statement).toContain('named exports');
    expect(convention.evidenceFilePaths.sort()).toEqual(['src/mod/a.ts', 'src/mod/b.ts']);
  });

  it('does not emit an export-style convention when fewer than 2 files have exports', () => {
    const files = [file('src/mod/a.ts', [sym({ kind: 'export', name: 'foo', exported: true })])];
    expect(detectConventionsForModule('mod', files).some((c) => c.patternType === 'export-style')).toBe(false);
  });

  it('ignores files with no exported symbols entirely', () => {
    const files = [
      file('src/mod/a.ts', [sym({ kind: 'function', name: 'internalOnly', exported: false })]),
      file('src/mod/b.ts', [sym({ kind: 'export', name: 'foo', exported: true })]),
      file('src/mod/c.ts', [sym({ kind: 'export', name: 'bar', exported: true })]),
    ];
    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'export-style');
    expect(convention.confidence).toBe(1); // both files WITH exports agree; the non-exporting file isn't counted
  });
});

describe('detectConventionsForModule — error handling', () => {
  it('detects a dominant try/catch-using pattern', () => {
    const files = [
      file('src/mod/a.ts', [sym({ kind: 'function', name: 'f1', usesTryCatch: true })]),
      file('src/mod/b.ts', [sym({ kind: 'function', name: 'f2', usesTryCatch: true })]),
      file('src/mod/c.ts', [sym({ kind: 'function', name: 'f3', usesTryCatch: false })]),
    ];
    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'error-handling');
    expect(convention.confidence).toBeCloseTo(2 / 3);
    expect(convention.statement).toContain('use try/catch');
  });

  it('detects a dominant no-try/catch pattern when that is the majority', () => {
    const files = [
      file('src/mod/a.ts', [sym({ kind: 'function', name: 'f1', usesTryCatch: false })]),
      file('src/mod/b.ts', [sym({ kind: 'function', name: 'f2', usesTryCatch: false })]),
    ];
    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'error-handling');
    expect(convention.confidence).toBe(1);
    expect(convention.statement).toContain('no detected try/catch');
  });

  it('ignores non-function symbols (classes, exports) when counting', () => {
    const files = [
      file('src/mod/a.ts', [sym({ kind: 'class', name: 'Thing' }), sym({ kind: 'export', name: 'x', exported: true })]),
    ];
    expect(detectConventionsForModule('mod', files).some((c) => c.patternType === 'error-handling')).toBe(false);
  });
});

describe('detectConventionsForModule — file naming', () => {
  it('detects dominant kebab-case naming, ratio over ALL files including ambiguous ones', () => {
    const files = [
      file('src/mod/my-file-one.ts', []),
      file('src/mod/my-file-two.ts', []),
      file('src/mod/index.ts', []), // ambiguous single word — still counts in the denominator
    ];
    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'file-naming');
    expect(convention.confidence).toBeCloseTo(2 / 3);
    expect(convention.statement).toContain('kebab-case');
  });

  it('detects dominant camelCase naming', () => {
    const files = [file('src/mod/myFileOne.ts', []), file('src/mod/myFileTwo.ts', []), file('src/mod/otherThing.ts', [])];
    const [convention] = detectConventionsForModule('mod', files).filter((c) => c.patternType === 'file-naming');
    expect(convention.confidence).toBe(1);
    expect(convention.statement).toContain('camelCase');
  });

  it('emits nothing when every file name is ambiguous (no decidable style)', () => {
    const files = [file('src/mod/index.ts', []), file('src/mod/types.ts', [])];
    expect(detectConventionsForModule('mod', files).some((c) => c.patternType === 'file-naming')).toBe(false);
  });

  it('does not emit a file-naming convention for a single-file module', () => {
    const files = [file('src/mod/my-file.ts', [])];
    expect(detectConventionsForModule('mod', files).some((c) => c.patternType === 'file-naming')).toBe(false);
  });
});
