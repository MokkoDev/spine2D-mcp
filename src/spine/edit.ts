import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { findNodeAtLocation, parseTree } from "jsonc-parser";

import { bulkKeysText, type BulkKeysOperation, type BulkSummary, type KeyChange } from "./bulk.js";
import { removeAttachmentText, setMeshGeometryText, setMeshWeightsText, upsertAttachmentText,
  type AttachmentOperation, type AttachmentSummary, type RemoveAttachmentSummary } from "./attachment.js";
import { cleanupCurvesText, type CleanupCurvesOperation, type CleanupCurvesSummary } from "./cleanup-curves.js";
import { setCurveText, type CurveSummary, type SetCurveOperation } from "./curve.js";
import { parseDocument, readDocument, requireEditableVersion, sha256, type SpineDocument } from "./document.js";
import { SpineError } from "./errors.js";
import { deleteKeyframeText, setKeyframeText, type DeleteKeyframeOperation, type KeyframeSummary, type SetKeyframeOperation } from "./keyframe.js";
import { replaceKeyframeText, type ReplaceKeyframeOperation, type ReplaceKeyframeSummary } from "./replace-keyframe.js";
import { makeLoopText, type MakeLoopOperation, type LoopSummary } from "./loop.js";
import { removeAnimationText, removeConstraintText, removeEventText,
  type RemoveOperation, type RemoveSummary } from "./remove.js";
import { renameElementText, type RenameElementOperation, type RenameSummary } from "./rename.js";
import { retargetAnimationText, type RetargetAnimationOperation, type RetargetSummary } from "./retarget.js";
import { removeSkinText, setSkeletonMetadataText, upsertAnimationText, upsertBoneText, upsertConstraintText, upsertEventText,
  upsertRegionAttachmentText, upsertSkinText, upsertSlotText, type RigOperation, type RigSummary } from "./rig.js";
import { removeBoneText, removeSlotText, reorderSlotsText, type StructureOperation, type StructureSummary } from "./structure.js";
import { collectTimelines, keyTime, timelinePath, type JsonPath } from "./timelines.js";
import { transformAnimationText, type TransformAnimationOperation, type TransformAnimationSummary } from "./transform.js";
import { validateDocument, type Diagnostic } from "./validate.js";
import { cloneAnimationText, reverseBoneAnimationText, type CloneAnimationOperation, type CloneAnimationSummary,
  type ReverseBoneAnimationOperation, type ReverseBoneAnimationSummary } from "./variant.js";

export interface RetimeAnimationOperation {
  kind: "retime_animation";
  animation: string;
  scale: number;
}

export type EditOperation = RetimeAnimationOperation | BulkKeysOperation | MakeLoopOperation | SetCurveOperation | ReplaceKeyframeOperation
  | SetKeyframeOperation | DeleteKeyframeOperation | RigOperation | CloneAnimationOperation | ReverseBoneAnimationOperation
  | RetargetAnimationOperation | AttachmentOperation | RemoveOperation | StructureOperation | RenameElementOperation
  | CleanupCurvesOperation | TransformAnimationOperation;

export interface TimeChange {
  path: string;
  before: number;
  after: number;
}

export interface RetimeSummary {
  kind: "retime_animation";
  animation: string;
  beforeDuration: number;
  afterDuration: number;
  timelines: number;
  keys: number;
  curveControls: number;
}

export type EditSummary = RetimeSummary | BulkSummary | LoopSummary | CurveSummary | KeyframeSummary | ReplaceKeyframeSummary
  | RigSummary | CloneAnimationSummary | ReverseBoneAnimationSummary | RetargetSummary
  | AttachmentSummary | RemoveAttachmentSummary | RemoveSummary | StructureSummary | RenameSummary
  | CleanupCurvesSummary | TransformAnimationSummary;

interface Stage {
  id: string;
  baseEditId?: string;
  source: SpineDocument;
  after: SpineDocument;
  operations: EditOperation[];
  /** Operations supplied for this request, rather than the cumulative chain. */
  requestOperations?: EditOperation[];
  requestId?: string;
  fingerprint: string;
  createdAt: string;
  changes: KeyChange[];
  summaries: EditSummary[];
  diagnostics: Diagnostic[];
  dependencies: { path: string; hash: string }[];
  committed?: CommitResult;
}

