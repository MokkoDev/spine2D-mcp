import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

for (const version of ["4.2", "4.3"]) {
  test(`Spine ${version} stages constraint, event, and animation removal after exact reference cleanup`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spine2d-remove-definition-"));
    const path = join(directory, "rig.json");
    try {
      await createSkeletonData(path, version);
      const edits = new EditStore();
      const setup = await edits.preview(path, [
        { kind: "upsert_bone", name: "arm", parent: "root" },
        { kind: "upsert_bone", name: "goal", parent: "root" },
        { kind: "upsert_constraint", constraintType: "ik", name: "aim", edition: "professional",
          bones: ["arm"], target: "goal" },
        { kind: "upsert_constraint", constraintType: "ik", name: "keep", edition: "professional",
          bones: ["arm"], target: "goal" },
        { kind: "upsert_skin", name: "alternate", values: version === "4.3" ? { constraints: ["aim"] } : { ik: ["aim"] } },
        { kind: "upsert_event", name: "beat" },
        { kind: "upsert_event", name: "keepEvent" },
        { kind: "upsert_animation", name: "wave" },
        { kind: "upsert_animation", name: "idle" },
        { kind: "set_keyframe", animation: "wave", selector: { section: "ik", target: "aim" },
          time: 0, values: { mix: 0.5 } },
        { kind: "set_keyframe", animation: "wave", selector: { section: "events" },
          time: 0.25, values: { name: "beat" } },
      ]);
      await edits.commit(setup.editId);
      const source = await readFile(path, "utf8");
      await assert.rejects(edits.preview(path, [{ kind: "remove_constraint", constraintType: "ik", name: "aim" }]),
        (error) => {
          assert.equal(error.code, "CONSTRAINT_IN_USE");
          assert.deepEqual(error.details.references, version === "4.3"
            ? ["/skins/1/constraints/0", "/animations/wave/ik/aim"]
            : ["/skins/1/ik/0", "/animations/wave/ik/aim"]);
          return true;
        });
      await assert.rejects(edits.preview(path, [{ kind: "remove_event", name: "beat" }]),
        (error) => {
          assert.equal(error.code, "EVENT_IN_USE");
          assert.deepEqual(error.details.references, ["/animations/wave/events/0/name"]);
          return true;
        });
      await assert.rejects(edits.preview(path, [
        { kind: "remove_animation", name: "wave" },
        { kind: "remove_constraint", constraintType: "ik", name: "aim" },
      ]), { code: "CONSTRAINT_IN_USE" });
      assert.equal(await readFile(path, "utf8"), source);
      const cleanup = await edits.preview(path, [
        { kind: "remove_animation", name: "wave" },
        { kind: "upsert_skin", name: "alternate", values: version === "4.3" ? { constraints: [] } : { ik: [] } },
        { kind: "remove_constraint", constraintType: "ik", name: "aim" },
        { kind: "remove_event", name: "beat" },
      ]);
      assert.deepEqual(cleanup.diagnostics, []);
      assert.equal(cleanup.summaries[0].timelineCount, 2);
      assert.equal(cleanup.summaries[0].keyCount, 2);
      assert.equal(await readFile(path, "utf8"), source);
      await edits.commit(cleanup.editId);
      const after = await readDocument(path);
      assert.deepEqual(validateDocument(after), []);
      assert.deepEqual(Object.keys(after.data.animations), ["idle"]);
      assert.deepEqual(Object.keys(after.data.events), ["keepEvent"]);
      const constraints = version === "4.3" ? after.data.constraints : after.data.ik;
      assert.deepEqual(constraints.map((constraint) => constraint.name), ["keep"]);
      if (version === "4.2") assert.equal(constraints[0].order, 1);
      await assert.rejects(edits.preview(path, [{ kind: "remove_animation", name: "missing" }]), { code: "ANIMATION_NOT_FOUND" });
      await assert.rejects(edits.preview(path, [{ kind: "remove_event", name: "missing" }]), { code: "MISSING_EVENT" });
      await assert.rejects(edits.preview(path, [{ kind: "remove_constraint", constraintType: "ik", name: "missing" }]), { code: "MISSING_CONSTRAINT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
