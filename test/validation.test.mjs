import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { referenceGraph } from "../dist/spine/inspect.js";
import { validateDocument } from "../dist/spine/validate.js";

test("validation reports skin and linked mesh references with escaped JSON pointers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-refs-"));
  const path = join(directory, "refs.json");
  const data = {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }],
    slots: [{ name: "s/lot", bone: "root" }],
    constraints: [{ type: "ik", name: "keep", bones: ["root"], target: "root" }],
    skins: [
      { name: "default", attachments: { "s/lot": { region: {} } } },
      { name: "variant", bones: ["missing-bone"], constraints: ["missing-constraint", "keep"], attachments: { "s/lot": { linked: { type: "linkedmesh", source: "missing-mesh" } } } },
    ],
  };
  await writeFile(path, JSON.stringify(data));
  try {
    const document = await readDocument(path);
    const diagnostics = validateDocument(document);
    assert.ok(diagnostics.some((item) => item.code === "MISSING_BONE" && item.path === "/skins/1/bones/0"));
    assert.ok(diagnostics.some((item) => item.code === "MISSING_CONSTRAINT" && item.path === "/skins/1/constraints/0"));
    assert.ok(diagnostics.some((item) => item.code === "MISSING_LINKED_MESH_PARENT" && item.path === "/skins/1/attachments/s~1lot/linked/source"));
    assert.ok(!diagnostics.some((item) => item.path === "/skins/1/constraints/1"));
    const refs = referenceGraph(document, "constraint", "keep");
    assert.ok(refs.references.some((item) => item.path === "/skins/1/constraints/1"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation checks timeline-specific Bézier channel counts and rejects curves on discrete keys", () => {
  const data = {
    skeleton: { spine: "4.3.75" },
    bones: [{ name: "root" }],
    slots: [{ name: "body", bone: "root" }],
    animations: { move: {
      bones: { root: { translate: [{ x: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, x: 1 }] } },
      slots: { body: { attachment: [{ name: null, curve: "stepped" }] } },
    } },
  };
  const diagnostics = validateDocument(parseDocument("/tmp/bad-curves.json", JSON.stringify(data)));
  assert.ok(diagnostics.some((item) => item.code === "INVALID_CURVE_CHANNELS" && item.path === "/animations/move/bones/root/translate/0/curve"));
  assert.ok(diagnostics.some((item) => item.code === "INVALID_CURVE" && item.path === "/animations/move/slots/body/attachment/0/curve"));
});

test("physics timelines use nested constraint and channel paths", () => {
  const data = {
    skeleton: { spine: "4.3.75" },
    bones: [{ name: "root" }],
    constraints: [{ type: "physics", name: "cloth", bone: "root" }],
    animations: { sway: { physics: { cloth: { wind: [
      { value: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, value: 1 },
    ] } } } },
  };
  const diagnostics = validateDocument(parseDocument("/tmp/physics.json", JSON.stringify(data)));
  assert.deepEqual(diagnostics, []);
});

test("deform keys accept odd coordinate slices but reject values beyond their mesh", () => {
  const data = {
    skeleton: { spine: "4.3.75" }, bones: [{ name: "root" }],
    slots: [{ name: "body", bone: "root", attachment: "mesh" }],
    skins: [{ name: "default", attachments: { body: { mesh: {
      type: "mesh", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 1, 0, 0, 1],
    } } } }],
    animations: { flex: { attachments: { default: { body: { mesh: { deform: [
      { offset: 1, vertices: [0.1, 0.2, 0.3, 0.4, 0.5] },
      { time: 1, offset: 5, vertices: [0.1, 0.2] },
    ] } } } } } },
  };
  const diagnostics = validateDocument(parseDocument("/tmp/deform.json", JSON.stringify(data)));
  assert.ok(!diagnostics.some((item) => item.path.includes("/deform/0")));
  assert.ok(diagnostics.some((item) => item.code === "DEFORM_VERTEX_RANGE" && item.path.endsWith("/deform/1/vertices")));
});
