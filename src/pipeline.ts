import fs from 'node:fs';
import Database from 'better-sqlite3';
import { refreshGraph, type RefreshResult } from './analysis/refresh';
import { buildModel, type ContextModel } from './analysis/model';
import { detectConventions } from './analysis/conventions';
import { findProjectRoots } from './analysis/projects';
import { loadConfig } from './config/io';
import type { ArtifactConfig, Config } from './config/schema';
import { graphPath, openGraph, openMemoryGraph } from './graph/db';
import {
  applyDecisions,
  countPendingConventions,
  decidedConventions,
  listEmittableConventions,
  listLapsedConventions,
  syncConventions,
  type ConventionRow,
} from './graph/conventions';
import { readDecisions, writeDecisions } from './config/decisions';
import { planArtifacts, renderArtifacts, resolveArtifactConfigs, writeArtifacts, type ArtifactResult } from './artifacts/plan';
import { SCHEMA_SQL } from './graph/schema';

/**
 * The one pipeline behind `try`, `analyze`, and `sync`:
 *
 *   refresh graph (full or incremental) → build model → detect conventions
 *   → plan artifacts from config → render against disk → write (unless preview)
 *
 * Only the refresh step is incremental — it's the expensive part (parsing).
 * Rendering is a pure function of the graph, so it runs over every artifact
 * each time and lets content comparison decide what changed. That makes it
 * impossible for an artifact to be "missed" by an incorrect dependency
 * declaration, and an unchanged region is still never rewritten.
 */

export type PipelineMode = 'try' | 'analyze' | 'sync';

export interface PipelineOptions {
  rootDir: string;
  mode: PipelineMode;
  /** Compute everything, write nothing (graph included). `try` is always a preview. */
  preview?: boolean;
  /** Overwrite hand-edited regions. */
  force?: boolean;
}

export interface PipelineReport {
  config: Config;
  /** The resolved artifact list this run maintained. */
  artifacts: ArtifactConfig[];
  configFound: boolean;
  refresh: RefreshResult;
  model: ContextModel;
  results: ArtifactResult[];
  /** Module ids containing at least one added/modified/deleted file. */
  changedModules: string[];
  pendingConventions: number;
  lapsedConventions: ConventionRow[];
  written: boolean;
}

/**
 * Preview runs work on an in-memory copy of the graph, so even a schema
 * migration or a parse is never persisted. A missing graph means an empty one.
 */
function openPreviewGraph(rootDir: string): Database.Database {
  const file = graphPath(rootDir);
  if (!fs.existsSync(file)) return openMemoryGraph();
  // Not `readonly`: a WAL-mode database can't be opened read-only without its
  // -shm file. Nothing is written through this handle; it's only serialized.
  const source = new Database(file, { fileMustExist: true });
  try {
    const image = source.serialize();
    // Header bytes 18/19 record WAL mode (2); an in-memory database can't use a
    // WAL, so mark the image as a plain rollback-journal database (1).
    image[18] = 1;
    image[19] = 1;
    const copy = new Database(image);
    copy.pragma('foreign_keys = ON');
    const version = copy.pragma('user_version', { simple: true }) as number;
    if (version < 2) {
      // A v0.1 graph: preview against a fresh schema rather than migrating the copy in place.
      copy.close();
      return openMemoryGraph();
    }
    copy.exec(SCHEMA_SQL);
    return copy;
  } finally {
    source.close();
  }
}

/**
 * Brings the graph and convention candidates up to date WITHOUT touching any
 * artifact — what `review conventions` needs so it never asks about a pattern
 * the code has already moved away from. Caller closes the returned db.
 */
export function openFreshGraph(rootDir: string): Database.Database {
  const { config } = loadConfig(rootDir);
  const db = openGraph(rootDir);
  try {
    refreshGraph(db, rootDir, { extraIgnores: config.ignore });
    const projectRoots = findProjectRoots(rootDir, config.ignore);
    syncConventions(db, detectConventions(buildModel(db, rootDir, config.modules, projectRoots)));
    reconcileDecisions(db, rootDir, false);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * The committed `.ctxkeep/conventions.yaml` is the source of truth for review
 * decisions; the graph mirrors it. A graph from before that file existed
 * still holds decisions, which are exported to the file once (unless previewing).
 */
function reconcileDecisions(db: Database.Database, rootDir: string, preview: boolean): void {
  let decisions = readDecisions(rootDir);
  if (!decisions) {
    decisions = decidedConventions(db);
    if (!preview && decisions.confirmed.length + decisions.rejected.length > 0) writeDecisions(rootDir, decisions);
  }
  applyDecisions(db, decisions);
}

export function runPipeline(options: PipelineOptions): PipelineReport {
  const { rootDir, mode } = options;
  const preview = mode === 'try' || Boolean(options.preview);
  const { config, found: configFound } = loadConfig(rootDir);
  const artifacts = resolveArtifactConfigs(config, rootDir);

  const db = mode === 'try' ? openMemoryGraph() : preview ? openPreviewGraph(rootDir) : openGraph(rootDir);
  try {
    const refresh = refreshGraph(db, rootDir, { full: mode !== 'sync', extraIgnores: config.ignore });
    const projectRoots = findProjectRoots(rootDir, config.ignore);
    const model = buildModel(db, rootDir, config.modules, projectRoots);

    syncConventions(db, detectConventions(model));
    reconcileDecisions(db, rootDir, preview);
    const conventions = listEmittableConventions(db);

    const plans = planArtifacts({ rootDir, model, conventions, artifacts });
    const results = renderArtifacts(rootDir, plans, { force: options.force });

    if (!preview) writeArtifacts(rootDir, results);

    const { added, modified, deleted } = refresh.changes;
    const changedModules = [...new Set([...added, ...modified, ...deleted].map((p) => model.moduleOf(p)))].sort();

    return {
      config,
      artifacts,
      configFound,
      refresh,
      model,
      results,
      changedModules,
      pendingConventions: countPendingConventions(db),
      lapsedConventions: listLapsedConventions(db),
      written: !preview,
    };
  } finally {
    db.close();
  }
}
