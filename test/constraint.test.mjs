import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { referenceGraph } from "../dist/spine/inspect.js";
import { upsertConstraintText } from "../dist/spine/rig.js";
import { validateDocument } from "../dist/spine/validate.js";

function fixture(version) {
  return { skeleton: { spine: version },
    bones: [{ name: "root" }, { name: "arm", parent: "root", length: 30 }, { name: "goal", parent: "root" }],
    slots: [{ name: "route-slot", bone: "root" }],
    skins: [{ name: "default", attachments: { "route-slot": { route: {
      type: "path", closed: false, constantSpeed: true, vertexCount: 4,
      vertices: [0, 0, 10, 0, 20, 0, 30, 0], lengths: [10],
    } } } }], animations: {} };
}

function document(version, data = fixture(version)) {
  return parseDocument(`/tmp/constraint-${version}.json`, `${JSON.stringify(data, null, 2)}\n`);
}

function apply(current, constraintType, name, roles, values = {}) {
  const operation = { kind: "upsert_constraint", constraintType, name, edition: "professional", ...roles, values };
  return parseDocument(current.path, upsertConstraintText(current, operation).text);
}

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} creates and updates IK, transform, path, and physics constraints in its own layout`, () => {
    let current = document(version);
    current = apply(current, "ik", "aim", { bones: ["arm"], target: "goal" }, { mix: 0.5 });
    current = apply(current, "transform", "follow", { bones: ["arm"], target: "goal" },
      version === "4.3" ? { properties: ["rotate", "x"], mixRotate: 0.75 } : { mixRotate: 0.75 });
    current = apply(current, "path", "route", { bones: ["arm"], target: "route-slot" }, { rotateMode: "chain" });
    current = apply(current, "physics", "sway", { bone: "arm" }, { rotate: 1, limit: 300, fps: 30 });
    assert.deepEqual(validateDocument(current), []);
    if (version === "4.3") {
      assert.deepEqual(current.data.constraints.map((item) => item.type), ["ik", "transform", "path", "physics"]);
      assert.equal(current.data.constraints[1].source, "goal");
      assert.equal(current.data.constraints[2].slot, "route-slot");
      assert.deepEqual(current.data.constraints[1].properties.rotate, { to: { rotate: { max: 100 } } });
      assert.ok(referenceGraph(current, "slot", "route-slot").references.some((item) => item.relation === "constraint target slot"));
      assert.ok(referenceGraph(current, "bone", "arm").references.some((item) => item.path.endsWith("/bone")));
      const invalid = structuredClone(current.data);
      invalid.constraints[3].bone = "missing";
      assert.ok(validateDocument(document(version, invalid)).some((item) => item.code === "MISSING_BONE" && item.path.endsWith("/bone")));
    } else {
      assert.deepEqual([current.data.ik[0].order, current.data.transform[0].order,
        current.data.path[0].order, current.data.physics[0].order], [0, 1, 2, 3]);
      assert.equal(current.data.transform[0].target, "goal");
      assert.equal(current.data.path[0].target, "route-slot");
    }
    const edited = apply(current, "ik", "aim", {}, { mix: 0.8 });
    const constraint = version === "4.3" ? edited.data.constraints[0] : edited.data.ik[0];
    assert.equal(constraint.mix, 0.8);
    assert.deepEqual(constraint.bones, ["arm"]);
  });
}

test("constraint creation rejects unsupported edition, broken references, and invalid values", () => {
  const source = document("4.3");
  const base = { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional",
    bones: ["arm"], target: "goal" };
  assert.throws(() => upsertConstraintText(source, { ...base, edition: "essential" }), { code: "UNSUPPORTED_EDITION" });
  assert.throws(() => upsertConstraintText(source, { ...base, target: "missing" }), { code: "MISSING_BONE" });
  assert.throws(() => upsertConstraintText(source, { ...base, bones: ["arm", "arm"] }), { code: "INVALID_CONSTRAINT_BONES" });
  assert.throws(() => upsertConstraintText(source, { ...base, values: { mix: 2 } }), { code: "INVALID_CONSTRAINT_VALUE" });
  assert.throws(() => upsertConstraintText(source, { ...base, values: { unsupported: 1 } }), { code: "INVALID_CONSTRAINT_FIELD" });
  assert.throws(() => upsertConstraintText(source, { ...base, constraintType: "transform" }), { code: "MISSING_TRANSFORM_PROPERTIES" });
  const withoutPath = structuredClone(source.data);
  withoutPath.skins[0].attachments = {};
  assert.throws(() => upsertConstraintText(document("4.3", withoutPath), { ...base,
    constraintType: "path", target: "route-slot" }), { code: "MISSING_PATH_ATTACHMENT" });
});

test("constraint batch stays atomic when a later constraint is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-constraint-"));
  const path = join(directory, "rig.json");
  const original = `${JSON.stringify(fixture("4.3"), null, 2)}\n`;
  await writeFile(path, original);
  try {
    const edits = new EditStore();
    await assert.rejects(edits.preview(path, [
      { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional",
        bones: ["arm"], target: "goal" },
      { kind: "upsert_constraint", constraintType: "physics", name: "sway", edition: "professional",
        bone: "missing" },
    ]), { code: "MISSING_BONE" });
    assert.equal(await readFile(path, "utf8"), original);
    const stage = await edits.preview(path, [{ kind: "upsert_constraint", constraintType: "ik", name: "aim",
      edition: "professional", bones: ["arm"], target: "goal" }]);
    assert.equal(stage.summaries[0].action, "created");
    await edits.commit(stage.editId);
    assert.equal((await readDocument(path)).data.constraints[0].name, "aim");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
