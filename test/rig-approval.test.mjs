import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { parseDocument } from "../dist/spine/document.js";
import { rigDiff, rigSignature } from "../dist/spine/rig-approval.js";

test("Spine 4.3 constraint removal changes the rig signature and requires review to commit", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-rig-constraint-review-"));
  const path = join(directory, "rig.json");
  const data = {
    skeleton: { spine: "4.3", images: "./images/" },
    bones: [{ name: "root" }, { name: "arm", parent: "root" }],
    slots: [
      { name: "body", bone: "root", attachment: "body" },
      { name: "head", bone: "arm", attachment: "head" },
    ],
    skins: [{ name: "default", attachments: {
      body: { body: { type: "region", width: 24, height: 40 } },
      head: { head: { type: "region", width: 24, height: 24 } },
    } }],
    constraints: [{ type: "ik", name: "aim", bones: ["arm"], target: "root" }],
    animations: {},
  };
  const original = JSON.stringify(data);
  const withoutConstraint = structuredClone(data);
  withoutConstraint.constraints = [];
  const before = parseDocument(path, original);
  const after = parseDocument(path, JSON.stringify(withoutConstraint));
  assert.notEqual(rigSignature(before), rigSignature(after));
  const diff = rigDiff(before, after);
  assert.equal(diff.changed, true);
  assert.ok(diff.changes.some((change) => change.path === "/constraints"
    && change.before === "<array: 1 item(s)>" && change.after === "<missing>"));

  const client = new Client({ name: "rig-constraint-review-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: new URL("../startup.sh", import.meta.url).pathname });
  try {
    await writeFile(path, original);
    await client.connect(transport);
    const preview = await client.callTool({ name: "spine_remove_constraint", arguments: {
      path, constraintType: "ik", name: "aim",
    } });
    assert.equal(preview.isError, undefined, JSON.stringify(preview.structuredContent));
    const commit = await client.callTool({ name: "spine_commit_edit", arguments: {
      editId: preview.structuredContent.editId,
    } });
    assert.equal(commit.isError, true);
    assert.equal(commit.structuredContent.code, "RIG_REVIEW_REQUIRED");
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
