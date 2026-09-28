import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { CleanupCurvesOperation } from "./cleanup-curves.js";
import { EditStore, type EditOperation, type PreviewResult } from "./edit.js";
import { SpineError } from "./errors.js";
import type { MakeLoopOperation } from "./loop.js";

export type BatchOperation =
  | { kind: "retime_animation"; scale: number }
  | Omit<MakeLoopOperation, "animation">
  | Omit<CleanupCurvesOperation, "animation">;
export interface BatchTarget { path: string; animations: string[] }
export interface BatchRequest {
  targets: BatchTarget[];
  operation: BatchOperation;
  commit?: boolean;
  stopOnError?: boolean;
}
type ItemStatus = "queued" | "staging" | "staged" | "committing" | "committed" | "failed" | "cancelled";
type JobStatus = "running" | "completed" | "completed_with_errors" | "cancelled";
interface BatchItem {
  path: string;
  animations: string[];
  status: ItemStatus;
  editId?: string;
  diffResourceUri?: string;
  sourceHash?: string;
  afterHash?: string;
  summaries?: PreviewResult["summaries"];
  backupPath?: string;
  manifestPath?: string;
  error?: { code: string; message: string; details?: unknown };
}
interface BatchJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  commit: boolean;
  stopOnError: boolean;
  operation: BatchOperation;
  cancelRequested: boolean;
  items: BatchItem[];
}

function verify(request: BatchRequest): BatchTarget[] {
  if (request.targets.length < 1 || request.targets.length > 20) {
    throw new SpineError("INVALID_BATCH_TARGETS", "A batch needs 1–20 project targets.");
  }
  const seen = new Set<string>();
  return request.targets.map((target) => {
    const path = resolve(target.path);
    if (seen.has(path)) throw new SpineError("DUPLICATE_BATCH_TARGET", `Project ${path} occurs more than once.`);
    seen.add(path);
    if (target.animations.length < 1 || target.animations.length > 20
      || target.animations.some((name) => !name.trim())
      || new Set(target.animations).size !== target.animations.length) {
      throw new SpineError("INVALID_BATCH_ANIMATIONS", "Each project needs 1–20 distinct animation names.");
    }
    return { path, animations: [...target.animations] };
  });
}
function operations(template: BatchOperation, animations: string[]): EditOperation[] {
  return animations.map((animation) => ({ ...template, animation } as EditOperation));
}
function issue(error: unknown): BatchItem["error"] {
  if (error instanceof SpineError) return { code: error.code, message: error.message, details: error.details };
  return { code: "INTERNAL_ERROR", message: "The batch item failed unexpectedly." };
}
function pause(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

export class BatchJobStore {
  private readonly jobs = new Map<string, BatchJob>();
  constructor(private readonly edits: EditStore) {}

  start(request: BatchRequest) {
    const targets = verify(request);
    if (this.jobs.size >= 20) {
      const finished = [...this.jobs.values()].find((job) => job.status !== "running");
      if (finished) this.jobs.delete(finished.jobId);
      else throw new SpineError("BATCH_LIMIT", "At most 20 batch jobs can run in one server session.");
    }
    const job: BatchJob = { jobId: randomUUID(), status: "running", createdAt: new Date().toISOString(),
      commit: request.commit ?? false, stopOnError: request.stopOnError ?? false,
      operation: structuredClone(request.operation), cancelRequested: false,
      items: targets.map((target) => ({ ...target, status: "queued" })) };
    this.jobs.set(job.jobId, job);
    void this.run(job);
    return this.snapshot(job);
  }

  get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new SpineError("BATCH_NOT_FOUND", "Batch job was not found in this server session.");
    return this.snapshot(job);
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new SpineError("BATCH_NOT_FOUND", "Batch job was not found in this server session.");
    if (job.status === "running") job.cancelRequested = true;
    return this.snapshot(job);
  }

  private snapshot(job: BatchJob) {
    const done = job.items.filter((item) => ["staged", "committed", "failed", "cancelled"].includes(item.status)).length;
    return { jobId: job.jobId, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt,
      commit: job.commit, stopOnError: job.stopOnError, cancelRequested: job.cancelRequested,
      progress: { done, total: job.items.length, failed: job.items.filter((item) => item.status === "failed").length },
      operation: job.operation, items: structuredClone(job.items) };
  }

  private async run(job: BatchJob): Promise<void> {
    try {
      for (const item of job.items) {
        await pause();
        if (job.cancelRequested) break;
        item.status = "staging";
        try {
          const preview = await this.edits.preview(item.path, operations(job.operation, item.animations));
          item.status = "staged";
          item.editId = preview.editId;
          item.diffResourceUri = preview.diffResourceUri;
          item.sourceHash = preview.sourceHash;
          item.afterHash = preview.afterHash;
          item.summaries = preview.summaries;
          if (job.commit && !job.cancelRequested) {
            item.status = "committing";
            const committed = await this.edits.commit(preview.editId);
            item.status = "committed";
            item.backupPath = committed.backupPath;
            item.manifestPath = committed.manifestPath;
          }
        } catch (error) {
          item.status = "failed";
          item.error = issue(error);
          if (job.stopOnError) job.cancelRequested = true;
        }
      }
    } catch (error) {
      const active = job.items.find((item) => item.status === "staging" || item.status === "committing");
      if (active) { active.status = "failed"; active.error = issue(error); }
      job.cancelRequested = true;
    } finally {
      for (const item of job.items) if (item.status === "queued") item.status = "cancelled";
      job.status = job.items.some((item) => item.status === "failed") ? "completed_with_errors"
        : job.cancelRequested ? "cancelled" : "completed";
      job.finishedAt = new Date().toISOString();
    }
  }
}
