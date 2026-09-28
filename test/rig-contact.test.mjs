import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDocument } from "../dist/spine/document.js";
import { analyzeRigContacts } from "../dist/spine/rig-contact.js";

const ground = { point: { x: 0, y: 0 }, normal: { x: 0, y: 1 } };
const timing = { fps: 1, frameStart: 0, frameCount: 2 };
function document(name, data) {
  return parseDocument(`/tmp/${name}.json`, JSON.stringify(data));
}

test("quadruped paw follows IK and ignores overlapping attachment artwork", () => {
  const rig = document("quadruped", {
    skeleton: { spine: "4.3.13" },
    bones: [{ name: "root" }, { name: "frontLeg", parent: "root", length: 4 },
      { name: "frontPaw", parent: "frontLeg", x: 4 }, { name: "goal", parent: "root", y: 4 }],
    slots: [{ name: "paw-slot", bone: "frontPaw", attachment: "paw-art" },
      { name: "overlap-slot", bone: "root", attachment: "overlap-art" }],
    skins: [{ name: "default", attachments: {
      "paw-slot": { "paw-art": { width: 1, height: 1 } },
      "overlap-slot": { "overlap-art": { width: 20, height: 20, y: -8 } },
    } }],
    constraints: [{ type: "ik", name: "front-paw-ik", bones: ["frontLeg"], target: "goal", mix: 1 }],
    animations: { step: { bones: { goal: { translate: [
      { time: 0, x: 0, y: 0 }, { time: 1, x: 4, y: -4 },
    ] } } } },
  });
  const result = analyzeRigContacts(rig, "step", timing, [
    { name: "front-paw", mode: "plant", fromFrame: 0, toFrame: 1,
      target: { kind: "bonePoint", bone: "frontPaw", x: 0, y: 0 }, surface: ground,
      slipThreshold: 0.1 },
    { name: "paw-surface", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "paw-slot", attachment: "paw-art" }, surface: ground },
  ]);
  const paw = result.contacts[0];
  assert.ok(Math.abs(paw.samples[0].x) < 0.01);
  assert.ok(Math.abs(paw.samples[0].y - 4) < 0.01);
  assert.ok(Math.abs(paw.samples[1].x - 4) < 0.01);
  assert.equal(paw.maxSlip, 4);
  assert.ok(result.hints.some((hint) => hint.code === "CONTACT_SLIDE"));
  assert.equal(result.contacts[1].maxPenetration, 0.5);
});

function wheelRig(distance) {
  return document("wheel", { skeleton: { spine: "4.3.13" },
    bones: [{ name: "root" }, { name: "wheel", parent: "root", y: 1 }],
    slots: [{ name: "wheel-slot", bone: "wheel", attachment: "wheel-art" }],
    skins: [{ name: "default", attachments: {
      "wheel-slot": { "wheel-art": { width: 2, height: 2 } },
    } }],
    animations: { roll: { bones: {
      root: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: -distance, y: 0 }] },
      wheel: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 180 / Math.PI }] },
    } } },
  });
}

test("rolling wheel checks travel against angular rotation instead of planting one rim point", () => {
  const marker = { name: "wheel", mode: "roll", fromFrame: 0, toFrame: 1,
    target: { kind: "bonePoint", bone: "wheel", x: 0, y: 0 }, surface: ground,
    rollingRadius: 1, slipThreshold: 0.1 };
  const rolling = analyzeRigContacts(wheelRig(1), "roll", timing, [marker]);
  assert.ok(rolling.contacts[0].maxSlip < 0.001);
  assert.equal(rolling.contacts[0].maxPenetration, 0);
  assert.ok(!rolling.hints.some((hint) => hint.code === "ROLL_SLIP"));
  const sliding = analyzeRigContacts(wheelRig(0.4), "roll", timing, [marker]);
  assert.ok(sliding.contacts[0].maxSlip > 0.5);
  assert.ok(sliding.hints.some((hint) => hint.code === "ROLL_SLIP"));
});

