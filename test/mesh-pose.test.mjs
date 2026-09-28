import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { applyMeshPoseOperations, captureMeshPose } from "../dist/spine/mesh-pose.js";
import { validateDocument } from "../dist/spine/validate.js";

const mesh = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1],
  triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 10, 10], hull: 3 };

function fixture(version) {
  const data = JSON.parse(skeletonText(version));
  data.slots.push({ name: "body", bone: "root", attachment: "sheet" });
  data.skins[0].attachments.body = { sheet: mesh };
  const keys = [{ time: 0, offset: 2, vertices: [2, 4], curve: [0.25, 0, 0.75, 1] },
    { time: 1, offset: 2, vertices: [6, 8] }];
  data.animations.warp = version === "4.2"
    ? { deform: { default: { body: { sheet: keys } } } }
    : { attachments: { default: { body: { sheet: { deform: keys } } } } };
  return parseDocument(`/tmp/mesh-pose-${version}.json`, `${JSON.stringify(data)}\n`);
}

for (const version of ["4.2", "4.3"]) {
  test(`mesh pose samples a deform curve and stages a compatible ${version} key`, async () => {
    const source = fixture(version);
    assert.deepEqual(validateDocument(source), []);
    const pose = captureMeshPose(source, "warp", 0.5, "warp-middle");
    assert.deepEqual(pose.entries[0].values, [0, 0, 4, 6, 0, 0]);
    const prepared = applyMeshPoseOperations(source, pose, "reused", 0.25);
    const directory = await mkdtemp(join(tmpdir(), "spine2d-mesh-pose-"));
    const path = join(directory, "rig.json");
    try {
      await writeFile(path, source.text);
      const edits = new EditStore();
      const stage = await edits.preview(path, prepared.operations);
      assert.deepEqual(stage.diagnostics, []);
      assert.equal(await readFile(path, "utf8"), source.text);
      const after = parseDocument(path, edits.snapshot(stage.editId).afterText);
      const key = version === "4.2"
        ? after.data.animations.reused.deform.default.body.sheet[0]
        : after.data.animations.reused.attachments.default.body.sheet.deform[0];
      assert.deepEqual(key.vertices, pose.entries[0].values);
      assert.deepEqual(validateDocument(after), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("mesh pose maps names, blends with target values, and checks geometry and mappings", () => {
  const source = fixture("4.3");
  const pose = captureMeshPose(source, "warp", 0.5, "mapped");
  const targetData = structuredClone(source.data);
  targetData.slots[0].name = "torso";
  targetData.slots[0].attachment = "cloth";
  targetData.skins[0].attachments = { torso: { cloth: structuredClone(mesh) } };
  targetData.animations = { idle: { attachments: { default: { torso: { cloth: { deform: [
    { time: 0, vertices: [0, 0, 10, 10, 0, 0] },
  ] } } } } } };
  const target = parseDocument("/tmp/mesh-target.json", JSON.stringify(targetData));
  const maps = { slots: { body: "torso" }, attachments: { body: { sheet: "cloth" } } };
  assert.deepEqual(validateDocument(target), []);
  const prepared = applyMeshPoseOperations(target, pose, "idle", 0, 0.5, maps);
  assert.equal(prepared.summary.meshCount, 1);
  assert.deepEqual(prepared.operations[0].values.vertices, [0, 0, 7, 8, 0, 0]);
  const wrong = structuredClone(targetData);
  wrong.skins[0].attachments.torso.cloth.vertices[0] = 2;
  assert.throws(() => applyMeshPoseOperations(parseDocument("/tmp/wrong-mesh.json", JSON.stringify(wrong)),
    pose, "idle", 0, 1, maps), { code: "INCOMPATIBLE_MESH" });
  assert.throws(() => applyMeshPoseOperations(target, pose, "idle", 0, 1,
    { slots: { missing: "torso" } }), { code: "INVALID_POSE_MAP" });
});

test("mesh pose rejects unsupported linked meshes and version mismatches", () => {
  const source = fixture("4.3");
  const linkedData = structuredClone(source.data);
  linkedData.skins[0].attachments.body.sheet = { type: "linkedmesh", source: "other" };
  linkedData.skins[0].attachments.body.other = mesh;
  const linked = parseDocument("/tmp/linked-pose.json", JSON.stringify(linkedData));
  assert.deepEqual(validateDocument(linked), []);
  assert.throws(() => captureMeshPose(linked, "warp", 0, "linked"),
    { code: "UNSUPPORTED_MESH_POSE_ATTACHMENT" });
  assert.throws(() => applyMeshPoseOperations(fixture("4.2"),
    captureMeshPose(source, "warp", 0, "v43"), "warp", 0), { code: "VERSION_MISMATCH" });
});

test("weighted mesh poses require mapped bone index order", () => {
  const sourceData = structuredClone(fixture("4.3").data);
  sourceData.skins[0].attachments.body.sheet.vertices = [
    1, 0, 0, 0, 1,
    1, 0, 10, 0, 1,
    1, 0, 10, 10, 1,
  ];
  const source = parseDocument("/tmp/weighted-source.json", JSON.stringify(sourceData));
  assert.deepEqual(validateDocument(source), []);
  const pose = captureMeshPose(source, "warp", 0.5, "weighted");
  assert.equal(pose.entries[0].weighted, true);
  assert.equal(pose.entries[0].coordinateCount, 6);
  const targetData = structuredClone(sourceData);
  targetData.bones[0].name = "base";
  targetData.slots[0].bone = "base";
  targetData.animations = {};
  const target = parseDocument("/tmp/weighted-target.json", JSON.stringify(targetData));
  assert.deepEqual(validateDocument(target), []);
  assert.throws(() => applyMeshPoseOperations(target, pose, "transfer", 0),
    { code: "INCOMPATIBLE_MESH" });
  const mapped = applyMeshPoseOperations(target, pose, "transfer", 0, 1,
    { bones: { root: "base" } });
  assert.equal(mapped.summary.meshCount, 1);
});
