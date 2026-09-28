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

test("revisions branch from staged results and commit only the selected full result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-stage-revision-"));
  const path = join(directory, "rig.json");
  const options = { stateDir: join(directory, "state") };
  const retime = (scale) => [{ kind: "retime_animation", animation: "walk", scale }];
  try {
    const original = fixture();
    await writeFile(path, original);
    const store = new EditStore(options);
    const first = await store.preview(path, retime(2));
    const second = await store.preview(path, retime(1.5), "revise", first.editId);
    const third = await store.preview(path, retime(1.5), undefined, second.editId);
    const branch = await store.preview(path, retime(2), undefined, first.editId);
    assert.equal(second.baseEditId, first.editId);
    assert.equal(second.sourceHash, first.sourceHash);
    assert.equal(second.operations.length, 2);
    assert.equal(second.summaries[1].beforeDuration, 2);
    assert.equal(second.summaries[1].afterDuration, 3);
    assert.equal(second.changeCount, 2);
    assert.equal(JSON.parse(store.snapshot(second.editId).afterText).animations.walk.bones.arm.rotate[1].time, 3);
    assert.equal(third.baseEditId, second.editId);
    assert.equal(third.operations.length, 3);
    assert.equal(third.summaries[2].beforeDuration, 3);
    assert.equal(JSON.parse(store.snapshot(third.editId).afterText).animations.walk.bones.arm.rotate[1].time, 4.5);
    assert.equal(JSON.parse(store.snapshot(branch.editId).afterText).animations.walk.bones.arm.rotate[1].time, 4);
    assert.equal(await readFile(path, "utf8"), original);

    const restarted = new EditStore(options);
    assert.equal((await restarted.preview(path, retime(1.5), "revise", first.editId)).editId, second.editId);
    await assert.rejects(restarted.preview(path, retime(2), "revise", first.editId), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(restarted.preview(path, [...retime(2), ...retime(1.5)], "revise", first.editId), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(restarted.preview(path, retime(1.5), "revise", branch.editId), { code: "IDEMPOTENCY_CONFLICT" });
    const committed = await restarted.commit(third.editId);
    assert.equal(JSON.parse(await readFile(path, "utf8")).animations.walk.bones.arm.rotate[1].time, 4.5);
    assert.equal(await readFile(committed.backupPath, "utf8"), original);
    const manifest = JSON.parse(await readFile(committed.manifestPath, "utf8"));
    assert.equal(manifest.baseEditId, second.editId);
    assert.equal(manifest.operations.length, 3);
    await assert.rejects(restarted.commit(branch.editId), { code: "SOURCE_CHANGED" });
    await assert.rejects(restarted.commit(second.editId), { code: "SOURCE_CHANGED" });
    await assert.rejects(restarted.commit(first.editId), { code: "SOURCE_CHANGED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a revision rejects a missing, different-file, or stale base stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-stage-base-"));
  const path = join(directory, "rig.json");
  const otherPath = join(directory, "other.json");
  const options = { stateDir: join(directory, "state") };
  const operation = [{ kind: "retime_animation", animation: "walk", scale: 2 }];
  try {
    await writeFile(path, fixture());
    await writeFile(otherPath, fixture());
    const store = new EditStore(options);
    const base = await store.preview(path, operation);
    await assert.rejects(store.preview(path, operation, undefined, "00000000-0000-4000-8000-000000000000"), { code: "EDIT_NOT_FOUND" });
    await assert.rejects(store.preview(otherPath, operation, undefined, base.editId), { code: "BASE_EDIT_MISMATCH" });
    await writeFile(path, fixture().replace('"value": 20', '"value": 25'));
    await assert.rejects(store.preview(path, operation, undefined, base.editId), { code: "SOURCE_CHANGED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("net diff shows the original and final key values while preserving every step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-net-diff-"));
  const path = join(directory, "rig.json");
  const store = new EditStore({ stateDir: join(directory, "state") });
  const key = (value) => [{ kind: "set_keyframe", animation: "walk",
    selector: { section: "bones", target: "arm", timelineType: "rotate" }, time: 0, values: { value } }];
  try {
    await writeFile(path, fixture());
    const first = await store.preview(path, key(30));
    const second = await store.preview(path, key(10), undefined, first.editId);
    assert.equal(second.changeCount, 2);
    assert.deepEqual(second.changes.map(({ before, after }) => [before.value, after.value]), [[0, 30], [30, 10]]);
    assert.equal(second.netChangeCount, 1);
    assert.deepEqual(second.netChanges, [{ path: "/animations/walk/bones/arm/rotate/0/value", before: 0, after: 10 }]);
    assert.deepEqual(store.netChanges(second.editId).changes, second.netChanges);
    const reverted = await store.preview(path, key(0), undefined, second.editId);
    assert.equal(reverted.changeCount, 3);
    assert.equal(reverted.netChangeCount, 0);
    assert.deepEqual(store.netChanges(reverted.editId).changes, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("revision response keeps newest steps visible beyond 100 history entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-revision-history-"));
  const path = join(directory, "rig.json");
  const store = new EditStore({ stateDir: join(directory, "state") });
  const key = (value) => ({ kind: "set_keyframe", animation: "walk",
    selector: { section: "bones", target: "arm", timelineType: "rotate" }, time: 0, values: { value } });
  try {
    await writeFile(path, fixture());
    let stage;
    for (let start = 1; start <= 101; start += 20) {
      const operations = Array.from({ length: Math.min(20, 102 - start) }, (_, offset) => key(start + offset));
      stage = await store.preview(path, operations, undefined, stage?.editId);
    }
    assert.equal(stage.changeCount, 101);
    assert.equal(stage.changesOffset, 1);
    assert.equal(stage.changes.length, 100);
    assert.equal(stage.changes[0].after.value, 2);
    assert.equal(stage.changes.at(-1).after.value, 101);
    assert.deepEqual(stage.netChanges, [{ path: "/animations/walk/bones/arm/rotate/0/value", before: 0, after: 101 }]);
    assert.equal(store.changes(stage.editId).changes.length, 101);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a child request retries after its parent expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-child-retry-"));
  const path = join(directory, "rig.json");
  const stateDir = join(directory, "state");
  const retime = (scale) => [{ kind: "retime_animation", animation: "walk", scale }];
  try {
    await writeFile(path, fixture());
    const store = new EditStore({ stateDir });
    const parent = await store.preview(path, retime(2));
    const child = await store.preview(path, retime(1.5), "child-request", parent.editId);
    const parentPath = join(stateDir, `${parent.editId}.json`);
    const savedParent = JSON.parse(await readFile(parentPath, "utf8"));
    savedParent.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(parentPath, JSON.stringify(savedParent));

    const restarted = new EditStore({ stateDir });
    assert.equal((await restarted.preview(path, retime(1.5), "child-request", parent.editId)).editId, child.editId);
    await assert.rejects(restarted.preview(path, retime(2), "child-request", parent.editId), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(restarted.preview(path, [...retime(2), ...retime(1.5)], "child-request", parent.editId), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(restarted.preview(path, retime(1.5), "new-request", parent.editId), { code: "EDIT_NOT_FOUND" });
    assert.equal(JSON.parse(restarted.snapshot(child.editId).afterText).animations.walk.bones.arm.rotate[1].time, 3);
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