export interface PreviewResult {
  editId: string;
  baseEditId?: string;
  diffResourceUri: string;
  netDiffResourceUri: string;
  sourcePath: string;
  sourceHash: string;
  afterHash: string;
  version: string;
  operations: EditOperation[];
  summaries: Stage["summaries"];
  changeCount: number;
  changes: KeyChange[];
  changesTruncated: boolean;
  changeValuesTruncated: boolean;
  changesOffset: number;
  netChangeCount: number;
  netChanges: KeyChange[];
  netChangesTruncated: boolean;
  netChangeValuesTruncated: boolean;
  diagnostics: Diagnostic[];
  expiresAt: string;
}

export interface CommitResult {
  editId: string;
  sourcePath: string;
  sourceHash: string;
  afterHash: string;
  backupPath: string;
  manifestPath: string;
  committedAt: string;
}

export interface EditStoreOptions {
  stateDir?: string;
  /** Fault injection for recovery tests. Runs after source replacement, before final manifest write. */
  beforeFinalize?: () => Promise<void>;
}

function restoredStage(value: unknown, editId: string): Stage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpineError("EDIT_STATE_CORRUPT", `Saved stage ${editId} is invalid.`);
  }
  const saved = value as Stage;
  if (saved.id !== editId || typeof saved.createdAt !== "string" || !Number.isFinite(Date.parse(saved.createdAt))
    || typeof saved.source?.path !== "string" || typeof saved.source?.text !== "string"
    || typeof saved.after?.text !== "string" || !Array.isArray(saved.operations)
    || !Array.isArray(saved.changes) || !Array.isArray(saved.summaries)
    || !Array.isArray(saved.diagnostics) || !Array.isArray(saved.dependencies)
    || (saved.requestOperations !== undefined && !Array.isArray(saved.requestOperations))
    || (saved.baseEditId !== undefined && typeof saved.baseEditId !== "string")) {
    throw new SpineError("EDIT_STATE_CORRUPT", `Saved stage ${editId} is incomplete.`);
  }
  const source = parseDocument(saved.source.path, saved.source.text);
  const after = parseDocument(saved.source.path, saved.after.text);
  if (source.hash !== saved.source.hash || after.hash !== saved.after.hash || after.path !== saved.after.path
    || saved.fingerprint !== sha256(JSON.stringify({ sourceHash: source.hash,
      ...(saved.baseEditId ? { baseEditId: saved.baseEditId } : {}), operations: saved.operations,
      ...(saved.requestOperations ? { requestOperations: saved.requestOperations } : {}) }))
    || (saved.requestOperations && JSON.stringify(saved.operations.slice(-saved.requestOperations.length))
      !== JSON.stringify(saved.requestOperations))) {
    throw new SpineError("EDIT_STATE_CORRUPT", `Saved stage ${editId} failed its integrity check.`);
  }
  return { ...saved, source, after };
}

function assertValid(document: SpineDocument): Diagnostic[] {
  const diagnostics = validateDocument(document);
  const errors = diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    throw new SpineError("VALIDATION_FAILED", `Spine JSON has ${errors.length} validation error(s).`, { diagnostics });
  }
  return diagnostics;
}

function compactChangeValue(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || typeof value !== "object") return { value, truncated: false };
  const encoded = JSON.stringify(value);
  if (encoded.length <= 1000) return { value, truncated: false };
  const record = Array.isArray(value) ? undefined : value as Record<string, unknown>;
  return {
    value: { omitted: true, jsonCharacters: encoded.length, ...(record ? { fields: Object.keys(record), time: record.time ?? 0 } : { length: (value as unknown[]).length }) },
    truncated: true,
  };
}

function netChanges(before: unknown, after: unknown): KeyChange[] {
  const changes: KeyChange[] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const visit = (left: unknown, right: unknown, path: JsonPath, hasLeft = true, hasRight = true): void => {
    if (hasLeft && hasRight && Object.is(left, right)) return;
    if (hasLeft && hasRight && Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        visit(left[index], right[index], [...path, index], index < left.length, index < right.length);
      }
      return;
    }
    if (hasLeft && hasRight && record(left) && record(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        visit(left[key], right[key], [...path, key], Object.hasOwn(left, key), Object.hasOwn(right, key));
      }
      return;
    }
    changes.push({ path: timelinePath(path), before: hasLeft ? left : null, after: hasRight ? right : null,
      ...(hasLeft ? {} : { beforeExists: false as const }),
      ...(hasRight ? {} : { afterExists: false as const }) });
  };
  visit(before, after, []);
  return changes;
}

