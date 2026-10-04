import { formatRegion, isHandEdited, parseRegions, type ParsedRegion } from './markers';

export type RegionStatus = 'unchanged' | 'updated' | 'added' | 'removed' | 'conflict';

export interface RegionOutcome {
  id: string;
  status: RegionStatus;
  /** Why, for anything other than a plain content update. */
  note?: string;
}

export interface DesiredRegion {
  id: string;
  content: string;
}

export interface ApplyInput {
  fileLabel: string;
  /** Current file text, or null if the file doesn't exist. */
  existing: string | null;
  /** Regions that must exist with exactly this content, in document order. */
  desired: DesiredRegion[];
  /** For a region on disk that isn't desired: should it be removed (it describes something that no longer exists)? */
  isOrphan: (id: string) => boolean;
  /** Human-owned preamble written once when the file is created. */
  header?: string | null;
  /** Overwrite/remove hand-edited regions instead of reporting a conflict. */
  force?: boolean;
}

export interface ApplyOutput {
  /** New file text (null when the file doesn't exist and nothing needs to be written). */
  text: string | null;
  changed: boolean;
  outcomes: RegionOutcome[];
}

type Item = { kind: 'text'; lines: string[] } | { kind: 'region'; id: string; lines: string[] };

const HAND_EDIT_NOTE = 'edited by hand since CtxKeep last wrote it — left as is (move your edits outside the markers, or rerun with --force)';

/**
 * Computes the new text of one artifact without touching disk. The contract:
 *
 * - Text outside CtxKeep markers is never modified (byte-for-byte, apart
 *   from a blank separator line around a region CtxKeep inserts or removes).
 * - A region whose content is already correct is left exactly as is.
 * - A region edited by hand since it was generated is never overwritten or
 *   removed without `force` — it's reported as a conflict instead.
 * - New regions are placed next to their neighbours in `desired` order, so
 *   a new module's section lands with the other module sections instead of
 *   at the bottom of the file.
 * - The file's dominant line ending (LF or CRLF) is preserved.
 */
export function applyRegions(input: ApplyInput): ApplyOutput {
  const outcomes: RegionOutcome[] = [];

  if (input.existing === null) {
    if (input.desired.length === 0) return { text: null, changed: false, outcomes };
    const parts = [...(input.header ? [input.header] : []), ...input.desired.map((r) => formatRegion(r.id, r.content))];
    for (const r of input.desired) outcomes.push({ id: r.id, status: 'added' });
    return { text: `${parts.join('\n\n')}\n`, changed: true, outcomes };
  }

  const crlfCount = (input.existing.match(/\r\n/g) ?? []).length;
  const lfCount = (input.existing.match(/\n/g) ?? []).length;
  const eol = crlfCount > 0 && crlfCount * 2 >= lfCount ? '\r\n' : '\n';
  const normalized = input.existing.replace(/\r\n/g, '\n');
  const regions = parseRegions(normalized, input.fileLabel);

  // Split the document into alternating text / region items.
  const lines = normalized.split('\n');
  const items: Item[] = [];
  let cursor = 0;
  const byId = new Map<string, ParsedRegion>();
  for (const region of regions) {
    byId.set(region.id, region);
    if (region.startLine > cursor) items.push({ kind: 'text', lines: lines.slice(cursor, region.startLine) });
    items.push({ kind: 'region', id: region.id, lines: lines.slice(region.startLine, region.endLine + 1) });
    cursor = region.endLine + 1;
  }
  if (cursor < lines.length) items.push({ kind: 'text', lines: lines.slice(cursor) });

  const desiredById = new Map(input.desired.map((r) => [r.id, r]));

  // 1. Update or remove regions already on disk.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'region') continue;
    const onDisk = byId.get(item.id)!;
    const want = desiredById.get(item.id);

    if (want) {
      if (onDisk.content === want.content && !onDisk.legacy) {
        outcomes.push({ id: item.id, status: 'unchanged' });
      } else if (isHandEdited(onDisk) && !input.force) {
        outcomes.push({ id: item.id, status: 'conflict', note: HAND_EDIT_NOTE });
      } else {
        item.lines = formatRegion(item.id, want.content).split('\n');
        const note = onDisk.content === want.content ? 'marker format upgraded' : undefined;
        outcomes.push({ id: item.id, status: 'updated', ...(note ? { note } : {}) });
      }
      continue;
    }

    if (!input.isOrphan(item.id)) continue; // not ours to judge (e.g. a section this config doesn't list) — leave alone
    if (isHandEdited(onDisk) && !input.force) {
      outcomes.push({ id: item.id, status: 'conflict', note: `describes something that no longer exists, but was ${HAND_EDIT_NOTE}` });
      continue;
    }
    removeItem(items, i);
    outcomes.push({ id: item.id, status: 'removed' });
  }

  // 2. Insert desired regions that aren't on disk yet, next to their neighbours.
  for (let d = 0; d < input.desired.length; d += 1) {
    const want = input.desired[d];
    if (items.some((it) => it.kind === 'region' && it.id === want.id)) continue;

    const regionItem: Item = { kind: 'region', id: want.id, lines: formatRegion(want.id, want.content).split('\n') };
    const indexOf = (id: string) => items.findIndex((it) => it.kind === 'region' && it.id === id);
    const prev = input.desired.slice(0, d).reverse().map((r) => indexOf(r.id)).find((i) => i !== -1);
    const next = input.desired.slice(d + 1).map((r) => indexOf(r.id)).find((i) => i !== -1);

    if (prev !== undefined) {
      items.splice(prev + 1, 0, { kind: 'text', lines: [''] }, regionItem);
    } else if (next !== undefined) {
      items.splice(next, 0, regionItem, { kind: 'text', lines: [''] });
    } else {
      // Append after the existing content, separated by exactly one blank line.
      const last = items[items.length - 1];
      if (last?.kind === 'text') {
        while (last.lines.length > 0 && last.lines[last.lines.length - 1].trim() === '') last.lines.pop();
        if (last.lines.length === 0) items.pop();
      }
      if (items.length > 0) items.push({ kind: 'text', lines: [''] });
      items.push(regionItem, { kind: 'text', lines: [''] });
    }
    outcomes.push({ id: want.id, status: 'added' });
  }

  let text = items.flatMap((it) => it.lines).join('\n');
  if (!text.endsWith('\n')) text += '\n';
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');

  outcomes.sort((a, b) => a.id.localeCompare(b.id));
  return { text, changed: text !== input.existing, outcomes };
}

/** Removes a region item plus one adjacent blank line, so repeated add/remove cycles don't accumulate whitespace. */
function removeItem(items: Item[], index: number): void {
  items.splice(index, 1);
  const before = items[index - 1];
  const after = items[index];
  const blank = (l: string | undefined) => l !== undefined && l.trim() === '';
  if (after?.kind === 'text' && blank(after.lines[0]) && (index === 0 || (before?.kind === 'text' && blank(before.lines[before.lines.length - 1])))) {
    after.lines.shift();
    if (after.lines.length === 0) items.splice(index, 1);
  } else if (before?.kind === 'text' && blank(before.lines[before.lines.length - 1]) && after === undefined) {
    before.lines.pop();
  }
}

/** True when nothing but CtxKeep's own creation boilerplate remains — safe to delete the file. */
export function isOnlyBoilerplate(text: string, header: string | null | undefined): boolean {
  let rest = text.replace(/\r\n/g, '\n');
  if (header) rest = rest.replace(header, '');
  return rest.trim() === '';
}
