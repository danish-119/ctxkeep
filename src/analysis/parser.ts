import crypto from 'node:crypto';
import path from 'node:path';
import Parser from 'tree-sitter';
import TypeScriptLang from 'tree-sitter-typescript';
import JavaScriptLang from 'tree-sitter-javascript';
import PythonLang from 'tree-sitter-python';
import type { Language, ParsedFile, ParsedSymbol, SymbolKind } from './types';
import { languageForExtension } from './languages';

type SyntaxNode = any;
// Constructed before signatureHash is computed (needs the full source text, added in a final pass).
type SymbolDraft = Omit<ParsedSymbol, 'signatureHash'>;

interface LanguageConfig {
  grammar: unknown;
  language: Language;
}

function configForExtension(ext: string): LanguageConfig | null {
  const language = languageForExtension(ext);
  if (!language) return null;

  switch (ext) {
    case '.ts':
      return { grammar: (TypeScriptLang as any).typescript, language };
    case '.tsx':
      return { grammar: (TypeScriptLang as any).tsx, language };
    case '.js':
      return { grammar: JavaScriptLang, language };
    case '.py':
      return { grammar: PythonLang, language };
    default:
      return null;
  }
}

/**
 * Parses a single file and extracts TOP-LEVEL functions, classes, and exports
 * only. Deliberately does not walk into function bodies or build a call graph
 * — that's later-milestone scope (see docs/ctxkeep-mvp-build-spec.md §4).
 */
export function parseFile(absPath: string, relPath: string, source: string): ParsedFile | null {
  const ext = path.extname(absPath).toLowerCase();
  const config = configForExtension(ext);
  if (!config) return null;

  const parser = new Parser();
  parser.setLanguage(config.grammar as any);
  // node-tree-sitter (0.21.x) truncates/fails past a 32KB input when given a
  // plain string; feeding it as a chunked read callback avoids that limit.
  const tree = parser.parse((index: number) => source.slice(index, index + 8192));

  const drafts =
    config.language === 'python'
      ? extractPythonSymbols(tree.rootNode)
      : extractJsTsSymbols(tree.rootNode);

  const symbols: ParsedSymbol[] = drafts.map((draft) => ({
    ...draft,
    signatureHash: hashSpan(source, draft.startIndex, draft.endIndex),
  }));

  return { relPath, language: config.language, symbols };
}

function hashSpan(source: string, startIndex: number, endIndex: number): string {
  return crypto.createHash('sha1').update(source.slice(startIndex, endIndex)).digest('hex');
}

/**
 * Recursively checks a node's own subtree for a try_statement. Used only for
 * kind === 'function' symbols, to feed the Milestone 5 error-handling convention —
 * this walks the tree we already parsed, it doesn't add any new grammar/
 * language capability.
 */
function containsTryStatement(node: SyntaxNode): boolean {
  if (node.type === 'try_statement') return true;
  for (const child of node.namedChildren as SyntaxNode[]) {
    if (containsTryStatement(child)) return true;
  }
  return false;
}

function pushSymbol(
  symbols: SymbolDraft[],
  kind: SymbolKind,
  nameNode: SyntaxNode | null | undefined,
  spanNode: SyntaxNode,
  exported: boolean,
): void {
  if (!nameNode) return;
  symbols.push({
    kind,
    name: nameNode.text,
    line: spanNode.startPosition.row + 1,
    startIndex: spanNode.startIndex,
    endIndex: spanNode.endIndex,
    exported,
    usesTryCatch: kind === 'function' && containsTryStatement(spanNode),
  });
}

function extractJsTsSymbols(root: SyntaxNode): SymbolDraft[] {
  const symbols: SymbolDraft[] = [];
  for (const node of root.namedChildren as SyntaxNode[]) {
    collectJsTsNode(node, symbols, false);
  }
  return symbols;
}

function collectJsTsNode(node: SyntaxNode, symbols: SymbolDraft[], forceExported: boolean): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      pushSymbol(symbols, 'function', node.childForFieldName('name'), node, forceExported);
      return;

    case 'class_declaration':
    case 'abstract_class_declaration':
      pushSymbol(symbols, 'class', node.childForFieldName('name'), node, forceExported);
      return;

    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
      pushSymbol(symbols, 'export', node.childForFieldName('name'), node, forceExported);
      return;

    case 'lexical_declaration':
    case 'variable_declaration':
      for (const declarator of node.namedChildren as SyntaxNode[]) {
        if (declarator.type === 'variable_declarator') {
          const name = declarator.childForFieldName('name');
          if (name && name.type === 'identifier') {
            pushSymbol(symbols, 'export', name, declarator, forceExported);
          }
        }
      }
      return;

    case 'export_statement': {
      const declaration = node.childForFieldName('declaration');
      if (declaration) {
        collectJsTsNode(declaration, symbols, true);
        return;
      }

      const isDefault = (node.children as SyntaxNode[]).some((c) => c.type === 'default');
      if (isDefault) {
        const value = node.childForFieldName('value') ?? node.childForFieldName('declaration');
        let name = 'default';
        if (value) {
          if (value.type === 'identifier') name = value.text;
          else {
            const inner = value.childForFieldName?.('name');
            if (inner) name = inner.text;
          }
        }
        symbols.push({
          kind: 'export',
          name,
          line: node.startPosition.row + 1,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          exported: true,
          usesTryCatch: false,
        });
        return;
      }

      const exportClause = (node.namedChildren as SyntaxNode[]).find((c) => c.type === 'export_clause');
      if (exportClause) {
        for (const spec of exportClause.namedChildren as SyntaxNode[]) {
          if (spec.type === 'export_specifier') {
            const alias = spec.childForFieldName('alias');
            const original = spec.childForFieldName('name');
            const finalName = (alias ?? original)?.text;
            // Each specifier gets its OWN span (not the whole `export { a, b, c }`
            // statement) — sharing one span across specifiers produced identical
            // (file, startIndex) pairs, which collided as SQLite primary keys.
            if (finalName) {
              symbols.push({
                kind: 'export',
                name: finalName,
                line: spec.startPosition.row + 1,
                startIndex: spec.startIndex,
                endIndex: spec.endIndex,
                exported: true,
                usesTryCatch: false,
              });
            }
          }
        }
      }
      return;
    }

    default:
      return;
  }
}

function extractPythonSymbols(root: SyntaxNode): SymbolDraft[] {
  const symbols: SymbolDraft[] = [];
  for (const node of root.namedChildren as SyntaxNode[]) {
    collectPythonNode(node, symbols);
  }
  return symbols;
}

function collectPythonNode(node: SyntaxNode, symbols: SymbolDraft[]): void {
  switch (node.type) {
    case 'function_definition':
      pushSymbol(symbols, 'function', node.childForFieldName('name'), node, false);
      return;
    case 'class_definition':
      pushSymbol(symbols, 'class', node.childForFieldName('name'), node, false);
      return;
    case 'decorated_definition': {
      const def = node.childForFieldName('definition');
      if (def) collectPythonNode(def, symbols);
      return;
    }
    default:
      return;
  }
}
