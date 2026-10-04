import { describe, expect, it } from 'vitest';
import { parseFile } from '../../src/analysis/parser';
import { parseMany } from '../../src/analysis/parsePool';
import { tempDir, writeFiles } from '../helpers';
import type { ParsedFile } from '../../src/analysis/types';

function parse(source: string, filename = 'fixture.ts'): ParsedFile {
  const parsed = parseFile(filename, source);
  if (!parsed) throw new Error(`parseFile returned null for ${filename}`);
  return parsed;
}

const shape = (f: ParsedFile) => f.symbols.map((s) => ({ kind: s.kind, name: s.name, exported: s.exported, isDefault: s.isDefault }));

describe('TS/JS symbol kinds and export status', () => {
  it('labels a non-exported const as a variable, never as an export (v0.1 bug)', () => {
    expect(shape(parse('const db = open();\nexport const VERSION = 2;\n'))).toEqual([
      { kind: 'variable', name: 'db', exported: false, isDefault: false },
      { kind: 'variable', name: 'VERSION', exported: true, isDefault: false },
    ]);
  });

  it('classifies arrow-function consts as functions, and interfaces/types/enums by their own kind', () => {
    const f = parse('export const run = () => 1;\nexport interface A {}\nexport type B = string;\nexport enum C { X }\n');
    expect(f.symbols.map((s) => [s.kind, s.name])).toEqual([
      ['function', 'run'],
      ['interface', 'A'],
      ['type', 'B'],
      ['enum', 'C'],
    ]);
  });

  it('marks `export default function foo` as the default export without duplicating it', () => {
    expect(shape(parse('export default function foo() {}\n'))).toEqual([{ kind: 'function', name: 'foo', exported: true, isDefault: true }]);
  });

  it('`export default Foo` re-labels the existing declaration instead of adding a second symbol', () => {
    expect(shape(parse('class Foo {}\nexport default Foo;\n'))).toEqual([{ kind: 'class', name: 'Foo', exported: true, isDefault: true }]);
  });

  it('local `export { a }` marks the declaration exported', () => {
    expect(shape(parse('function a() {}\nexport { a };\n'))).toEqual([{ kind: 'function', name: 'a', exported: true, isDefault: false }]);
  });

  it('gives each specifier in `export { a, b, c }` its own span (v0.1 id-collision regression)', () => {
    const f = parse('export { a, b, c };\n');
    expect(f.symbols.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(new Set(f.symbols.map((s) => s.startIndex)).size).toBe(3);
  });

  it('records `export * as ns from` as a symbol and as an import', () => {
    const f = parse(`export * as ns from './x';\n`);
    expect(f.symbols.map((s) => s.name)).toEqual(['ns']);
    expect(f.imports).toEqual([{ specifier: './x', names: [] }]);
  });

  it('understands CommonJS exports', () => {
    const f = parse('function a() {}\nfunction b() {}\nmodule.exports = { a };\nexports.c = 1;\n', 'x.js');
    expect(f.symbols.filter((s) => s.exported).map((s) => s.name)).toEqual(['a', 'c']);
  });

  it('parses JSX in .jsx files and TSX in .tsx files', () => {
    expect(parse('export function App() { return <div className="x" />; }\n', 'App.jsx').symbols[0].name).toBe('App');
    expect(parse('export const C = (p: { a: number }) => <span>{p.a}</span>;\n', 'C.tsx').symbols[0].name).toBe('C');
  });
});

describe('TS/JS imports', () => {
  it('captures specifiers and explicitly imported names', () => {
    const f = parse(
      [
        `import def, { a, b as c } from './one';`,
        `import * as ns from '../two';`,
        `import './side-effect';`,
        `import type { T } from './types';`,
        `const { x, y: z } = require('./cjs');`,
        `export { e } from './re';`,
      ].join('\n'),
    );
    expect(f.imports).toEqual([
      { specifier: './one', names: ['default', 'a', 'b'] },
      { specifier: '../two', names: [] },
      { specifier: './side-effect', names: [] },
      { specifier: './types', names: ['T'] },
      { specifier: './cjs', names: ['x', 'y'] },
      { specifier: './re', names: ['e'] },
    ]);
  });
});

describe('Python', () => {
  it('treats non-underscore top-level functions/classes and UPPER_CASE constants as public', () => {
    const f = parse('MAX = 3\n_SECRET = 1\nlimit = 2\ndef run():\n    pass\n\ndef _helper():\n    pass\n\nclass User:\n    pass\n', 'm.py');
    expect(f.symbols.map((s) => [s.kind, s.name, s.exported])).toEqual([
      ['variable', 'MAX', true],
      ['variable', '_SECRET', false],
      ['function', 'run', true],
      ['function', '_helper', false],
      ['class', 'User', true],
    ]);
  });

  it('lets an explicit __all__ define the public API', () => {
    const f = parse('__all__ = ["b"]\ndef a():\n    pass\ndef b():\n    pass\n', 'm.py');
    expect(f.symbols.filter((s) => s.exported).map((s) => s.name)).toEqual(['b']);
  });

  it('captures relative, absolute, and aliased imports', () => {
    const f = parse('from .models import User, Session as S\nfrom . import util\nimport os.path as p\nimport app.db\n', 'm.py');
    expect(f.imports).toEqual([
      { specifier: '.models', names: ['User', 'Session'] },
      { specifier: '.', names: ['util'] },
      { specifier: 'os.path', names: [] },
      { specifier: 'app.db', names: [] },
    ]);
  });

  it('extracts the first sentence of the module docstring', () => {
    expect(parse('"""Billing service. Talks to Stripe."""\n', 'm.py').docSummary).toBe('Billing service.');
  });
});

describe('doc summaries', () => {
  it('reads a leading /** */ block in TS', () => {
    expect(parse('/**\n * HTTP routes for the app.\n * @module\n */\nexport const x = 1;\n').docSummary).toBe('HTTP routes for the app.');
  });

  it('ignores license headers and plain // comments', () => {
    expect(parse('/** Copyright 2026 ACME. MIT License. */\nexport const x = 1;\n').docSummary).toBeNull();
    expect(parse('// just a comment\nexport const x = 1;\n').docSummary).toBeNull();
  });
});

describe('Dart (line-based extractor)', () => {
  it('extracts top-level types, privacy by underscore, directives, and the library doc', () => {
    const f = parse(
      [
        '/// Buttons shared across screens.',
        "import 'package:flutter/material.dart';",
        "import '../theme.dart';",
        "part 'button.g.dart';",
        '',
        'abstract class Base {}',
        'class AppButton extends Base {',
        '  class NotTopLevel {}',
        '}',
        'class _Private {}',
        'enum Size { s, m }',
        'mixin Tappable {}',
        'typedef OnTap = void Function();',
      ].join('\n'),
      'lib/widgets/button.dart',
    );
    expect(f.symbols.map((s) => [s.kind, s.name, s.exported])).toEqual([
      ['class', 'Base', true],
      ['class', 'AppButton', true],
      ['class', '_Private', false],
      ['enum', 'Size', true],
      ['class', 'Tappable', true],
      ['type', 'OnTap', true],
    ]);
    expect(f.imports.map((i) => i.specifier)).toEqual(['package:flutter/material.dart', '../theme.dart', 'button.g.dart']);
    expect(f.docSummary).toBe('Buttons shared across screens.');
  });
});

describe('parseMany (parallel pool)', () => {
  it('returns the same results, in input order, whether it runs threads or falls back to serial', () => {
    const jobs = Array.from({ length: 30 }, (_, i) => ({
      relPath: `src/m${i}.ts`,
      source: `import { x } from './m${(i + 1) % 30}';\nexport function f${i}() {}\nexport const C${i} = ${i};\n`,
    }));
    const root = tempDir('ctxkeep-pool-');
    writeFiles(root, Object.fromEntries(jobs.map((j) => [j.relPath, j.source])));
    const serial = jobs.map((j) => ({ relPath: j.relPath, parsed: parseFile(j.relPath, j.source) }));
    process.env.CTXKEEP_PARSE_THREADS = '3';
    try {
      expect(parseMany(root, jobs)).toEqual(serial);
    } finally {
      delete process.env.CTXKEEP_PARSE_THREADS;
    }
  });
});

describe('unparsed languages', () => {
  it('returns null for languages tracked at file level only', () => {
    expect(parseFile('App.swift', 'class App {}')).toBeNull();
    expect(parseFile('Main.kt', 'class Main')).toBeNull();
  });
});
