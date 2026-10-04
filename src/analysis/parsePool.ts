import os from 'node:os';
import path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { parseFile } from './parser';
import type { ParsedFile } from './types';

/**
 * Parallel parsing for big first scans (`analyze`, `try`, first `sync`).
 * Parsing is ~95% of a full scan: a 2,000-file TypeScript monorepo spends
 * ~25s in tree-sitter on one core.
 *
 * The pool is synchronous from the caller's point of view, so the rest of
 * the pipeline stays simple: workers parse batches and post results; the
 * main thread sleeps on a shared counter (Atomics.wait) and drains results
 * with receiveMessageOnPort. Below PARALLEL_MIN_FILES, or if workers can't
 * start in this environment, parsing runs serially — the results are
 * identical either way.
 */

export const PARALLEL_MIN_FILES = 100;

export type ParseOutcome = { relPath: string; parsed: ParsedFile } | { relPath: string; error: string };

function parseSerial(rootDir: string, jobs: { relPath: string; source: string }[]): ParseOutcome[] {
  return jobs.map(({ relPath, source }) => {
    try {
      return { relPath, parsed: parseFile(relPath, source)! };
    } catch (err) {
      return { relPath, error: (err as Error).message };
    }
  });
}

// Runs in each worker. It requires the parser by absolute path, so it works
// from compiled dist/ and under tsx (workers inherit the loader).
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { port, counter, parserPath, rootDir, files } = workerData;
const done = new Int32Array(counter);
try {
  const { parseFile } = require(parserPath);
  for (const relPath of files) {
    try {
      const source = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      port.postMessage({ relPath, parsed: parseFile(relPath, source) });
    } catch (err) {
      port.postMessage({ relPath, error: String(err && err.message || err) });
    }
  }
} catch (err) {
  port.postMessage({ fatal: String(err && err.message || err) });
}
Atomics.add(done, 0, 1);
Atomics.notify(done, 0);
`;

function threadCount(fileCount: number): number {
  const env = process.env.CTXKEEP_PARSE_THREADS;
  const max = env !== undefined ? Number(env) : Math.min(os.availableParallelism() - 1, 7);
  if (!Number.isFinite(max) || max < 2) return 1;
  return Math.max(1, Math.min(max, Math.floor(fileCount / 25)));
}

/**
 * Parses files (paths relative to rootDir). `jobs` carries the already-read
 * source for the serial path; workers re-read from disk rather than copying
 * every file's text across threads.
 */
export function parseMany(rootDir: string, jobs: { relPath: string; source: string }[]): ParseOutcome[] {
  const threads = jobs.length >= PARALLEL_MIN_FILES || process.env.CTXKEEP_PARSE_THREADS ? threadCount(jobs.length) : 1;
  if (threads < 2) return parseSerial(rootDir, jobs);

  // Interleave by size so each worker gets a similar amount of text.
  const sorted = [...jobs].sort((a, b) => b.source.length - a.source.length);
  const batches: string[][] = Array.from({ length: threads }, () => []);
  sorted.forEach((job, i) => batches[i % threads].push(job.relPath));

  const counter = new SharedArrayBuffer(4);
  const done = new Int32Array(counter);
  const ports: MessagePort[] = [];
  const workers: Worker[] = [];
  const parserPath = path.join(__dirname, path.basename(__filename).replace('parsePool', 'parser'));

  try {
    for (const files of batches) {
      const { port1, port2 } = new MessageChannel();
      ports.push(port1);
      workers.push(
        new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { port: port2, counter, parserPath, rootDir, files },
          transferList: [port2],
        }),
      );
    }

    const results: ParseOutcome[] = [];
    let fatal = false;
    const drain = () => {
      for (const port of ports) {
        let msg = receiveMessageOnPort(port);
        while (msg) {
          if ('fatal' in msg.message) fatal = true;
          else results.push(msg.message as ParseOutcome);
          msg = receiveMessageOnPort(port);
        }
      }
    };
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Atomics.load(done, 0) < threads) {
      Atomics.wait(done, 0, Atomics.load(done, 0), 100);
      drain();
      if (Date.now() > deadline) throw new Error('parse workers timed out');
    }
    drain();

    if (fatal || results.length !== jobs.length) return parseSerial(rootDir, jobs);
    const order = new Map(jobs.map((j, i) => [j.relPath, i]));
    return results.sort((a, b) => order.get(a.relPath)! - order.get(b.relPath)!);
  } catch {
    return parseSerial(rootDir, jobs);
  } finally {
    for (const w of workers) void w.terminate();
    for (const p of ports) p.close();
  }
}
