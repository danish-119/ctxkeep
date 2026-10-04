import type { Language } from './languages';

export type { Language } from './languages';

/**
 * `export` is reserved for symbols that only exist as an export binding
 * (`export { a as b }`, `export default <expr>`). A non-exported `const` is a
 * `variable`, never an `export` — v0.1 conflated the two, which made local
 * test helpers show up in CLAUDE.md labelled as exports.
 */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'export';

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  line: number;
  startIndex: number;
  endIndex: number;
  /** Part of the file's public surface: an ES export, or a non-underscore top-level Python name. */
  exported: boolean;
  /** The file's default export (`export default ...`). */
  isDefault: boolean;
  /** sha1 of the symbol's own source span. */
  signatureHash: string;
}

/** A local (repo-relative) dependency of a file, resolved from an import statement. */
export interface ParsedImport {
  /** The raw specifier as written, e.g. `./util` or `.models`. */
  specifier: string;
  /** Names imported explicitly (`import { a, b }`, `from x import a`). Empty for namespace/side-effect imports. */
  names: string[];
}

export interface ParsedFile {
  relPath: string;
  language: Language;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** First sentence of the file's leading doc comment / module docstring, if it has one. */
  docSummary: string | null;
}