test("snake belly mesh deformation is isolated from overlapping artwork", () => {
  const rig = document("snake", { skeleton: { spine: "4.3.13" },
    bones: [{ name: "root" }],
    slots: [{ name: "belly-slot", bone: "root", attachment: "belly-mesh" },
      { name: "overlap-slot", bone: "root", attachment: "overlap-art" }],
    skins: [{ name: "default", attachments: {
      "belly-slot": { "belly-mesh": { type: "mesh", uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        triangles: [0, 1, 2, 2, 3, 0], hull: 4,
        vertices: [-2, 0.5, 2, 0.5, 2, 1.5, -2, 1.5] } },
      "overlap-slot": { "overlap-art": { width: 8, height: 4, y: -2 } },
    } }],
    animations: { slither: { attachments: { default: { "belly-slot": { "belly-mesh": { deform: [
      { time: 0, vertices: [0, 0, 0, 0, 0, 0, 0, 0] },
      { time: 1, offset: 1, vertices: [-2] },
    ] } } } } } },
  });
  const contacts = [
    { name: "belly", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "belly-slot", attachment: "belly-mesh", vertexIndices: [0, 1] },
      surface: ground },
    { name: "other-art", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "overlap-slot", attachment: "overlap-art" },
      surface: ground },
  ];
  const result = analyzeRigContacts(rig, "slither", timing, contacts);
  assert.equal(result.contacts[0].samples[0].penetration, 0);
  assert.equal(result.contacts[0].samples[1].penetration, 1.5);
  assert.equal(result.contacts[1].maxPenetration, 4);
  assert.ok(result.hints.some((hint) => hint.code === "SURFACE_PENETRATION" && hint.path === "/rigContacts/belly"));
});

test("Spine 4.2 region geometry remains available for rig contacts", () => {
  const rig = document("snake-42", { skeleton: { spine: "4.2.120" },
    bones: [{ name: "root" }], slots: [{ name: "belly", bone: "root", attachment: "skin" }],
    skins: [{ name: "default", attachments: { belly: { skin: { width: 2, height: 2, y: 1 } } } }],
    animations: { rest: {} },
  });
  const result = analyzeRigContacts(rig, "rest", { fps: 30, frameStart: 0, frameCount: 1 }, [
    { name: "resting-belly", mode: "touch", fromFrame: 0, toFrame: 0,
      target: { kind: "attachmentShape", slot: "belly", attachment: "skin" }, surface: ground },
  ]);
  assert.equal(result.contacts[0].maxPenetration, 0);
  assert.equal(result.contacts[0].sampledFrames, 1);
});

test("Spine 4.2 mesh contact follows its deform timeline", () => {
  const rig = document("belly-42", { skeleton: { spine: "4.2.120" }, bones: [{ name: "root" }],
    slots: [{ name: "belly", bone: "root", attachment: "mesh" }],
    skins: [{ name: "default", attachments: { belly: { mesh: {
      type: "mesh", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3,
      vertices: [0, 1, 1, 1, 0, 2],
    } } } }],
    animations: { press: { deform: { default: { belly: { mesh: [
      { time: 0, vertices: [0, 0, 0, 0, 0, 0] },
      { time: 1, offset: 1, vertices: [-2] },
    ] } } } } },
  });
  const result = analyzeRigContacts(rig, "press", timing, [
    { name: "belly", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "belly", attachment: "mesh", vertexIndices: [0] },
      surface: ground },
  ]);
  assert.equal(result.contacts[0].samples[0].penetration, 0);
  assert.equal(result.contacts[0].samples[1].penetration, 1);
});