function compactChanges(changes: KeyChange[]): { changes: KeyChange[]; valuesTruncated: boolean } {
  let valuesTruncated = false;
  return { changes: changes.map((change) => {
    const before = compactChangeValue(change.before);
    const after = compactChangeValue(change.after);
    valuesTruncated ||= before.truncated || after.truncated;
    return { ...change, before: before.value, after: after.value };
  }), valuesTruncated };
}

function retimeText(document: SpineDocument, operation: RetimeAnimationOperation): { text: string; changes: TimeChange[]; summary: RetimeSummary } {
  if (!Number.isFinite(operation.scale) || operation.scale <= 0) {
    throw new SpineError("INVALID_SCALE", "Retime scale must be a finite number greater than zero.");
  }
  const animations = document.data.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations) || !Object.hasOwn(animations, operation.animation)) {
    throw new SpineError("ANIMATION_NOT_FOUND", `Animation ${operation.animation} was not found.`);
  }
  const timelineList = collectTimelines(operation.animation, (animations as Record<string, unknown>)[operation.animation]);
  const rootNode = parseTree(document.text);
  if (!rootNode) throw new SpineError("INVALID_JSON", "Cannot locate JSON syntax tree for retiming.");
  const replacements: { offset: number; length: number; text: string }[] = [];
  const changes: TimeChange[] = [];
  let beforeDuration = 0;
  let afterDuration = 0;
  let keys = 0;
  let curveControls = 0;

  const replaceNumber = (path: JsonPath, before: number, after: number) => {
    if (!Number.isFinite(after) || after < 0) {
      throw new SpineError("TIME_OVERFLOW", `Retiming produced an invalid time at ${timelinePath(path)}.`);
    }
    if (Object.is(before, after)) return;
    const node = findNodeAtLocation(rootNode, path);
    if (!node || node.type !== "number") {
      throw new SpineError("INVALID_DATA", `Expected a numeric value at ${timelinePath(path)}.`);
    }
    replacements.push({ offset: node.offset, length: node.length, text: JSON.stringify(after) });
    changes.push({ path: timelinePath(path), before, after });
  };

  for (const timeline of timelineList) {
    timeline.keys.forEach((key, index) => {
      keys += 1;
      const keyPath = [...timeline.path, index];
      const time = keyTime(key, keyPath);
      beforeDuration = Math.max(beforeDuration, time);
      afterDuration = Math.max(afterDuration, time * operation.scale);
      if (key.time !== undefined) replaceNumber([...keyPath, "time"], time, time * operation.scale);
      if (key.curve === undefined || key.curve === "stepped") return;
      if (!Array.isArray(key.curve) || key.curve.length === 0 || key.curve.length % 4 !== 0 || !key.curve.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new SpineError("UNSUPPORTED_CURVE", `Cannot retime curve at ${timelinePath([...keyPath, "curve"])}.`);
      }
      for (let offset = 0; offset < key.curve.length; offset += 4) {
        const first = key.curve[offset] as number;
        const second = key.curve[offset + 2] as number;
        replaceNumber([...keyPath, "curve", offset], first, first * operation.scale);
        replaceNumber([...keyPath, "curve", offset + 2], second, second * operation.scale);
        curveControls += 2;
      }
    });
  }
  replacements.sort((a, b) => b.offset - a.offset);
  let text = document.text;
  for (const replacement of replacements) {
    text = text.slice(0, replacement.offset) + replacement.text + text.slice(replacement.offset + replacement.length);
  }
  const summary: RetimeSummary = { kind: "retime_animation", animation: operation.animation, beforeDuration, afterDuration, timelines: timelineList.length, keys, curveControls };
  return { text, changes, summary };
}

export class EditStore {
  private readonly stages = new Map<string, Stage>();
  private readonly requests = new Map<string, string>();
  private readonly ttlMs = 7 * 24 * 60 * 60 * 1000;
  private readonly stateDir: string;
  private readonly beforeFinalize?: () => Promise<void>;
  private readonly commits = new Map<string, Promise<CommitResult>>();
  private hydrated = false;

