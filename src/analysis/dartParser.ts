import type { ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from './types';

/**
 * Line-based extraction for Dart (there's no tree-sitter-dart grammar
 * compatible with the pinned tree-sitter core — see DECISIONS.md). This is
 * reliable rather than heuristic because `dart format` — which virtually all
 * Flutter code is run through — puts every top-level declaration at column
 * 0 and every directive on its own line. Only top-level TYPES and
 * directives are extracted; top-level functions and fields are not, since
 * their syntax isn't distinguishable from a line alone.
 */

const DIRECTIVE_RE = /^(import|export|part)\s+['"]([^'"]+)['"]/;
const TYPE_RE = /^(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*(class|mixin|enum|extension\s+type|typedef)\s+([A-Za-z_$][\w$]*)/;
const LIBRARY_DOC_RE = /^\/\/\/\s?(.*)$/;

export function parseDart(relPath: string, source: string): ParsedFile {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  let offset = 0;
  let inBlockComment = false;
  const docLines: string[] = [];
  let docDone = false;

  lines.forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;

    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      return;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      return;
    }

    // A file-level `///` doc block before the first declaration.
    const doc = LIBRARY_DOC_RE.exec(line);
    if (doc && !docDone) {
      docLines.push(doc[1]);
      return;
    }
    if (line.trim() !== '') docDone = true;

    const directive = DIRECTIVE_RE.exec(line);
    if (directive) {
      imports.push({ specifier: directive[2], names: [] });
      return;
    }

    const type = TYPE_RE.exec(line);
    if (type) {
      const keyword = type[1].replace(/\s+/g, ' ');
      const kind: SymbolKind = keyword === 'enum' ? 'enum' : keyword === 'typedef' ? 'type' : 'class';
      const name = type[2];
      symbols.push({
        kind,
        name,
        line: i + 1,
        startIndex: start,
        endIndex: start + line.length,
        exported: !name.startsWith('_'), // Dart privacy is lexical: a leading underscore is library-private
        isDefault: false,
        signatureHash: '',
      });
    }
  });

  const summary = docLines.join(' ').replace(/\s+/g, ' ').trim();
  const sentence = summary.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? summary;
  return { relPath, language: 'dart', symbols, imports, docSummary: sentence || null };
}
