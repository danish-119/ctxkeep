// Native tree-sitter language bindings ship no TypeScript declarations.
// Treated as `any` here; the parsing code narrows what it needs at runtime.
declare module 'tree-sitter';
declare module 'tree-sitter-javascript';
declare module 'tree-sitter-typescript';
declare module 'tree-sitter-python';
