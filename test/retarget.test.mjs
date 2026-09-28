import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { retargetAnimationText } from "../dist/spine/retarget.js";
import { validateDocument } from "../dist/spine/validate.js";

const mesh = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [0, 0, 1, 0, 1, 1], hull: 3 };
const sourceData = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  slots: [{ name: "hand", bone: "arm", attachment: "open" }, { name: "body", bone: "root", attachment: "base" }],
  skins: [
    { name: "default", attachments: { hand: { open: {}, closed: {} }, body: { base: {} } } },
    { name: "action", attachments: { hand: { mesh } } },
  ],
  constraints: [{ type: "ik", name: "aim", bones: ["arm"], target: "root" }],
  events: { beat: {} },
  animations: { strike: {
    bones: { arm: { rotate: [{ value: 0, curve: [0.2, 0, 0.8, 20] }, { time: 1, value: 20 }] } },
    slots: { hand: { attachment: [{ name: "open" }, { time: 0.5, name: "closed" }] } },
    ik: { aim: [{ mix: 0.5 }, { time: 1, mix: 1 }] },
    attachments: { action: { hand: { mesh: { deform: [{ vertices: [0.1, 0.2] }] } } } },
    events: [{ time: 0.25, name: "beat" }],
    drawOrder: [{ time: 0.75, offsets: [{ slot: "hand", offset: 1 }, { slot: "body", offset: -1 }] }],
  } },
};
const targetData = {
  skeleton: { spine: "4.3.26" },
  bones: [{ name: "root" }, { name: "wing", parent: "root" }],
  slots: [{ name: "claw", bone: "wing", attachment: "grip" }, { name: "torso", bone: "root", attachment: "base" }],
  skins: [
    { name: "default", attachments: { claw: { grip: {}, release: {} }, torso: { base: {} } } },
    { name: "costume", attachments: { claw: { net: mesh } } },
  ],
  constraints: [{ type: "ik", name: "targetAim", bones: ["wing"], target: "root" }],
  events: { impact: {} },
  animations: {},
};
const maps = {
  bones: { arm: "wing" }, slots: { hand: "claw", body: "torso" }, skins: { action: "costume" },
  attachments: { hand: { open: "grip", closed: "release", mesh: "net" } },
  events: { beat: "impact" }, constraints: { ik: { aim: "targetAim" } },
};

function doc(path, data) {
  return parseDocument(path, `${JSON.stringify(data, null, 2)}\n`);
}

test("retarget maps every animation reference and preserves curve, deform, and event payloads", () => {
  const source = doc("/tmp/retarget-source.json", sourceData);
  const target = doc("/tmp/retarget-target.json", targetData);
  assert.deepEqual(validateDocument(source), []);
  assert.deepEqual(validateDocument(target), []);
  const result = retargetAnimationText(target, source, { kind: "retarget_animation", sourcePath: source.path,
    sourceHash: source.hash, sourceAnimation: "strike", newAnimation: "attack", maps });
  const after = parseDocument(target.path, result.text);
  assert.deepEqual(validateDocument(after), []);
  assert.deepEqual(after.data.animations, { attack: {
    bones: { wing: { rotate: sourceData.animations.strike.bones.arm.rotate } },
    slots: { claw: { attachment: [{ name: "grip" }, { time: 0.5, name: "release" }] } },
    ik: { targetAim: sourceData.animations.strike.ik.aim },
    attachments: { costume: { claw: { net: sourceData.animations.strike.attachments.action.hand.mesh } } },
    events: [{ time: 0.25, name: "impact" }],
    drawOrder: [{ time: 0.75, offsets: [{ slot: "claw", offset: 1 }, { slot: "torso", offset: -1 }] }],
  } });
  assert.equal(result.summary.timelines, 6);
  assert.equal(result.summary.mapped.attachment, 3);
  assert.deepEqual(target.data.animations, {});
});

