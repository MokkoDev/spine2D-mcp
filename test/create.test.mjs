import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProject, createSkeletonData } from "../dist/spine/create.js";
import { readDocument } from "../dist/spine/document.js";
import { validateDocument } from "../dist/spine/validate.js";

test("a new skeleton has valid JSON and cannot overwrite existing data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-create-"));
  const path = join(directory, "hero.json");
  try {
    const created = await createSkeletonData(path, "4.3", { rootBoneName: "pelvis", fps: 24, imagesPath: "./art/" });
    assert.equal(created.dataPath, path);
    const document = await readDocument(path);
    assert.deepEqual(validateDocument(document), []);
    assert.equal(document.data.bones[0].name, "pelvis");
    assert.equal(document.data.skeleton.fps, 24);
    assert.equal(document.data.skeleton.images, "./art/");
    const original = await readFile(path, "utf8");
    await assert.rejects(createSkeletonData(path, "4.3"), { code: "OUTPUT_EXISTS" });
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual((await readdir(directory)).sort(), ["hero.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project creation retains new JSON, imports a new project, and rejects occupied paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-project-"));
  const cli = join(directory, "fake-spine");
  await writeFile(cli, `#!/usr/bin/env node\nconst fs=require("node:fs");\nconst args=process.argv.slice(2);\nconst input=args[args.indexOf("--input")+1];\nconst output=args[args.indexOf("--output")+1];\nif(args[args.indexOf("--import")+1]!=="hero") process.exit(2);\nconst data=JSON.parse(fs.readFileSync(input,"utf8"));\nif(data.bones[0].name!=="root") process.exit(3);\nfs.writeFileSync(output,"mock project");\n`);
  await chmod(cli, 0o755);
  const prior = process.env.SPINE_CLI_PATH;
  process.env.SPINE_CLI_PATH = cli;
  try {
    const project = join(directory, "hero.spine");
    const created = await createProject({ outputProjectPath: project, editorVersion: "4.3" });
    assert.equal(created.outputProjectPath, project);
    assert.equal(created.dataPath, join(directory, "hero.json"));
    assert.equal(await readFile(project, "utf8"), "mock project");
    assert.deepEqual(validateDocument(await readDocument(created.dataPath)), []);
    await assert.rejects(createProject({ outputProjectPath: project, editorVersion: "4.3" }), { code: "OUTPUT_EXISTS" });
    assert.deepEqual((await readdir(directory)).sort(), ["fake-spine", "hero.json", "hero.spine"]);
  } finally {
    if (prior === undefined) delete process.env.SPINE_CLI_PATH;
    else process.env.SPINE_CLI_PATH = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
