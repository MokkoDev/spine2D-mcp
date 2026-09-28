import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { EditStore } from "../dist/spine/edit.js";

function fixture() {
  const data = JSON.parse(skeletonText("4.3"));
  data.bones.push({ name: "arm", parent: "root" });
  data.animations.walk = { bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 20 }] } } };
  return `${JSON.stringify(data, null, 2)}\n`;
}

test("staged edits, diffs, request IDs, and commits survive store restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-stage-restart-"));
  const path = join(directory, "rig.json");
  const options = { stateDir: join(directory, "state") };
  const operations = [{ kind: "retime_animation", animation: "walk", scale: 2 }];
  try {
    await writeFile(path, fixture());
    const first = new EditStore(options);
    const stage = await first.preview(path, operations, "twice-as-long");
    assert.equal(stage.changeCount, 1);
    const restarted = new EditStore(options);
    assert.equal(restarted.snapshot(stage.editId).afterHash, stage.afterHash);
    assert.equal(restarted.changes(stage.editId).changes.length, 1);
    const repeated = await restarted.preview(path, operations, "twice-as-long");
    assert.equal(repeated.editId, stage.editId);
    const committed = await restarted.commit(stage.editId);
    assert.equal(JSON.parse(await readFile(committed.manifestPath, "utf8")).status, "committed");
    assert.deepEqual(await new EditStore(options).commit(stage.editId), committed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed final manifest write reports applied source and retry finalizes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-finalize-retry-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  try {
    await writeFile(path, fixture());
    const first = new EditStore({ stateDir, beforeFinalize: async () => { throw new Error("injected write failure"); } });
    const stage = await first.preview(path, [{ kind: "retime_animation", animation: "walk", scale: 2 }]);
    await assert.rejects(first.commit(stage.editId), (error) => error.code === "COMMIT_FINALIZATION_FAILED"
      && error.details.sourceApplied === true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate[1].time, 2);
    const manifestPath = join(directory, ".spine2d-mcp", "history", stage.editId, "manifest.json");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).status, "prepared");
    const restarted = new EditStore({ stateDir });
    const committed = await restarted.commit(stage.editId);
    assert.equal(committed.manifestPath, manifestPath);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).status, "committed");
    assert.deepEqual(await new EditStore({ stateDir }).commit(stage.editId), committed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a no-op stage can finalize after a post-replacement failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-noop-finalize-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  try {
    await writeFile(path, fixture());
    const first = new EditStore({ stateDir, beforeFinalize: async () => { throw new Error("injected failure"); } });
    const stage = await first.preview(path, [{ kind: "retime_animation", animation: "walk", scale: 1 }]);
    assert.equal(stage.sourceHash, stage.afterHash);
    await assert.rejects(first.commit(stage.editId), { code: "COMMIT_FINALIZATION_FAILED" });
    const recovered = await new EditStore({ stateDir }).commit(stage.editId);
    assert.equal(JSON.parse(await readFile(recovered.manifestPath, "utf8")).status, "committed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expired durable stages are unavailable and their request IDs can be reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-stage-expiry-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  const operations = [{ kind: "retime_animation", animation: "walk", scale: 2 }];
  try {
    await writeFile(path, fixture());
    const first = await new EditStore({ stateDir }).preview(path, operations, "old-request");
    const statePath = join(stateDir, `${first.editId}.json`);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    saved.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(statePath, JSON.stringify(saved));
    const restarted = new EditStore({ stateDir });
    assert.throws(() => restarted.snapshot(first.editId), { code: "EDIT_NOT_FOUND" });
    const fresh = await restarted.preview(path, operations, "old-request");
    assert.notEqual(fresh.editId, first.editId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("two server stores cannot finalize the same edit concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-stage-lock-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  let enteredResolve;
  let release;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await writeFile(path, fixture());
    const first = new EditStore({ stateDir, beforeFinalize: async () => {
      enteredResolve();
      await gate;
    } });
    const stage = await first.preview(path, [{ kind: "retime_animation", animation: "walk", scale: 2 }]);
    const pending = first.commit(stage.editId);
    await entered;
    const second = new EditStore({ stateDir });
    await assert.rejects(second.commit(stage.editId), { code: "COMMIT_IN_PROGRESS" });
    release();
    const committed = await pending;
    assert.deepEqual(await second.commit(stage.editId), committed);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart recovers a partially prepared commit without replacing the original twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-partial-prepare-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  try {
    const original = fixture();
    await writeFile(path, original);
    const stage = await new EditStore({ stateDir }).preview(path,
      [{ kind: "retime_animation", animation: "walk", scale: 2 }]);
    const historyDir = join(directory, ".spine2d-mcp", "history", stage.editId);
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "before.json"), original);
    const committed = await new EditStore({ stateDir }).commit(stage.editId);
    assert.equal(JSON.parse(await readFile(committed.manifestPath, "utf8")).status, "committed");
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate[1].time, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery preserves a committed manifest if the source is later reverted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-history-preserve-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  try {
    const original = fixture();
    await writeFile(path, original);
    const store = new EditStore({ stateDir });
    const stage = await store.preview(path, [{ kind: "retime_animation", animation: "walk", scale: 2 }]);
    const committed = await store.commit(stage.editId);
    const statePath = join(stateDir, `${stage.editId}.json`);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    delete saved.committed; // Simulate a crash before the completed stage record was updated.
    await writeFile(statePath, JSON.stringify(saved));
    await writeFile(path, original); // An external edit restored the old source.
    await assert.rejects(new EditStore({ stateDir }).commit(stage.editId), { code: "COMMIT_RECOVERY_FAILED" });
    assert.equal(JSON.parse(await readFile(committed.manifestPath, "utf8")).status, "committed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
