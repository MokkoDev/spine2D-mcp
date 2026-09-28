import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skeletonText } from "../dist/spine/create.js";
import { deleteExportProfile, getExportProfile, listExportProfiles, runExportProfile, saveExportProfile } from "../dist/spine/profile.js";

test("profiles snapshot settings, check runtime compatibility, and run an atomic export manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-profile-"));
  const previousCli = process.env.SPINE_CLI_PATH;
  try {
    const input = join(directory, "rig.json");
    const settings = { data: join(directory, "data.json"), media: join(directory, "media.json"),
      atlas: join(directory, "atlas.json") };
    const imagesDir = join(directory, "images");
    const outputDir = join(directory, "out");
    await mkdir(imagesDir);
    await writeFile(join(imagesDir, "shape.png"), Buffer.from("image"));
    await writeFile(input, skeletonText("4.3"));
    await writeFile(settings.data, JSON.stringify({ class: "export-json", nonessential: true }));
    await writeFile(settings.media, JSON.stringify({ class: "export-png", animation: "wave" }));
    await writeFile(settings.atlas, JSON.stringify({ class: "texturepacker", maxWidth: 1024 }));
    await assert.rejects(saveExportProfile(directory, "bad", "4.3", "4.2", settings),
      { code: "PROFILE_VERSION_MISMATCH" });
    const saved = await saveExportProfile(directory, "runtime", "4.3", "4.3.1", settings);
    assert.deepEqual(saved.steps, ["data", "media", "atlas"]);
    await assert.rejects(saveExportProfile(directory, "runtime", "4.3", "4.3", settings), { code: "PROFILE_EXISTS" });
    await writeFile(settings.data, JSON.stringify({ class: "export-json", nonessential: false }));
    assert.equal((await getExportProfile(directory, "runtime")).settings.data.nonessential, true);
    assert.equal((await listExportProfiles(directory)).profiles.length, 1);

    const mock = join(directory, "Spine.sh");
    await writeFile(mock, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const input = args[args.indexOf("--input") + 1];
const output = args[args.indexOf("--output") + 1];
if (args[0] !== "--update" || args[1] !== "4.3") process.exit(8);
if (args.includes("--export")) {
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--export") + 1], "utf8"));
  if (process.env.MOCK_FAIL_STEP === "media" && settings.class === "export-png") process.exit(9);
  fs.mkdirSync(output, { recursive: true });
  if (settings.class === "export-json") fs.copyFileSync(input, path.join(output, "rig.json"));
  else fs.writeFileSync(path.join(output, "frame.png"), "fake png");
} else if (args.includes("--pack")) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "runtime.atlas"), "atlas");
  fs.writeFileSync(path.join(output, "runtime.png"), "fake png");
} else process.exit(7);
`);
    await chmod(mock, 0o755);
    process.env.SPINE_CLI_PATH = mock;
    const run = await runExportProfile(directory, "runtime", input, outputDir, imagesDir);
    assert.equal(run.outputCount, 4);
    assert.deepEqual(run.steps, ["data", "media", "atlas"]);
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
    assert.deepEqual(manifest.outputs.map((entry) => entry.path), run.outputPaths);
    assert.equal(manifest.profileHash, run.profileHash);
    assert.equal(manifest.editorVersion, "4.3");
    for (const output of manifest.outputs) assert.match(output.sha256, /^[0-9a-f]{64}$/);

    process.env.MOCK_FAIL_STEP = "media";
    const before = await readdir(outputDir);
    await assert.rejects(runExportProfile(directory, "runtime", input, outputDir, imagesDir),
      { code: "SPINE_CLI_FAILED" });
    assert.deepEqual(await readdir(outputDir), before);
    delete process.env.MOCK_FAIL_STEP;

    const tampered = JSON.parse(await readFile(saved.profilePath, "utf8"));
    tampered.settings.media.animation = "changed";
    await writeFile(saved.profilePath, JSON.stringify(tampered));
    await assert.rejects(getExportProfile(directory, "runtime"), { code: "PROFILE_SETTINGS_CHANGED" });
    await writeFile(saved.profilePath, JSON.stringify({ ...tampered, settings: {
      ...tampered.settings, media: { class: "export-png", animation: "wave" },
    } }));
    await deleteExportProfile(directory, "runtime");
    assert.deepEqual((await listExportProfiles(directory)).profiles, []);
  } finally {
    if (previousCli === undefined) delete process.env.SPINE_CLI_PATH;
    else process.env.SPINE_CLI_PATH = previousCli;
    delete process.env.MOCK_FAIL_STEP;
    await rm(directory, { recursive: true, force: true });
  }
});

test("profiles reject unsafe JSON export settings and unmatched input versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine2d-profile-errors-"));
  try {
    const settingsPath = join(directory, "data.json");
    await writeFile(settingsPath, JSON.stringify({ class: "export-json", nonessential: false }));
    await assert.rejects(saveExportProfile(directory, "bad", "4.3", "4.3", { data: settingsPath }),
      { code: "UNSAFE_EXPORT_SETTINGS" });
    await writeFile(settingsPath, JSON.stringify({ class: "export-json", nonessential: true, version: "4.2" }));
    await assert.rejects(saveExportProfile(directory, "bad", "4.3", "4.3", { data: settingsPath }),
      { code: "PROFILE_VERSION_MISMATCH" });
    await writeFile(settingsPath, JSON.stringify({ class: "export-json", nonessential: true }));
    await saveExportProfile(directory, "good", "4.3", "4.3", { data: settingsPath });
    const input = join(directory, "old.json");
    await writeFile(input, skeletonText("4.2"));
    await assert.rejects(runExportProfile(directory, "good", input, join(directory, "out")),
      { code: "PROFILE_VERSION_MISMATCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
