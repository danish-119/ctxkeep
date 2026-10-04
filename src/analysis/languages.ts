import path from 'node:path';

/**
 * Every language CtxKeep tracks at the file level. Only the three Tier-1
 * languages (TypeScript, JavaScript, Python) are parsed for symbols and
 * imports; everything else is still counted, grouped into modules, and
 * change-tracked, so a Swift/Kotlin/Dart/Go repo gets an accurate layout,
 * stack, and commands section even though its symbols aren't indexed.
 */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'swift'
  | 'kotlin'
  | 'java'
  | 'dart'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'c'
  | 'cpp'
  | 'objective-c'
  | 'ruby'
  | 'php'
  | 'scala'
  | 'elixir'
  | 'vue'
  | 'svelte'
  | 'jupyter';

/**
 * Languages whose symbols and imports are indexed: TypeScript, JavaScript,
 * and Python with tree-sitter; Dart with a line-based extractor (top-level
 * types and directives — see dartParser.ts).
 */
export const PARSED_LANGUAGES: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'python', 'dart']);

const EXTENSIONS: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.java': 'java',
  '.dart': 'dart',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.rb': 'ruby',
  '.php': 'php',
  '.scala': 'scala',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.ipynb': 'jupyter',
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  swift: 'Swift',
  kotlin: 'Kotlin',
  java: 'Java',
  dart: 'Dart',
  go: 'Go',
  rust: 'Rust',
  csharp: 'C#',
  c: 'C',
  cpp: 'C++',
  'objective-c': 'Objective-C',
  ruby: 'Ruby',
  php: 'PHP',
  scala: 'Scala',
  elixir: 'Elixir',
  vue: 'Vue',
  svelte: 'Svelte',
  jupyter: 'Jupyter',
};

/** Extension → Language mapping, independent of tree-sitter grammar loading. */
export function languageForExtension(ext: string): Language | null {
  return EXTENSIONS[ext.toLowerCase()] ?? null;
}

export function languageForPath(relPath: string): Language | null {
  // `.d.ts` declaration files are type stubs, not source — tracking them as
  // TypeScript would index ambient declarations as if they were the API.
  if (relPath.endsWith('.d.ts')) return null;
  return languageForExtension(path.extname(relPath));
}

export function isParsedLanguage(language: Language): boolean {
  return PARSED_LANGUAGES.has(language);
}