  constructor(options: EditStoreOptions = {}) {
    this.stateDir = options.stateDir ?? process.env.SPINE_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "spine2d-mcp", "stages");
    this.beforeFinalize = options.beforeFinalize;
  }

  private stagePath(editId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(editId)) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist.");
    return join(this.stateDir, `${editId}.json`);
  }

  private expired(stage: Stage): boolean {
    return Date.now() - Date.parse(stage.createdAt) > this.ttlMs;
  }

  private loadStage(editId: string): Stage | undefined {
    const cached = this.stages.get(editId);
    if (cached) return cached;
    let text: string;
    try { text = readFileSync(this.stagePath(editId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new SpineError("EDIT_STATE_CORRUPT", `Saved stage ${editId} is not valid JSON.`); }
    const stage = restoredStage(parsed, editId);
    if (this.expired(stage)) return undefined;
    this.stages.set(stage.id, stage);
    if (stage.requestId) this.requests.set(`${stage.source.path}:${stage.requestId}`, stage.id);
    return stage;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.stateDir)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const editId = name.slice(0, -5);
      try {
        const stage = this.loadStage(editId);
        if (!stage) await rm(this.stagePath(editId), { force: true });
      } catch (error) {
        if (!(error instanceof SpineError) || error.code !== "EDIT_STATE_CORRUPT") throw error;
      }
    }
    this.hydrated = true;
  }

  private async saveStage(stage: Stage): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const destination = this.stagePath(stage.id);
    const temporary = join(this.stateDir, `.${stage.id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(stage)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async acquireCommitLock(editId: string): Promise<string> {
    this.stagePath(editId);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.stateDir, `${editId}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
        catch (error) {
          await handle.close();
          await rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        await handle.close();
        return lockPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const file = await stat(lockPath).catch(() => undefined);
      if (!file) continue;
      let pid: number | undefined;
      try { pid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }).pid; }
      catch { /* An interrupted lock write is treated by its file age. */ }
      let live = false;
      if (Number.isSafeInteger(pid) && Number(pid) > 0) {
        try { process.kill(pid!, 0); live = true; }
        catch (error) { live = (error as NodeJS.ErrnoException).code === "EPERM"; }
      }
      if (live && Date.now() - file.mtimeMs < 10 * 60 * 1000
        || pid === undefined && Date.now() - file.mtimeMs < 30_000) {
        throw new SpineError("COMMIT_IN_PROGRESS", `Edit ${editId} is being committed by another server process.`);
      }
      await rm(lockPath, { force: true });
    }
    throw new SpineError("COMMIT_IN_PROGRESS", `Edit ${editId} could not acquire its commit lock.`);
  }

  private discardExpired(): void {
    const now = Date.now();
    for (const [id, stage] of this.stages) {
      if (now - Date.parse(stage.createdAt) > this.ttlMs) {
        this.stages.delete(id);
        if (stage.requestId) this.requests.delete(`${stage.source.path}:${stage.requestId}`);
      }
    }
  }

  async preview(path: string, operations: EditOperation[], requestId?: string, baseEditId?: string): Promise<PreviewResult> {
    await this.hydrate();
    this.discardExpired();
    if (operations.length === 0) throw new SpineError("EMPTY_EDIT", "At least one edit operation is required.");
    const source = await readDocument(path);
    requireEditableVersion(source);
    assertValid(source);
    const requestKey = requestId ? `${source.path}:${requestId}` : undefined;
    const priorId = requestKey ? this.requests.get(requestKey) : undefined;
    const prior = priorId ? this.loadStage(priorId) : undefined;
    if (prior) {
      const priorBase = !prior.requestOperations && prior.baseEditId ? this.loadStage(prior.baseEditId) : undefined;
      const originalOperations = prior.requestOperations ?? (prior.baseEditId
        ? priorBase && prior.operations.slice(priorBase.operations.length) : prior.operations);
      const sameOperations = originalOperations !== undefined
        && JSON.stringify(originalOperations) === JSON.stringify(operations);
      if (prior.source.hash === source.hash && prior.baseEditId === baseEditId && sameOperations) {
        return this.describe(prior);
      }
      throw new SpineError("IDEMPOTENCY_CONFLICT", "The request ID was already used for different edit contents.");
    }
    const base = baseEditId ? this.loadStage(baseEditId) : undefined;
    if (baseEditId && !base) throw new SpineError("EDIT_NOT_FOUND", "The base staged edit does not exist or has expired.");
    if (base && base.source.path !== source.path) {
      throw new SpineError("BASE_EDIT_MISMATCH", "The base staged edit belongs to a different source JSON.",
        { baseEditId, basePath: base.source.path, sourcePath: source.path });
    }
    if (base && base.source.hash !== source.hash) {
      throw new SpineError("SOURCE_CHANGED", "The source JSON changed after the base edit was staged. Preview again from the current file.",
        { expectedHash: base.source.hash, actualHash: source.hash });
    }
    const allOperations = base ? [...base.operations, ...operations] : operations;
    const fingerprint = sha256(JSON.stringify({ sourceHash: source.hash,
      ...(baseEditId ? { baseEditId } : {}), operations: allOperations, requestOperations: operations }));
    let text = base?.after.text ?? source.text;
    const allChanges: KeyChange[] = base ? [...base.changes] : [];
    const summaries: Stage["summaries"] = base ? [...base.summaries] : [];
    const dependencies: Stage["dependencies"] = base ? [...base.dependencies] : [];
    for (const operation of operations) {
      const current = parseDocument(source.path, text);
      if (operation.kind === "retime_animation") {
        const result = retimeText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "bulk_keys") {
        const result = bulkKeysText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "make_loop") {
        const result = makeLoopText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "set_curve") {
        const result = setCurveText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "set_keyframe") {
        const result = setKeyframeText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "replace_keyframe") {
        const result = replaceKeyframeText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "delete_keyframe") {
        const result = deleteKeyframeText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "clone_animation") {
        const result = cloneAnimationText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "reverse_bone_animation") {
        const result = reverseBoneAnimationText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "retarget_animation") {
        const external = await readDocument(operation.sourcePath);
        const result = retargetAnimationText(current, external, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
        dependencies.push({ path: external.path, hash: external.hash });
      } else if (operation.kind === "upsert_attachment" || operation.kind === "set_mesh_geometry"
        || operation.kind === "set_mesh_weights" || operation.kind === "remove_attachment") {
        const result = operation.kind === "upsert_attachment" ? upsertAttachmentText(current, operation)
          : operation.kind === "set_mesh_geometry" ? setMeshGeometryText(current, operation)
            : operation.kind === "set_mesh_weights" ? setMeshWeightsText(current, operation)
              : removeAttachmentText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "remove_skin") {
        const result = removeSkinText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "remove_constraint" || operation.kind === "remove_event"
        || operation.kind === "remove_animation") {
        const result = operation.kind === "remove_constraint" ? removeConstraintText(current, operation)
          : operation.kind === "remove_event" ? removeEventText(current, operation)
            : removeAnimationText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "remove_bone" || operation.kind === "remove_slot" || operation.kind === "reorder_slots") {
        const result = operation.kind === "remove_bone" ? removeBoneText(current, operation)
          : operation.kind === "remove_slot" ? removeSlotText(current, operation) : reorderSlotsText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "rename_element") {
        const result = renameElementText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "cleanup_curves") {
        const result = cleanupCurvesText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "transform_animation") {
        const result = transformAnimationText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else if (operation.kind === "upsert_bone" || operation.kind === "upsert_slot"
        || operation.kind === "upsert_region_attachment" || operation.kind === "upsert_animation"
        || operation.kind === "upsert_skin" || operation.kind === "upsert_event"
        || operation.kind === "upsert_constraint"
        || operation.kind === "set_skeleton_metadata") {
        const result = operation.kind === "upsert_bone" ? upsertBoneText(current, operation)
          : operation.kind === "upsert_slot" ? upsertSlotText(current, operation)
            : operation.kind === "upsert_region_attachment" ? upsertRegionAttachmentText(current, operation)
              : operation.kind === "upsert_animation" ? upsertAnimationText(current, operation)
                : operation.kind === "upsert_skin" ? upsertSkinText(current, operation)
                  : operation.kind === "upsert_event" ? upsertEventText(current, operation)
                    : operation.kind === "upsert_constraint" ? upsertConstraintText(current, operation)
                    : setSkeletonMetadataText(current, operation);
        text = result.text;
        allChanges.push(...result.changes);
        summaries.push(result.summary);
      } else {
        throw new SpineError("UNSUPPORTED_OPERATION", `Unsupported edit operation: ${String((operation as { kind: string }).kind)}.`);
      }
    }
    const after = parseDocument(source.path, text);
    const diagnostics = assertValid(after);
    const stage: Stage = {
      id: randomUUID(), baseEditId, source, after, operations: allOperations, requestOperations: operations,
      requestId, fingerprint,
      createdAt: new Date().toISOString(), changes: allChanges, summaries, diagnostics, dependencies,
    };
    await this.saveStage(stage);
    this.stages.set(stage.id, stage);
    if (requestKey) this.requests.set(requestKey, stage.id);
    return this.describe(stage);
  }

  private describe(stage: Stage): PreviewResult {
    const changesOffset = Math.max(0, stage.changes.length - 100);
    const recent = compactChanges(stage.changes.slice(changesOffset));
    const net = netChanges(stage.source.data, stage.after.data);
    const netPreview = compactChanges(net.slice(0, 100));
    return {
      editId: stage.id,
      ...(stage.baseEditId ? { baseEditId: stage.baseEditId } : {}),
      diffResourceUri: `spine-edit://${stage.id}/changes`,
      netDiffResourceUri: `spine-edit://${stage.id}/net-changes`,
      sourcePath: stage.source.path,
      sourceHash: stage.source.hash,
      afterHash: stage.after.hash,
      version: stage.source.version,
      operations: stage.operations,
      summaries: stage.summaries,
      changeCount: stage.changes.length,
      changes: recent.changes,
      changesTruncated: stage.changes.length > 100,
      changeValuesTruncated: recent.valuesTruncated,
      changesOffset,
      netChangeCount: net.length,
      netChanges: netPreview.changes,
      netChangesTruncated: net.length > 100,
      netChangeValuesTruncated: netPreview.valuesTruncated,
      diagnostics: stage.diagnostics,
      expiresAt: new Date(Date.parse(stage.createdAt) + this.ttlMs).toISOString(),
    };
  }

  changes(editId: string): { editId: string; changes: KeyChange[] } {
    this.discardExpired();
    const stage = this.loadStage(editId);
    if (!stage) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist or has expired.");
    return { editId, changes: stage.changes };
  }

  details(editId: string) {
    this.discardExpired();
    const stage = this.loadStage(editId);
    if (!stage) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist or has expired.");
    return { editId, operations: stage.operations, summaries: stage.summaries };
  }

  netChanges(editId: string): { editId: string; sourceHash: string; afterHash: string; changes: KeyChange[] } {
    this.discardExpired();
    const stage = this.loadStage(editId);
    if (!stage) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist or has expired.");
    return { editId, sourceHash: stage.source.hash, afterHash: stage.after.hash,
      changes: netChanges(stage.source.data, stage.after.data) };
  }

  snapshot(editId: string) {
    this.discardExpired();
    const stage = this.loadStage(editId);
    if (!stage) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist or has expired.");
    return {
      baseEditId: stage.baseEditId,
      sourcePath: stage.source.path,
      beforeText: stage.source.text,
      afterText: stage.after.text,
      sourceHash: stage.source.hash,
      afterHash: stage.after.hash,
      summaries: stage.summaries,
    };
  }

  async commit(editId: string): Promise<CommitResult> {
    const running = this.commits.get(editId);
    if (running) return running;
    const pending = (async () => {
      const lockPath = await this.acquireCommitLock(editId);
      try { return await this.commitStage(editId); }
      finally { await rm(lockPath, { force: true }).catch(() => undefined); }
    })();
    this.commits.set(editId, pending);
    try { return await pending; }
    finally { this.commits.delete(editId); }
  }

  private async writeManifest(path: string, value: Record<string, unknown>): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async commitStage(editId: string): Promise<CommitResult> {
    this.discardExpired();
    const stage = this.loadStage(editId);
    if (!stage) throw new SpineError("EDIT_NOT_FOUND", "The staged edit does not exist or has expired.");
    if (stage.committed) return stage.committed;
    const historyDir = join(dirname(stage.source.path), ".spine2d-mcp", "history", editId);
    const backupPath = join(historyDir, "before.json");
    const afterPath = join(historyDir, "after.json");
    const manifestPath = join(historyDir, "manifest.json");
    const temporary = join(dirname(stage.source.path), `.${editId}.spine2d-mcp.tmp`);
    let result: CommitResult = { editId, sourcePath: stage.source.path, sourceHash: stage.source.hash,
      afterHash: stage.after.hash, backupPath, manifestPath, committedAt: new Date().toISOString() };
    const payload = (status: "prepared" | "committed") => ({ ...result, status,
      version: stage.source.version, baseEditId: stage.baseEditId, operations: stage.operations, dependencies: stage.dependencies,
      changes: stage.changes, diagnostics: stage.diagnostics });
    const finish = async () => {
      try {
        await this.beforeFinalize?.();
        await this.writeManifest(manifestPath, payload("committed"));
      } catch (error) {
        throw new SpineError("COMMIT_FINALIZATION_FAILED",
          "The source was replaced, but the commit manifest could not be finalized. Retry the same editId.",
          { editId, sourcePath: stage.source.path, manifestPath, sourceApplied: true, reason: String(error) });
      }
      stage.committed = result;
      await this.saveStage(stage).catch(() => undefined);
      return result;
    };
    const latest = await readDocument(stage.source.path);
    const preparedExists = (await stat(manifestPath).catch(() => undefined))?.isFile() ?? false;
    if (latest.hash === stage.after.hash && (stage.after.hash !== stage.source.hash || preparedExists)) {
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>; }
      catch { throw new SpineError("COMMIT_RECOVERY_FAILED", "The source matches the staged result, but its prepared manifest is missing or unreadable.", { editId, manifestPath }); }
      let historyMatches = false;
      try {
        historyMatches = sha256(await readFile(backupPath, "utf8")) === stage.source.hash
          && sha256(await readFile(afterPath, "utf8")) === stage.after.hash;
      } catch { /* Report the same stable recovery error for missing history files. */ }
      if (manifest.editId !== editId || manifest.sourceHash !== stage.source.hash || manifest.afterHash !== stage.after.hash
        || !["prepared", "committed"].includes(String(manifest.status)) || !historyMatches
        || typeof manifest.committedAt !== "string") {
        throw new SpineError("COMMIT_RECOVERY_FAILED", "The prepared history does not match this staged edit.", { editId, manifestPath });
      }
      result = { ...result, committedAt: manifest.committedAt };
      if (manifest.status === "committed") {
        stage.committed = result;
        await this.saveStage(stage).catch(() => undefined);
        return result;
      }
      return finish();
    }
    if (latest.hash !== stage.source.hash) {
      throw new SpineError("SOURCE_CHANGED", "The source JSON changed after the edit was staged. Preview again before committing.",
        { expectedHash: stage.source.hash, actualHash: latest.hash });
    }
    if (preparedExists) {
      // A prior process may have stopped after writing prepared history but
      // before replacing the source. The source still has its original hash,
      // so the recorded attempt can be discarded and prepared again.
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>; }
      catch { throw new SpineError("COMMIT_RECOVERY_FAILED", "The existing history manifest is unreadable.", { editId, manifestPath }); }
      if (manifest.status !== "prepared" || manifest.editId !== editId
        || manifest.sourceHash !== stage.source.hash || manifest.afterHash !== stage.after.hash) {
        throw new SpineError("COMMIT_RECOVERY_FAILED", "Existing commit history cannot be discarded safely.", { editId, manifestPath });
      }
      await rm(historyDir, { recursive: true, force: true });
    } else if ((await stat(historyDir).catch(() => undefined))?.isDirectory()) {
      // An interrupted prepare may have written a backup but no manifest.
      await rm(historyDir, { recursive: true, force: true });
    }
    for (const dependency of stage.dependencies) {
      const current = await readDocument(dependency.path);
      if (current.hash !== dependency.hash) {
        throw new SpineError("SOURCE_CHANGED", "A transferred animation source changed after staging. Preview again before committing.",
          { path: dependency.path, expectedHash: dependency.hash, actualHash: current.hash });
      }
    }
    await mkdir(dirname(historyDir), { recursive: true, mode: 0o700 });
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    let replaced = false;
    try {
      await writeFile(backupPath, stage.source.text, { flag: "wx" });
      await writeFile(afterPath, stage.after.text, { flag: "wx" });
      await this.writeManifest(manifestPath, payload("prepared"));
      await writeFile(temporary, stage.after.text, { flag: "wx" });
      await chmod(temporary, (await stat(stage.source.path)).mode);
      const currentText = await readFile(stage.source.path, "utf8");
      if (sha256(currentText) !== stage.source.hash) {
        throw new SpineError("SOURCE_CHANGED", "The source JSON changed during commit. The staged edit was not applied.");
      }
      await rename(temporary, stage.source.path);
      replaced = true;
      return await finish();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (!replaced) await rm(historyDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