test("retarget reports all missing mappings and rejects incompatible draw order and deform geometry", () => {
  const source = doc("/tmp/retarget-source.json", sourceData);
  const target = doc("/tmp/retarget-target.json", targetData);
  const operation = { kind: "retarget_animation", sourcePath: source.path, sourceHash: source.hash,
    sourceAnimation: "strike", newAnimation: "attack" };
  assert.throws(() => retargetAnimationText(target, source, operation), (error) =>
    error.code === "UNMAPPED_REFERENCES" && error.details.issues.some((issue) => issue.kind === "bone")
      && error.details.issues.some((issue) => issue.kind === "attachment")
      && error.details.issues.some((issue) => issue.kind === "event"));
  const wrongOrder = structuredClone(targetData);
  wrongOrder.slots.reverse();
  assert.throws(() => retargetAnimationText(doc("/tmp/target-order.json", wrongOrder), source,
    { ...operation, maps }), (error) => error.code === "UNMAPPED_REFERENCES"
      && error.details.issues.some((issue) => issue.kind === "drawOrder"));
  const wrongMesh = structuredClone(targetData);
  wrongMesh.skins[1].attachments.claw.net.vertices[0] = 2;
  assert.throws(() => retargetAnimationText(doc("/tmp/target-mesh.json", wrongMesh), source,
    { ...operation, maps }), (error) => error.code === "UNMAPPED_REFERENCES"
      && error.details.issues.some((issue) => issue.kind === "deform"));
  assert.throws(() => retargetAnimationText(target, source,
    { ...operation, sourceHash: "0".repeat(64), maps }), { code: "SOURCE_CHANGED" });
  assert.throws(() => retargetAnimationText(target, source,
    { ...operation, maps: { ...maps, bones: { ...maps.bones, armm: "wing" } } }),
  (error) => error.code === "UNMAPPED_REFERENCES"
    && error.details.issues.some((issue) => issue.path === "/maps/bones/armm"));
  const wrongEventDefaults = structuredClone(targetData);
  wrongEventDefaults.events.impact.int = 9;
  assert.throws(() => retargetAnimationText(doc("/tmp/target-event.json", wrongEventDefaults), source,
    { ...operation, maps }), (error) => error.code === "UNMAPPED_REFERENCES"
      && error.details.issues.some((issue) => issue.reason.includes("event defaults differ")));
  const equivalentEventDefaults = structuredClone(targetData);
  equivalentEventDefaults.events.impact = { int: 0, float: 0, volume: 1, balance: 0 };
  assert.ok(retargetAnimationText(doc("/tmp/target-event-defaults.json", equivalentEventDefaults), source,
    { ...operation, maps }).summary.timelines > 0);
});

test("retarget stages the target only and checks both source and target before commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-retarget-"));
  const sourcePath = join(directory, "source.json");
  const targetPath = join(directory, "target.json");
  const sourceText = `${JSON.stringify(sourceData, null, 2)}\n`;
  const targetText = `${JSON.stringify(targetData, null, 2)}\n`;
  await writeFile(sourcePath, sourceText);
  await writeFile(targetPath, targetText);
  try {
    const source = await readDocument(sourcePath);
    const edits = new EditStore();
    const operation = { kind: "retarget_animation", sourcePath, sourceHash: source.hash,
      sourceAnimation: "strike", newAnimation: "attack", maps };
    const stage = await edits.preview(targetPath, [operation]);
    assert.deepEqual(stage.diagnostics, []);
    assert.equal(stage.summaries[0].kind, "retarget_animation");
    assert.equal(await readFile(targetPath, "utf8"), targetText);
    await writeFile(sourcePath, `${sourceText} `);
    await assert.rejects(edits.commit(stage.editId), { code: "SOURCE_CHANGED" });
    assert.equal(await readFile(targetPath, "utf8"), targetText);
    await writeFile(sourcePath, sourceText);
    const committed = await edits.commit(stage.editId);
    assert.ok(committed.manifestPath);
    assert.equal(await readFile(sourcePath, "utf8"), sourceText);
    assert.deepEqual(validateDocument(await readDocument(targetPath)), []);
    assert.ok((await readDocument(targetPath)).data.animations.attack);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
