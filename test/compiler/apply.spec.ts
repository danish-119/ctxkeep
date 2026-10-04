import { describe, expect, it } from 'vitest';
import { applyRegions, type ApplyInput } from '../../src/compiler/apply';
import { contentHash, formatRegion, MarkerError, parseRegions } from '../../src/compiler/markers';

const never = () => false;
const apply = (input: Partial<ApplyInput> & Pick<ApplyInput, 'existing' | 'desired'>) =>
  applyRegions({ fileLabel: 'X.md', isOrphan: never, ...input });

describe('marker format', () => {
  it('round-trips: formatRegion → parseRegions recovers id, content, and a matching hash', () => {
    const text = `${formatRegion('module:src/api', 'line one\n\nline three')}\n`;
    const [r] = parseRegions(text, 'X.md');
    expect(r).toMatchObject({ id: 'module:src/api', content: 'line one\n\nline three', sha: contentHash('line one\n\nline three'), legacy: false });
  });

  it('reads v0.1 markers (no hash, generic end) as legacy', () => {
    const [r] = parseRegions('<!-- ctxkeep:start:overview -->\nold\n<!-- ctxkeep:end -->\n', 'X.md');
    expect(r).toMatchObject({ id: 'overview', content: 'old', sha: null, legacy: true });
  });

  it('ignores marker syntax inside fenced code blocks (docs that show examples)', () => {
    const text = '```md\n<!-- ctxkeep:start:overview -->\n```\n';
    expect(parseRegions(text, 'X.md')).toEqual([]);
  });

  it('refuses to guess on malformed markers, naming the file and line', () => {
    expect(() => parseRegions('<!-- ctxkeep:start:a sha=000000000000 -->\nno end\n', 'X.md')).toThrow(/X\.md:1: region "a" has no end marker/);
    expect(() => parseRegions('<!-- ctxkeep:end:a -->\n', 'X.md')).toThrow(MarkerError);
    expect(() =>
      parseRegions('<!-- ctxkeep:start:a -->\n<!-- ctxkeep:start:b -->\n<!-- ctxkeep:end:b -->\n<!-- ctxkeep:end:a -->\n', 'X.md'),
    ).toThrow(/nested or unterminated/);
    expect(() => parseRegions('<!-- ctxkeep:start:a -->\n<!-- ctxkeep:end:b -->\n', 'X.md')).toThrow(/closes region "a"/);
  });
});

describe('applyRegions', () => {
  it('creates a new file: header, then regions in order', () => {
    const out = apply({ existing: null, desired: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], header: '# Title' });
    expect(out.text).toBe(`# Title\n\n${formatRegion('a', 'A')}\n\n${formatRegion('b', 'B')}\n`);
    expect(out.outcomes.map((o) => o.status)).toEqual(['added', 'added']);
  });

  it('is a no-op (changed: false, identical text) when every region is already correct', () => {
    const existing = `intro\n\n${formatRegion('a', 'A')}\n`;
    const out = apply({ existing, desired: [{ id: 'a', content: 'A' }] });
    expect(out.changed).toBe(false);
    expect(out.text).toBe(existing);
  });

  it('never modifies text outside markers — byte for byte', () => {
    const before = '# Mine\n\nWeird   spacing\t\tkept.\n\n';
    const after = '\n## Trailing human section\n- keep\n';
    const existing = `${before}${formatRegion('a', 'old')}\n${after}`;
    const out = apply({ existing, desired: [{ id: 'a', content: 'new' }] });
    expect(out.text).toBe(`${before}${formatRegion('a', 'new')}\n${after}`);
  });

  it('places a new region next to its neighbour in desired order, not at the end of the file', () => {
    const existing = `${formatRegion('m:a', 'A')}\n\n${formatRegion('m:c', 'C')}\n\n## Human footer\n`;
    const out = apply({ existing, desired: ['m:a', 'm:b', 'm:c'].map((id) => ({ id, content: id.toUpperCase() })) });
    const order = parseRegions(out.text!, 'X.md').map((r) => r.id);
    expect(order).toEqual(['m:a', 'm:b', 'm:c']);
    expect(out.text!.trimEnd().endsWith('## Human footer')).toBe(true);
  });

  it('appends to a human-only file with exactly one blank line of separation', () => {
    const out = apply({ existing: '# Notes\n\nHello.\n\n\n', desired: [{ id: 'a', content: 'A' }] });
    expect(out.text).toBe(`# Notes\n\nHello.\n\n${formatRegion('a', 'A')}\n`);
  });

  it('removes orphaned regions cleanly, and re-adding then removing leaves the file as it started', () => {
    const start = `top\n\n${formatRegion('keep', 'K')}\n`;
    const withExtra = apply({ existing: start, desired: [{ id: 'keep', content: 'K' }, { id: 'gone', content: 'G' }] }).text!;
    const removed = apply({ existing: withExtra, desired: [{ id: 'keep', content: 'K' }], isOrphan: (id) => id === 'gone' });
    expect(removed.outcomes.find((o) => o.id === 'gone')?.status).toBe('removed');
    expect(removed.text).toBe(start);
  });

  it('leaves regions that are neither desired nor orphaned completely alone', () => {
    const existing = `${formatRegion('someone-elses', 'X')}\n`;
    expect(apply({ existing, desired: [] }).text).toBe(existing);
  });

  it('reports a hand-edited region as a conflict instead of overwriting it', () => {
    const existing = formatRegion('a', 'generated').replace('generated', 'my edit') + '\n';
    const out = apply({ existing, desired: [{ id: 'a', content: 'regenerated' }] });
    expect(out.outcomes).toEqual([expect.objectContaining({ id: 'a', status: 'conflict' })]);
    expect(out.text).toBe(existing);
  });

  it('does not remove a hand-edited orphan either', () => {
    const existing = formatRegion('gone', 'generated').replace('generated', 'my edit') + '\n';
    const out = apply({ existing, desired: [], isOrphan: () => true });
    expect(out.outcomes[0].status).toBe('conflict');
    expect(out.text).toBe(existing);
  });

  it('overwrites hand edits with force', () => {
    const existing = formatRegion('a', 'generated').replace('generated', 'my edit') + '\n';
    const out = apply({ existing, desired: [{ id: 'a', content: 'regenerated' }], force: true });
    expect(out.text).toBe(`${formatRegion('a', 'regenerated')}\n`);
  });

  it('upgrades v0.1 markers in place even when the content is unchanged', () => {
    const out = apply({ existing: '<!-- ctxkeep:start:a -->\nA\n<!-- ctxkeep:end -->\n', desired: [{ id: 'a', content: 'A' }] });
    expect(out.outcomes[0]).toMatchObject({ status: 'updated', note: 'marker format upgraded' });
    expect(out.text).toBe(`${formatRegion('a', 'A')}\n`);
  });

  it('preserves CRLF line endings instead of producing a mixed-ending file', () => {
    const existing = `# Mine\r\n\r\n${formatRegion('a', 'old').replace(/\n/g, '\r\n')}\r\n`;
    const out = apply({ existing, desired: [{ id: 'a', content: 'one\ntwo' }] });
    expect(out.text).toBe(`# Mine\r\n\r\n${formatRegion('a', 'one\ntwo').replace(/\n/g, '\r\n')}\r\n`);
    expect(out.text!.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('treats a CRLF checkout of correct content as unchanged', () => {
    const existing = `${formatRegion('a', 'one\ntwo')}\n`.replace(/\n/g, '\r\n');
    expect(apply({ existing, desired: [{ id: 'a', content: 'one\ntwo' }] }).changed).toBe(false);
  });
});
