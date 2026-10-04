import crypto from 'node:crypto';
import path from 'node:path';
import Parser from 'tree-sitter';
import TypeScriptLang from 'tree-sitter-typescript';
import JavaScriptLang from 'tree-sitter-javascript';
import PythonLang from 'tree-sitter-python';
import type { ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from './types';
import { languageForPath, type Language } from './languages';
import { parseDart } from './dartParser';

type SyntaxNode = any;
type SymbolDraft = Omit<ParsedSymbol, 'signatureHash'>;

function grammarFor(relPath: string): { grammar: unknown; language: Language } | null {
  const language = languageForPath(relPath);
  const ext = path.extname(relPath).toLowerCase();
  switch (language) {
    case 'typescript':
      return { grammar: ext === '.tsx' ? (TypeScriptLang as any).tsx : (TypeScriptLang as any).typescript, language };
    case 'javascript':
      // The JavaScript grammar parses JSX natively, so .jsx needs no separate grammar.
      return { grammar: JavaScriptLang, language };
    case 'python':
      return { grammar: PythonLang, language };
    default:
      return null;
  }
}

const parsers = new Map<unknown, any>();
function parserFor(grammar: unknown): any {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar as any);
    parsers.set(grammar, parser);
  }
  return parser;
}

/**
 * Parses one Tier-1 file and extracts its TOP-LEVEL symbols and its imports.
 * Returns null for languages that aren't parsed (they're tracked file-level only).
 */
export function parseFile(relPath: string, source: string): ParsedFile | null {
  if (languageForPath(relPath) === 'dart') return parseDart(relPath, source);
  const config = grammarFor(relPath);
  if (!config) return null;

  // node-tree-sitter (0.21.x) truncates/fails past a 32KB input when given a
  // plain string; feeding it as a chunked read callback avoids that limit.
  const tree = parserFor(config.grammar).parse((index: number) => source.slice(index, index + 8192));

  const { drafts, imports } =
    config.language === 'python' ? extractPython(tree.rootNode) : extractJsTs(tree.rootNode);

  const symbols: ParsedSymbol[] = drafts.map((draft) => ({
    ...draft,
    signatureHash: crypto.createHash('sha1').update(source.slice(draft.startIndex, draft.endIndex)).digest('hex'),
  }));

  return { relPath, language: config.language, symbols, imports, docSummary: extractDocSummary(tree.rootNode, config.language) };
}

function draft(kind: SymbolKind, name: string, spanNode: SyntaxNode, exported: boolean): SymbolDraft {
  return {
    kind,
    name,
    line: spanNode.startPosition.row + 1,
    startIndex: spanNode.startIndex,
    endIndex: spanNode.endIndex,
    exported,
    isDefault: false,
  };
}

function stringValue(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    const fragment = (node.namedChildren as SyntaxNode[]).find((c) => c.type === 'string_fragment');
    return fragment ? fragment.text : '';
  }
  return null;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

interface Extracted {
  drafts: SymbolDraft[];
  imports: ParsedImport[];
}

function extractJsTs(root: SyntaxNode): Extracted {
  const drafts: SymbolDraft[] = [];
  const imports: ParsedImport[] = [];
  const commonJsExports = new Set<string>();

  for (const node of root.namedChildren as SyntaxNode[]) {
    collectJsTs(node, drafts, imports, commonJsExports, false);
  }

  // CommonJS: `module.exports = { a, b }` / `module.exports = a` mark existing
  // top-level declarations as exported rather than inventing new symbols.
  if (commonJsExports.size > 0) {
    for (const d of drafts) {
      if (commonJsExports.has(d.name)) d.exported = true;
    }
  }

  return { drafts, imports };
}

function importNamesFromClause(clause: SyntaxNode | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];
  for (const child of clause.namedChildren as SyntaxNode[]) {
    if (child.type === 'identifier') names.push('default');
    if (child.type === 'named_imports') {
      for (const spec of child.namedChildren as SyntaxNode[]) {
        const name = spec.childForFieldName?.('name');
        if (spec.type === 'import_specifier' && name) names.push(name.text);
      }
    }
  }
  return names;
}

function requireSpecifier(value: SyntaxNode | null | undefined): string | null {
  if (!value || value.type !== 'call_expression') return null;
  const fn = value.childForFieldName('function');
  if (!fn || fn.text !== 'require') return null;
  const args = value.childForFieldName('arguments');
  const first = args?.namedChildren?.[0];
  return stringValue(first);
}

