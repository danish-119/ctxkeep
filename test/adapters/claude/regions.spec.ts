import { describe, expect, it } from 'vitest';
import { buildAgentsRegions, buildClaudeRegions, buildManifestRegions } from '../../../src/adapters/claude/regions';
import type { AnalysisResult } from '../../../src/analysis/analyzeRepo';

function fakeResult(): AnalysisResult {
  return {
    targetDir: '/repo',
    projectName: 'demo',
    languagesPresent: ['typescript'],
    warnings: [],
    modules: [{ name: 'core', fileCount: 1, languages: ['typescript'], sampleSymbols: [] }],
    parsedFiles: [
      {
        relPath: 'src/core/index.ts',
        language: 'typescript',
        symbols: [
          {
            kind: 'function',
            name: 'run',
            line: 1,
            startIndex: 0,
            endIndex: 10,
            exported: true,
            signatureHash: 'deadbeef',
          },
        ],
      },
    ],
  };
}

describe('region builders are pure functions of AnalysisResult (no wall-clock content)', () => {
  it('buildClaudeRegions produces byte-identical output for the same input, called twice', () => {
    const result = fakeResult();
    expect(buildClaudeRegions(result)).toEqual(buildClaudeRegions(result));
  });

  it('buildAgentsRegions produces byte-identical output for the same input, called twice', () => {
    const result = fakeResult();
    expect(buildAgentsRegions(result)).toEqual(buildAgentsRegions(result));
  });

  it('buildManifestRegions produces byte-identical output for the same input, called twice', () => {
    const result = fakeResult();
    expect(buildManifestRegions(result)).toEqual(buildManifestRegions(result));
  });

  it('manifest content contains no timestamp — a wall-clock value here would defeat patchRegion\'s NO_OP guarantee', () => {
    const [manifestRegion] = buildManifestRegions(fakeResult());
    // ISO-8601-ish pattern: catches accidentally reintroducing `new Date().toISOString()` output.
    expect(manifestRegion.content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
