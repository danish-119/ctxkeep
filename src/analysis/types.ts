export type SymbolKind = 'function' | 'class' | 'export';

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  line: number;
  startIndex: number;
  endIndex: number;
  exported: boolean;
  /** sha1 of the symbol's own source text span — content-based, not signature-only (see build spec §13, later phase). */
  signatureHash: string;
  /** Only meaningful for kind === 'function': does its body contain a try/catch (try_statement)? Used by the Milestone 5 error-handling convention. */
  usesTryCatch: boolean;
}

export type Language = 'typescript' | 'javascript' | 'python';

export interface ParsedFile {
  relPath: string;
  language: Language;
  symbols: ParsedSymbol[];
}