function collectJsTs(
  node: SyntaxNode,
  drafts: SymbolDraft[],
  imports: ParsedImport[],
  commonJsExports: Set<string>,
  exported: boolean,
): void {
  const nameOf = (n: SyntaxNode) => n.childForFieldName('name');

  switch (node.type) {
    case 'import_statement': {
      const specifier = stringValue(node.childForFieldName('source'));
      if (specifier !== null) {
        const clause = (node.namedChildren as SyntaxNode[]).find((c) => c.type === 'import_clause');
        imports.push({ specifier, names: importNamesFromClause(clause) });
      }
      return;
    }

    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = nameOf(node);
      if (name) drafts.push(draft('function', name.text, node, exported));
      return;
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = nameOf(node);
      if (name) drafts.push(draft('class', name.text, node, exported));
      return;
    }

    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = nameOf(node);
      const kind: SymbolKind =
        node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'type';
      if (name) drafts.push(draft(kind, name.text, node, exported));
      return;
    }

    case 'lexical_declaration':
    case 'variable_declaration':
      for (const declarator of node.namedChildren as SyntaxNode[]) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');

        const required = requireSpecifier(value);
        if (required !== null) {
          const names =
            name && name.type === 'object_pattern'
              ? (name.namedChildren as SyntaxNode[])
                  .map((p) => (p.type === 'shorthand_property_identifier_pattern' ? p.text : p.childForFieldName?.('key')?.text))
                  .filter((n): n is string => Boolean(n))
              : [];
          imports.push({ specifier: required, names });
          continue;
        }

        if (name && name.type === 'identifier') {
          const isFunction = value && ['arrow_function', 'function_expression', 'function'].includes(value.type);
          drafts.push(draft(isFunction ? 'function' : 'variable', name.text, declarator, exported));
        }
      }
      return;

    case 'expression_statement': {
      // CommonJS export forms: `module.exports = ...` and `exports.name = ...`.
      const expr = node.namedChildren[0];
      if (expr?.type !== 'assignment_expression') return;
      const left = expr.childForFieldName('left');
      const right = expr.childForFieldName('right');
      if (!left || left.type !== 'member_expression') return;
      const target = left.text;
      if (target === 'module.exports') {
        if (right?.type === 'identifier') commonJsExports.add(right.text);
        if (right?.type === 'object') {
          for (const prop of right.namedChildren as SyntaxNode[]) {
            if (prop.type === 'shorthand_property_identifier') commonJsExports.add(prop.text);
            if (prop.type === 'pair') {
              const key = prop.childForFieldName('key');
              if (key) drafts.push(draft('export', key.text, prop, true));
            }
          }
        }
      } else if (target.startsWith('exports.') || target.startsWith('module.exports.')) {
        const prop = left.childForFieldName('property');
        if (prop) drafts.push(draft('export', prop.text, node, true));
      }
      return;
    }

    case 'export_statement': {
      const children = node.children as SyntaxNode[];
      const isDefault = children.some((c) => c.type === 'default');
      const declaration = node.childForFieldName('declaration');
      if (declaration) {
        const before = drafts.length;
        collectJsTs(declaration, drafts, imports, commonJsExports, true);
        if (isDefault) for (const d of drafts.slice(before)) d.isDefault = true;
        return;
      }

      const source = stringValue(node.childForFieldName('source'));

      if (isDefault) {
        const value = node.childForFieldName('value');
        let name = 'default';
        if (value?.type === 'identifier') {
          // `export default Foo` re-labels an existing declaration rather than adding a symbol.
          const existing = drafts.find((d) => d.name === value.text);
          if (existing) {
            existing.exported = true;
            existing.isDefault = true;
            return;
          }
          name = value.text;
        } else {
          const inner = value?.childForFieldName?.('name');
          if (inner) name = inner.text;
        }
        drafts.push({ ...draft('export', name, node, true), isDefault: true });
        return;
      }

      const exportClause = (node.namedChildren as SyntaxNode[]).find((c) => c.type === 'export_clause');
      const namespaceExport = (node.namedChildren as SyntaxNode[]).find((c) => c.type === 'namespace_export');

      if (source !== null) {
        const names = exportClause
          ? (exportClause.namedChildren as SyntaxNode[])
              .map((s) => s.childForFieldName('name')?.text)
              .filter((n): n is string => Boolean(n))
          : [];
        imports.push({ specifier: source, names });
      }

      if (namespaceExport) {
        const id = (namespaceExport.namedChildren as SyntaxNode[]).find((c) => c.type === 'identifier');
        if (id) drafts.push(draft('export', id.text, namespaceExport, true));
      }

      if (exportClause) {
        for (const spec of exportClause.namedChildren as SyntaxNode[]) {
          if (spec.type !== 'export_specifier') continue;
          const alias = spec.childForFieldName('alias');
          const original = spec.childForFieldName('name');
          // A local `export { foo }` marks an existing declaration as exported
          // rather than duplicating it as a second symbol.
          if (!alias && source === null && original) {
            const existing = drafts.find((d) => d.name === original.text);
            if (existing) {
              existing.exported = true;
              continue;
            }
          }
          const finalName = (alias ?? original)?.text;
          // Each specifier gets its OWN span so ids never collide.
          if (finalName) drafts.push(draft('export', finalName, spec, true));
        }
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPython(root: SyntaxNode): Extracted {
  const drafts: SymbolDraft[] = [];
  const imports: ParsedImport[] = [];
  let dunderAll: Set<string> | null = null;

  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case 'function_definition':
      case 'class_definition': {
        const name = node.childForFieldName('name');
        if (name) {
          const kind: SymbolKind = node.type === 'class_definition' ? 'class' : 'function';
          drafts.push(draft(kind, name.text, node, !name.text.startsWith('_')));
        }
        return;
      }
      case 'decorated_definition': {
        const def = node.childForFieldName('definition');
        if (def) visit(def);
        return;
      }
      case 'import_from_statement': {
        const moduleName = node.childForFieldName('module_name');
        if (!moduleName) return;
        const names = (node.children as SyntaxNode[])
          .filter((c) => c !== moduleName && (c.type === 'dotted_name' || c.type === 'aliased_import'))
          .map((c) => (c.type === 'aliased_import' ? c.childForFieldName('name')?.text : c.text))
          .filter((n): n is string => Boolean(n));
        imports.push({ specifier: moduleName.text, names });
        return;
      }
      case 'import_statement': {
        for (const child of node.namedChildren as SyntaxNode[]) {
          const dotted = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
          if (dotted?.type === 'dotted_name') imports.push({ specifier: dotted.text, names: [] });
        }
        return;
      }
      case 'expression_statement': {
        const assignment = node.namedChildren[0];
        if (assignment?.type !== 'assignment') return;
        const left = assignment.childForFieldName('left');
        const right = assignment.childForFieldName('right');
        // Module-level constants (UPPER_CASE by PEP 8) are part of a module's API; other assignments aren't indexed.
        if (left?.type === 'identifier' && /^_?[A-Z][A-Z0-9_]*$/.test(left.text) && left.text !== '__all__') {
          drafts.push(draft('variable', left.text, node, !left.text.startsWith('_')));
          return;
        }
        if (left?.text === '__all__' && right && (right.type === 'list' || right.type === 'tuple')) {
          dunderAll = new Set(
            (right.namedChildren as SyntaxNode[])
              .filter((c) => c.type === 'string')
              .map((c) => (c.namedChildren as SyntaxNode[]).find((s) => s.type === 'string_content')?.text ?? '')
              .filter(Boolean),
          );
        }
        return;
      }
      default:
        return;
    }
  };

  for (const node of root.namedChildren as SyntaxNode[]) visit(node);

  // An explicit `__all__` is the module's declared public API — it overrides
  // the underscore-prefix convention in both directions.
  const declared = dunderAll as Set<string> | null;
  if (declared) {
    for (const d of drafts) d.exported = declared.has(d.name);
  }

  return { drafts, imports };
}

