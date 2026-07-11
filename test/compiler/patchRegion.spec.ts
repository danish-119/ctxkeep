import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { patchRegion, extractRegionContent } from '../../src/compiler/patchRegion';

/**
 * The single most important correctness property in the MVP (build spec §5):
 * when a region's content hash hasn't changed, patchRegion must not touch the
 * file at all — not "write identical bytes," but literally not open it for
 * writing. Written test-first, before wiring this into `analyze`.
 */

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxkeep-patch-test-'));
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('patchRegion — fresh file', () => {
  it('creates the file with start/end markers around the content and returns WRITTEN', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const result = patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });

    expect(result).toBe('WRITTEN');
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('<!-- ctxkeep:start:overview -->');
    expect(text).toContain('Hello.');
    expect(text).toContain('<!-- ctxkeep:end -->');
  });

  it('records an artifact_binding row with the content hash', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });

    const row = db
      .prepare('SELECT artifact_path, region_id, content_hash FROM artifact_bindings WHERE artifact_path = ? AND region_id = ?')
      .get('CLAUDE.md', 'overview') as { artifact_path: string; region_id: string; content_hash: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe('patchRegion — NO_OP is a literal zero-touch, not just an unchanged-bytes check', () => {
  it('does not open the file for writing on a second call with identical content', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });

    // Make the file read-only at the OS level. If patchRegion attempts ANY write
    // (even rewriting identical bytes), this throws — the test would fail loudly
    // rather than silently passing on a false claim of "no-op".
    fs.chmodSync(filePath, 0o444);

    let result: string;
    try {
      result = patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });
    } finally {
      fs.chmodSync(filePath, 0o644); // restore so afterEach cleanup can remove it
    }

    expect(result).toBe('NO_OP');
  });

  it('running the same compile twice leaves the file byte-identical', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });
    const before = fs.readFileSync(filePath, 'utf8');

    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });
    const after = fs.readFileSync(filePath, 'utf8');

    expect(after).toBe(before);
  });
});

describe('patchRegion — real content change', () => {
  it('returns WRITTEN and replaces only the marked region when content changes', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v1 content' });
    const result = patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v2 content' });

    expect(result).toBe('WRITTEN');
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('v2 content');
    expect(text).not.toContain('v1 content');
  });

  it('preserves human-owned content outside the markers', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# My Project\n\nSome human-written intro.\n', 'utf8');

    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v1' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v2' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('# My Project');
    expect(text).toContain('Some human-written intro.');
    expect(text).toContain('v2');
    expect(text).not.toContain('v1');
  });
});

describe('patchRegion — multiple regions in the same file', () => {
  it('appending a second region does not disturb the first', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview content' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'modules content' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('<!-- ctxkeep:start:overview -->');
    expect(text).toContain('overview content');
    expect(text).toContain('<!-- ctxkeep:start:modules -->');
    expect(text).toContain('modules content');
  });

  it('updating one region leaves the other region\'s content and its own NO_OP status intact', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview v1' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'modules v1' });

    const overviewResult = patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview v2' });
    const modulesResult = patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'modules v1' });

    expect(overviewResult).toBe('WRITTEN');
    expect(modulesResult).toBe('NO_OP');

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('overview v2');
    expect(text).toContain('modules v1');
  });
});

describe('patchRegion — CRLF normalization (found while verifying the fresh-clone .gitignore fix)', () => {
  it('normalizes a CRLF-checked-out file to pure LF when patching, instead of producing mixed line endings', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    // Simulate what `git checkout` produces on Windows with core.autocrlf=true:
    // a pre-existing region already converted to CRLF.
    fs.writeFileSync(
      filePath,
      '<!-- ctxkeep:start:overview -->\r\noverview v1\r\n<!-- ctxkeep:end -->\r\n',
      'utf8',
    );

    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview v2' });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('\r\n');
    expect(raw).toContain('overview v2');
  });

  it('hashes CRLF and LF variants of the same content identically, so NO_OP still applies after a CRLF checkout', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'line one\nline two' });

    // Simulate a CRLF checkout of the file we just wrote, then patch again with
    // the CRLF-flavored version of the exact same logical content.
    const crlfChecked = fs.readFileSync(filePath, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(filePath, crlfChecked, 'utf8');
    fs.chmodSync(filePath, 0o444);

    let result: string;
    try {
      result = patchRegion({
        db,
        filePath,
        artifactPath: 'CLAUDE.md',
        regionId: 'overview',
        newContent: 'line one\r\nline two',
      });
    } finally {
      fs.chmodSync(filePath, 0o644);
    }

    expect(result).toBe('NO_OP');
  });
});

describe('patchRegion — malformed markers', () => {
  it('throws rather than guessing when a start marker has no matching end marker', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '<!-- ctxkeep:start:overview -->\nstuff\n(no end marker)\n', 'utf8');

    expect(() =>
      patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'new content' }),
    ).toThrow(/no matching end marker/);
  });
});

describe('extractRegionContent — the exact inverse of patchRegion, used by `ctxkeep rollback`', () => {
  it('round-trips byte-for-byte for a freshly-appended region (single-line content)', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'Hello.' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(extractRegionContent(text, 'overview')).toBe('Hello.');
  });

  it('round-trips byte-for-byte for multi-line content', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const content = 'line one\nline two\n\nline four (blank line above)';
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: content });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(extractRegionContent(text, 'modules')).toBe(content);
  });

  it('round-trips correctly when the region was spliced in place (not freshly appended)', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v1' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v2 content here' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(extractRegionContent(text, 'overview')).toBe('v2 content here');
  });

  it('extracts only the requested region out of a file with several regions', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview text' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'modules text' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(extractRegionContent(text, 'overview')).toBe('overview text');
    expect(extractRegionContent(text, 'modules')).toBe('modules text');
  });

  it('returns null when the region marker is not present', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'text' });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(extractRegionContent(text, 'does-not-exist')).toBeNull();
  });

  it('handles a CRLF-checked-out file the same as an LF one', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'line one\nline two' });

    const crlfText = fs.readFileSync(filePath, 'utf8').replace(/\n/g, '\r\n');
    expect(extractRegionContent(crlfText, 'overview')).toBe('line one\nline two');
  });
});
