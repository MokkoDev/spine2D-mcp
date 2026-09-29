import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureConstraintPose, applyConstraintPoseOperations } from "../dist/spine/constraint-pose.js";
import { parseDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { upsertConstraintText } from "../dist/spine/rig.js";
import { validateDocument } from "../dist/spine/validate.js";

function fixture(version) {
  const data = { skeleton: { spine: version }, bones: [
    { name: "root" }, { name: "arm", parent: "root" }, { name: "goal", parent: "root" }],
    slots: [{ name: "route-slot", bone: "root" }],
    skins: [{ name: "default", attachments: { "route-slot": { route: {
      type: "path", closed: false, constantSpeed: true, vertexCount: 6,
      vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24],
    } } } }], animations: {} };
  let current = parseDocument(`/tmp/constraint-pose-${version}.json`, JSON.stringify(data));
  const add = (constraintType, name, roles, values = {}) => {
    current = parseDocument(current.path, upsertConstraintText(current,
      { kind: "upsert_constraint", constraintType, name, edition: "professional", ...roles, values }).text);
  };
  add("ik", "aim", { bones: ["arm"], target: "goal" }, { mix: 0.3, softness: 2 });
  add("transform", "follow", { bones: ["arm"], target: "goal" },
    version === "4.3" ? { properties: ["rotate", "x"] } : {});
  add("path", "route", { bones: ["arm"], target: "route-slot" }, { positionMode: "fixed", position: 7 });
  add("physics", "sway", { bone: "arm" }, { inertia: 0.8 });
  const result = structuredClone(current.data);
  result.animations.swing = {
    ik: { aim: [
      { time: 0.25, mix: 0.2, softness: 4, bendPositive: false, curve: "stepped" },
      { time: 1, mix: 0.8, softness: 10, bendPositive: true },
    ] },
    transform: { follow: [
      { time: 0, mixRotate: 0, mixX: 0.2, mixY: 0.3 },
      { time: 1, mixRotate: 1, mixX: 0.6, mixY: 0.7 },
    ] },
    path: { route: { position: [{ time: 0, value: 5 }, { time: 1, value: 15 }],
      mix: [{ time: 0, mixRotate: 0.2, mixX: 0.3, mixY: 0.4 }] } },
    physics: { sway: { inertia: [{ time: 0, value: 0.4 }, { time: 1, value: 0.6 }],
      reset: [{ time: 0.5 }] } },
  };
  return parseDocument(current.path, JSON.stringify(result));
}

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} constraint pose samples and stages mapped IK, transform, path, and physics channels`, async () => {
    const source = fixture(version);
    assert.deepEqual(validateDocument(source), []);
    const pose = captureConstraintPose(source, "swing", 0.5, "mid-swing");
    assert.equal(pose.entries.length, 5);
    assert.deepEqual(pose.skippedTimelines, ["/animations/swing/physics/sway/reset"]);
    const ik = pose.entries.find((entry) => entry.type === "ik");
    assert.deepEqual(ik.values, { mix: 0.2, softness: 4, bendPositive: false, compress: false, stretch: false });
    assert.equal(pose.entries.find((entry) => entry.type === "transform").values.mixRotate, 0.5);
    assert.equal(pose.entries.find((entry) => entry.type === "path" && entry.timelineType === "position").values.value, 10);
    assert.equal(pose.entries.find((entry) => entry.type === "physics").values.value, 0.5);

    const targetData = structuredClone(source.data);
    const constraintNames = { aim: "aim-target", follow: "follow-target", route: "route-target", sway: "sway-target" };
    for (const section of version === "4.3" ? ["constraints"] : ["ik", "transform", "path", "physics"]) {
      targetData[section].forEach((definition) => { definition.name = constraintNames[definition.name]; });
    }
    targetData.animations = { target: { physics: { "sway-target": {
      inertia: [{ time: 0, value: 0.2 }, { time: 1, value: 0.4 }],
    } } } };
    const target = parseDocument("/tmp/constraint-pose-target.json", JSON.stringify(targetData));
    const prepared = applyConstraintPoseOperations(target, pose, "target", 0.5,
      { maps: { ik: { aim: "aim-target" }, transform: { follow: "follow-target" },
        path: { route: "route-target" }, physics: { sway: "sway-target" } } });
    assert.equal(prepared.summary.channelCount, 5);
    const directory = await mkdtemp(join(tmpdir(), "spine-constraint-pose-"));
    const path = join(directory, "target.json");
    try {
      await writeFile(path, target.text);
      const edits = new EditStore();
      const stage = await edits.preview(path, prepared.operations);
      assert.deepEqual(stage.diagnostics, []);
      assert.equal(await readFile(path, "utf8"), target.text);
      const after = parseDocument(path, edits.snapshot(stage.editId).afterText);
      assert.equal(after.data.animations.target.ik["aim-target"][0].mix, 0.2);
      assert.equal(after.data.animations.target.transform["follow-target"][0].mixRotate, 0.5);
      assert.equal(after.data.animations.target.path["route-target"].position[0].value, 10);
      assert.equal(after.data.animations.target.physics["sway-target"].inertia[1].value, 0.5);
      assert.deepEqual(validateDocument(after), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    assert.throws(() => applyConstraintPoseOperations(target, pose, "target", 0.5, { blend: 0.5 }),
      { code: "DISCRETE_BLEND_UNSUPPORTED" });
    const incompatible = structuredClone(target.data);
    const route = version === "4.3" ? incompatible.constraints.find((item) => item.name === "route-target") : incompatible.path[0];
    route.spacingMode = "percent";
    assert.throws(() => applyConstraintPoseOperations(parseDocument(target.path, JSON.stringify(incompatible)), pose,
      "target", 0.5, { maps: { path: { route: "route-target" }, ik: { aim: "aim-target" },
        transform: { follow: "follow-target" }, physics: { sway: "sway-target" } } }),
    { code: "INCOMPATIBLE_CONSTRAINT_POSE" });
  });
}

test("constraint pose uses setup values before the first key and blends numeric physics channels", () => {
  const sourceData = structuredClone(fixture("4.3").data);
  sourceData.animations.swing.physics.sway.inertia[0].time = 0.25;
  const source = parseDocument("/tmp/constraint-pose-before.json", JSON.stringify(sourceData));
  const pose = captureConstraintPose(source, "swing", 0, "before-aim", { ik: ["aim"], physics: ["sway"] });
  assert.equal(pose.entries.find((entry) => entry.type === "ik").values.mix, 0.3);
  assert.equal(pose.entries.find((entry) => entry.type === "physics").values.value, 0.8);
  const target = structuredClone(source.data);
  target.animations.blend = { physics: { sway: { inertia: [{ time: 0, value: 0.2 }, { time: 1, value: 0.4 }] } } };
  const physicsOnly = { ...pose, entries: pose.entries.filter((entry) => entry.type === "physics") };
  const result = applyConstraintPoseOperations(parseDocument(source.path, JSON.stringify(target)), physicsOnly,
    "blend", 0.5, { blend: 0.5 });
  assert.equal(result.operations.find((operation) => operation.kind === "set_keyframe"
    && operation.selector.section === "physics" && operation.selector.timelineType === "inertia").values.value, 0.55);
  assert.throws(() => captureConstraintPose(source, "swing", 0, "bad", { ik: ["missing"] }),
    { code: "INVALID_POSE_SELECTION" });
});

test("selected constraints include setup channels even when the animation has no keys for them", () => {
  const source = fixture("4.2");
  const pose = captureConstraintPose(source, "swing", 0.1, "setup-path", { path: ["route"] });
  assert.deepEqual(pose.entries.filter((entry) => entry.type === "path").map((entry) => entry.timelineType).sort(),
    ["mix", "position", "spacing"]);
  assert.equal(pose.entries.find((entry) => entry.type === "path" && entry.timelineType === "spacing").values.value, 0);
});

test("global physics reset timelines are reported without entering a saved constraint pose", () => {
  const data = structuredClone(fixture("4.3").data);
  data.animations.swing.physics[""] = { reset: [{ time: 0.5 }] };
  const source = parseDocument("/tmp/constraint-pose-global.json", JSON.stringify(data));
  assert.deepEqual(validateDocument(source), []);
  const pose = captureConstraintPose(source, "swing", 0.5, "global-skip");
  assert.ok(pose.skippedTimelines.includes("/animations/swing/physics//reset"));
});

test("constraint pose samples absolute Bézier controls and requires explicit curve linearization on apply", async () => {
  const sourceData = structuredClone(fixture("4.3").data);
  sourceData.animations.swing.path.route.position = [
    { time: 0, value: 0, curve: [0.25, 0, 0.75, 0] }, { time: 1, value: 10 },
  ];
  const source = parseDocument("/tmp/constraint-pose-curve.json", JSON.stringify(sourceData));
  const pose = captureConstraintPose(source, "swing", 0.5, "curve", { path: ["route"] });
  assert.equal(pose.entries.find((entry) => entry.type === "path" && entry.timelineType === "position").values.value, 1.25);
  const directory = await mkdtemp(join(tmpdir(), "spine-constraint-pose-curve-"));
  const path = join(directory, "target.json");
  try {
    await writeFile(path, source.text);
    const edits = new EditStore();
    const rejected = applyConstraintPoseOperations(source, pose, "swing", 0.5);
    await assert.rejects(edits.preview(path, rejected.operations), { code: "CURVE_SPLIT_REQUIRED" });
    const accepted = applyConstraintPoseOperations(source, pose, "swing", 0.5, { curvePolicy: "linearize" });
    const stage = await edits.preview(path, accepted.operations);
    assert.deepEqual(stage.diagnostics, []);
    const after = parseDocument(path, edits.snapshot(stage.editId).afterText);
    assert.equal(after.data.animations.swing.path.route.position[1].value, 1.25);
    assert.equal(after.data.animations.swing.path.route.position[0].curve, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
