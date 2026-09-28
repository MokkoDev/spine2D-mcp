import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BatchJobStore } from "../dist/spine/batch.js";
import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";

async function fixture(path) {
  const data = JSON.parse(skeletonText("4.3"));
  data.animations.walk = { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 20 }] } } };
  data.animations.run = { bones: { root: { rotate: [{ time: 0, value: 5 }, { time: 0.5, value: 25 }] } } };
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
async function settled(store, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = store.get(jobId);
    if (result.status !== "running") return result;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Batch did not finish in time.");
}

test("batch stages selected animations atomically per project and reports project progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-batch-"));
  const path = join(directory, "rig.json");
  const edits = new EditStore();
  const jobs = new BatchJobStore(edits);
  try {
    await fixture(path);
    const before = await readFile(path, "utf8");
    const started = jobs.start({ targets: [{ path, animations: ["walk", "run"] }],
      operation: { kind: "retime_animation", scale: 2 } });
    const finished = await settled(jobs, started.jobId);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.progress, { done: 1, total: 1, failed: 0 });
    assert.equal(finished.items[0].status, "staged");
    assert.equal(finished.items[0].summaries.length, 2);
    assert.equal(await readFile(path, "utf8"), before);
    assert.match(finished.items[0].diffResourceUri, /^spine-edit:\/\//);
    await edits.commit(finished.items[0].editId);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.animations.walk.bones.root.rotate[1].time, 2);
    assert.equal(after.animations.run.bones.root.rotate[1].time, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch can commit successful projects, stop after an error, and cancel queued work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-batch-partial-"));
  const paths = ["one", "two", "three"].map((name) => join(directory, `${name}.json`));
  const jobs = new BatchJobStore(new EditStore());
  try {
    await Promise.all(paths.map(fixture));
    const started = jobs.start({ targets: [
      { path: paths[0], animations: ["walk"] },
      { path: paths[1], animations: ["missing"] },
      { path: paths[2], animations: ["walk"] },
    ], operation: { kind: "retime_animation", scale: 2 }, commit: true, stopOnError: true });
    const finished = await settled(jobs, started.jobId);
    assert.equal(finished.status, "completed_with_errors");
    assert.deepEqual(finished.items.map((item) => item.status), ["committed", "failed", "cancelled"]);
    assert.equal(finished.items[1].error.code, "ANIMATION_NOT_FOUND");
    assert.ok(finished.items[0].backupPath && finished.items[0].manifestPath);
    assert.equal(JSON.parse(await readFile(paths[0], "utf8")).animations.walk.bones.root.rotate[1].time, 2);
    assert.equal(JSON.parse(await readFile(paths[2], "utf8")).animations.walk.bones.root.rotate[1].time, 1);

    const cancelled = jobs.start({ targets: [{ path: paths[2], animations: ["walk"] }],
      operation: { kind: "retime_animation", scale: 2 }, commit: true });
    jobs.cancel(cancelled.jobId);
    const noWork = await settled(jobs, cancelled.jobId);
    assert.equal(noWork.status, "cancelled");
    assert.equal(noWork.items[0].status, "cancelled");
    assert.equal(JSON.parse(await readFile(paths[2], "utf8")).animations.walk.bones.root.rotate[1].time, 1);
    assert.throws(() => jobs.start({ targets: [{ path: paths[0], animations: ["walk"] },
      { path: paths[0], animations: ["run"] }], operation: { kind: "retime_animation", scale: 2 } }),
    { code: "DUPLICATE_BATCH_TARGET" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
