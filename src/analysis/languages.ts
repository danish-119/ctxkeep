import type { Language } from './types';

/** Extension → Language mapping, independent of tree-sitter grammar loading — usable by lightweight (no-parse) walks. */
export function languageForExtension(ext: string): Language | null {
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
      return 'javascript';
    case '.py':
      return 'python';
    default:
      return null;
  }
}