// ---------------------------------------------------------------------------
// File-level doc summary
// ---------------------------------------------------------------------------

const MAX_SUMMARY = 160;

function firstSentence(raw: string): string | null {
  const text = raw
    .replace(/\{@link\s+([^}\s|]+)[^}]*\}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /(\bcopyright\b|\blicen[cs]e\b|eslint-|@ts-|prettier-ignore)/i.test(text)) return null;
  const sentence = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
  return sentence.length > MAX_SUMMARY ? `${sentence.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : sentence;
}

/**
 * The file's own description of itself: a leading `/** ... *\/` block in
 * JS/TS, or the module docstring in Python. Used as a module description
 * only when a human wrote one — CtxKeep never invents prose.
 */
function extractDocSummary(root: SyntaxNode, language: Language): string | null {
  const first = root.namedChildren[0];
  if (!first) return null;
  if (language === 'python') {
    if (first.type !== 'expression_statement') return null;
    const str = first.namedChildren[0];
    if (str?.type !== 'string') return null;
    const content = (str.namedChildren as SyntaxNode[]).find((c) => c.type === 'string_content');
    return content ? firstSentence(content.text) : null;
  }
  if (first.type !== 'comment' || !first.text.startsWith('/**')) return null;
  const body = first.text
    .replace(/^\/\*\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l: string) => l.replace(/^\s*\*\s?/, ''))
    .filter((l: string) => !l.trim().startsWith('@'))
    .join(' ');
  return firstSentence(body);
}
