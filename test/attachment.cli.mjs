import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { exportData, importData } from "../dist/spine/cli.js";
import { skeletonText } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { validateDocument } from "../dist/spine/validate.js";

test("licensed Spine 4.2 and 4.3 import and reexport every authored attachment type", { timeout: 240_000 }, async () => {
  assert.ok(process.env.SPINE_CLI_PATH, "Set SPINE_CLI_PATH to run editor mesh integration tests.");
  const directory = await mkdtemp(join(tmpdir(), "spine2d-mesh-cli-"));
  try {
    await mkdir(join(directory, "images"));
    const png = new PNG({ width: 32, height: 32 });
    for (let index = 0; index < png.data.length; index += 4) png.data.set([255, 64, 96, 255], index);
    await writeFile(join(directory, "images", "shirt.png"), PNG.sync.write(png));
    for (const version of ["4.2", "4.3"]) {
      const path = join(directory, `mesh-${version}.json`);
      await writeFile(path, skeletonText(version));
      const edits = new EditStore();
      const stage = await edits.preview(path, [
        { kind: "upsert_bone", name: "arm", parent: "root", values: { x: 8 } },
        { kind: "upsert_slot", name: "body", bone: "root", values: { attachment: "shirt" } },
        { kind: "upsert_slot", name: "helper", bone: "root" },
        { kind: "upsert_skin", name: "extras" },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt", attachmentType: "mesh",
          values: { path: "shirt", uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            vertices: [-16, -16, 16, -16, 16, 16, -16, 16], triangles: [0, 1, 2, 2, 3, 0], hull: 4,
            width: 32, height: 32 } },
        { kind: "set_mesh_weights", skin: "default", slot: "body", name: "shirt",
          influences: [[-16, -16], [16, -16], [16, 16], [-16, 16]].map(([x, y]) => [
            { bone: "root", x, y, weight: 0.5 }, { bone: "arm", x: x - 8, y, weight: 0.5 }]) },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt-copy", attachmentType: "linkedmesh",
          values: { parent: "shirt", path: "shirt", deform: false, width: 32, height: 32 } },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "target", attachmentType: "point",
          values: { x: 5, y: 6, rotation: 30 } },
        { kind: "upsert_attachment", skin: "default", slot: "helper", name: "marker", attachmentType: "point",
          values: { x: 1 } },
        { kind: "upsert_attachment", skin: "extras", slot: "helper", name: "variant", attachmentType: "point",
          values: { y: 2 } },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "shirt-region", attachmentType: "region",
          values: { path: "shirt", width: 32, height: 32 } },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "route", attachmentType: "path",
          values: { vertexCount: 6, vertices: [0, 0, 0, 0, 8, 0, 16, 0, 24, 0, 24, 0], lengths: [8, 24] } },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "hitbox", attachmentType: "boundingbox",
          values: { vertexCount: 3, vertices: [-5, -5, 5, -5, 0, 5] } },
        { kind: "upsert_attachment", skin: "default", slot: "body", name: "mask", attachmentType: "clipping",
          values: { vertexCount: 3, vertices: [-5, -5, 5, -5, 0, 5], end: "body" } },
      ]);
      assert.deepEqual(stage.diagnostics, []);
      await edits.commit(stage.editId);
      const project = join(directory, `mesh-${version}.spine`);
      try { await importData(path, project, `mesh-${version}`, version, 120_000); }
      catch (error) {
        console.error(`Spine ${version} mesh import failed:`, error.details?.stdout?.slice(-2500), error.details?.stderr?.slice(-2500));
        throw error;
      }
      assert.ok((await readFile(project)).length > 0);
      const settings = join(directory, `export-${version}.json`);
      await writeFile(settings, JSON.stringify({ class: "export-json", extension: ".json", format: "JSON",
        prettyPrint: true, nonessential: true, cleanUp: false, packAtlas: null,
        packSource: "attachments", packTarget: "single", warnings: true, version: null,
        all: true, output: "", id: -1, input: "", open: false }));
      const exported = await exportData(project, settings, directory, version, 120_000);
      const roundTrip = await readDocument(exported.files[0]);
      assert.deepEqual(validateDocument(roundTrip), []);
      const attachments = roundTrip.data.skins.find((skin) => skin.name === "default").attachments.body;
      assert.equal(attachments.shirt.type, "mesh");
      assert.equal(attachments["shirt-copy"].type, "linkedmesh");
      assert.equal(attachments.target.type, "point");
      assert.equal(attachments["shirt-region"].type ?? "region", "region");
      assert.equal(attachments.route.type, "path");
      assert.equal(attachments.hitbox.type, "boundingbox");
      assert.equal(attachments.mask.type, "clipping");
      assert.ok(attachments.shirt.vertices.length > attachments.shirt.uvs.length);
      const removed = await edits.preview(path, [
        { kind: "remove_attachment", skin: "default", slot: "helper", name: "marker" },
        { kind: "remove_skin", name: "extras" },
      ]);
      await edits.commit(removed.editId);
      assert.equal((await readDocument(path)).data.skins[0].attachments.helper, undefined);
      assert.deepEqual((await readDocument(path)).data.skins.map((skin) => skin.name), ["default"]);
      const afterRemoval = join(directory, `mesh-removed-${version}.spine`);
      await importData(path, afterRemoval, `mesh-removed-${version}`, version, 120_000);
      assert.ok((await readFile(afterRemoval)).length > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