test("attachment geometry includes weighted bone motion", () => {
  const rig = document("weighted", { skeleton: { spine: "4.3.13" },
    bones: [{ name: "root" }, { name: "moving", parent: "root", x: 10 }],
    slots: [{ name: "belly", bone: "root", attachment: "weighted-mesh" }],
    skins: [{ name: "default", attachments: { belly: { "weighted-mesh": {
      type: "mesh", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3,
      vertices: [2, 0, 0, 1, 0.5, 1, -10, 1, 0.5,
        2, 0, 1, 1, 0.5, 1, -9, 1, 0.5,
        2, 0, 0, 2, 0.5, 1, -10, 2, 0.5],
    } } } }],
    animations: { sway: { bones: { moving: { translate: [
      { time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: -4 },
    ] } } } },
  });
  const result = analyzeRigContacts(rig, "sway", timing, [
    { name: "weighted-belly", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "belly", attachment: "weighted-mesh", vertexIndices: [0] },
      surface: ground },
  ]);
  assert.equal(result.contacts[0].samples[0].penetration, 0);
  assert.equal(result.contacts[0].samples[1].penetration, 1);
});

test("rig contacts sample the preview frame offset and project motion onto a sloped surface", () => {
  const rig = document("slope", { skeleton: { spine: "4.3.13" }, bones: [{ name: "root" }],
    slots: [], skins: [{ name: "default", attachments: {} }],
    animations: { move: { bones: { root: { translate: [
      { time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 0 },
    ] } } } },
  });
  const result = analyzeRigContacts(rig, "move", { fps: 2, frameStart: 1, frameCount: 2 }, [
    { name: "slope-contact", mode: "plant", fromFrame: 0, toFrame: 1,
      target: { kind: "bonePoint", bone: "root", x: 0, y: 0 },
      surface: { point: { x: 0, y: 0 }, normal: { x: 1, y: 1 } }, slipThreshold: 3 },
  ]);
  assert.deepEqual(result.contacts[0].samples.map((sample) => sample.time), [0.5, 1]);
  assert.deepEqual(result.contacts[0].samples.map((sample) => sample.x), [5, 10]);
  assert.ok(Math.abs(result.contacts[0].maxSlip - 5 / Math.SQRT2) < 0.001);
  assert.ok(result.hints.some((hint) => hint.code === "CONTACT_SLIDE"));
});

test("an inactive attachment is reported missing instead of borrowing the slot's replacement art", () => {
  const rig = document("swapped", { skeleton: { spine: "4.3.13" }, bones: [{ name: "root" }],
    slots: [{ name: "body", bone: "root", attachment: "belly" }],
    skins: [{ name: "default", attachments: { body: {
      belly: { width: 2, height: 2, y: 2 }, replacement: { width: 2, height: 8, y: -3 },
    } } }],
    animations: { swap: { slots: { body: { attachment: [
      { time: 0, name: "belly" }, { time: 1, name: "replacement" },
    ] } } } },
  });
  const result = analyzeRigContacts(rig, "swap", timing, [
    { name: "belly", mode: "touch", fromFrame: 0, toFrame: 1,
      target: { kind: "attachmentShape", slot: "body", attachment: "belly" }, surface: ground },
  ]);
  assert.deepEqual(result.contacts[0].missingFrames, [1]);
  assert.equal(result.contacts[0].maxPenetration, 0);
  assert.ok(result.hints.some((hint) => hint.code === "RIG_CONTACT_MISSING"));
});

test("a preview with several possible skins requires an explicit skin", () => {
  const rig = document("skins", { skeleton: { spine: "4.3.13" }, bones: [{ name: "root" }],
    slots: [], skins: [{ name: "default", attachments: {} }, { name: "other", attachments: {} }],
    animations: { idle: {} },
  });
  assert.throws(() => analyzeRigContacts(rig, "idle", { fps: 30, frameStart: 0, frameCount: 1 }, [
    { name: "root", mode: "touch", fromFrame: 0, toFrame: 0,
      target: { kind: "bonePoint", bone: "root", x: 0, y: 0 }, surface: ground },
  ]), { code: "PREVIEW_SKIN_UNAVAILABLE" });
});
