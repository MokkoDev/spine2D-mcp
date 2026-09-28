import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseDocument, readDocument } from "../dist/spine/document.js";
import { EditStore } from "../dist/spine/edit.js";
import { inspectAnimation, referenceGraph } from "../dist/spine/inspect.js";
import { captureBonePose } from "../dist/spine/pose.js";
import { validateDocument } from "../dist/spine/validate.js";

// Official exported data is fetched only for this explicit regression command.
// Pinning the repository commit and checksums makes the fixture reproducible.
const repository = "https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes";
const fixtures = [
  { version: "4.2", commit: "e7dc1435fa4a0083ab431f1b28e083c14a1f5c68", file: "spineboy-ess.json", sha256: "e2710415faa748ae8a183283453aa40164a8f92301440a27d2670d9f0236ef0e", animation: "walk" },
  { version: "4.2", commit: "e7dc1435fa4a0083ab431f1b28e083c14a1f5c68", file: "spineboy-pro.json", sha256: "488face411ddfad77ee3239b29431deb574d73f4feca7eca541452ad24bb6bfc", animation: "hoverboard" },
  { version: "4.3", commit: "7ce5d0daac13268fa3ed68eb174c2822ef2692c9", file: "spineboy-ess.json", sha256: "da21eb38c5c1bb5fa5d8569d6ffeec9e4f1976ee4c260bcc709c6f32ade1c9b9", animation: "walk" },
  { version: "4.3", commit: "7ce5d0daac13268fa3ed68eb174c2822ef2692c9", file: "spineboy-pro.json", sha256: "24ccffc13e334e721dfd427ee2b8aea05c25b59167b5fb0bb0f9685e11d2a7d3", animation: "hoverboard" },
];

for (const fixture of fixtures) {
  test(`Spine ${fixture.version} official example ${fixture.file} validates and retimes`, { timeout: 30_000 }, async () => {
    const response = await fetch(`${repository}/${fixture.commit}/examples/spineboy/export/${fixture.file}`);
    assert.equal(response.ok, true, `Failed to fetch ${fixture.file}: HTTP ${response.status}`);
    const original = await response.text();
    assert.equal(createHash("sha256").update(original).digest("hex"), fixture.sha256);
    const directory = await mkdtemp(join(tmpdir(), "spine2d-example-"));
    const path = join(directory, fixture.file);
    await writeFile(path, original);
    try {
      const document = await readDocument(path);
      assert.ok(document.version.startsWith(fixture.version));
      assert.deepEqual(validateDocument(document), []);
      const before = inspectAnimation(document, fixture.animation);
      const edits = new EditStore();
      const preview = await edits.preview(path, [{ kind: "retime_animation", animation: fixture.animation, scale: 1.5 }]);
      assert.equal(preview.diagnostics.length, 0);
      assert.ok(preview.changeCount > 0);
      assert.equal(await readFile(path, "utf8"), original);
      const committed = await edits.commit(preview.editId);
      const after = await readDocument(path);
      assert.deepEqual(validateDocument(after), []);
      assert.ok(Math.abs(inspectAnimation(after, fixture.animation).duration - before.duration * 1.5) < 0.000001);
      assert.equal(await readFile(committed.backupPath, "utf8"), original);
      const bulk = await edits.preview(path, [{ kind: "bulk_keys", animation: fixture.animation, action: "move", delta: 0.1 }]);
      assert.equal(bulk.summaries[0].kind, "bulk_keys");
      assert.ok(bulk.summaries[0].keysSelected > 0);
      assert.deepEqual(bulk.diagnostics, []);
      await edits.commit(bulk.editId);
      const shifted = await readDocument(path);
      assert.deepEqual(validateDocument(shifted), []);
      assert.ok(Math.abs(inspectAnimation(shifted, fixture.animation).duration - before.duration * 1.5 - 0.1) < 0.000001);
      const loop = await edits.preview(path, [{ kind: "make_loop", animation: "idle" }]);
      assert.equal(loop.summaries[0].kind, "make_loop");
      assert.equal(loop.summaries[0].seamIssuesAfter, 0);
      await edits.commit(loop.editId);
      assert.deepEqual(validateDocument(await readDocument(path)), []);

      const animations = (await readDocument(path)).data.animations;
      const curveCandidate = Object.entries(animations).flatMap(([animation, value]) =>
        Object.entries(value.bones ?? {}).flatMap(([bone, timelines]) =>
          ["rotate", "translate", "scale", "shear"].flatMap((timelineType) => {
            const keys = timelines[timelineType];
            return Array.isArray(keys) && keys.length > 1 && (keys[1].time ?? 0) > (keys[0].time ?? 0)
              ? [{ animation, bone, timelineType, time: keys[0].time ?? 0 }]
              : [];
          }))).at(0);
      assert.ok(curveCandidate, "Expected an editable bone transform segment in the official example.");
      const curve = await edits.preview(path, [{ kind: "set_curve", ...curveCandidate,
        mode: "bezier", controls: [0.25, 0, 0.75, 1] }]);
      assert.equal(curve.summaries[0].kind, "set_curve");
      await edits.commit(curve.editId);
      const curvedDocument = await readDocument(path);
      assert.deepEqual(validateDocument(curvedDocument), []);
      const curveKeys = curvedDocument.data.animations[curveCandidate.animation]
        .bones[curveCandidate.bone][curveCandidate.timelineType];
      const midpoint = ((curveKeys[0].time ?? 0) + (curveKeys[1].time ?? 0)) / 2;
      const sampledPose = captureBonePose(curvedDocument, curveCandidate.animation,
        midpoint, "official example midpoint", [curveCandidate.bone]);
      assert.ok(sampledPose.entries.some((entry) => entry.timelineType === curveCandidate.timelineType));
      assert.ok(sampledPose.entries.every((entry) => Object.values(entry.values).every(Number.isFinite)));

      const keyed = await readDocument(path);
      const clip = keyed.data.animations[fixture.animation];
      const freeBone = keyed.data.bones.find((bone) => !Object.hasOwn(clip.bones?.[bone.name] ?? {}, "translate"))?.name;
      assert.ok(freeBone, "Expected a bone without a translate timeline in the official example.");
      const end = inspectAnimation(keyed, fixture.animation).duration;
      const operations = [{ kind: "set_keyframe", animation: fixture.animation,
        selector: { section: "bones", target: freeBone, timelineType: "translate" },
        time: end + 0.2, values: { x: 1, y: -2 } }];
      const deformSkin = Object.entries(clip.attachments ?? {}).flatMap(([skin, slots]) =>
        Object.entries(slots).flatMap(([slot, attachments]) =>
          Object.entries(attachments).flatMap(([attachment, timelines]) =>
            Array.isArray(timelines.deform) ? [{ skin, slot, attachment }] : []))).at(0);
      if (deformSkin) operations.push({ kind: "set_keyframe", animation: fixture.animation,
        selector: { section: "attachments", ...deformSkin, timelineType: "deform" },
        time: end + 0.25, values: { offset: 1, vertices: [0.1] } });
      const keys = await edits.preview(path, operations);
      assert.equal(keys.summaries[0].kind, "set_keyframe");
      await edits.commit(keys.editId);
      assert.deepEqual(validateDocument(await readDocument(path)), []);

      const beforeClone = await readDocument(path);
      const sourceClip = structuredClone(beforeClone.data.animations[fixture.animation]);
      const sourceDuration = inspectAnimation(beforeClone, fixture.animation).duration;
      const variant = await edits.preview(path, [{ kind: "clone_animation", sourceAnimation: fixture.animation,
        newAnimation: `${fixture.animation}-variant`, timeScale: 0.75, startAt: 0.2 }]);
      assert.equal(variant.summaries[0].kind, "clone_animation");
      assert.deepEqual(variant.diagnostics, []);
      await edits.commit(variant.editId);
      const withVariant = await readDocument(path);
      assert.deepEqual(validateDocument(withVariant), []);
      assert.deepEqual(withVariant.data.animations[fixture.animation], sourceClip);
      assert.ok(Math.abs(inspectAnimation(withVariant, `${fixture.animation}-variant`).duration
        - (sourceDuration * 0.75 + 0.2)) < 0.000001);
      const transfer = await edits.preview(path, [{ kind: "retarget_animation", sourcePath: path,
        sourceHash: withVariant.hash, sourceAnimation: fixture.animation,
        newAnimation: `${fixture.animation}-transfer` }]);
      assert.deepEqual(transfer.diagnostics, []);
      await edits.commit(transfer.editId);
      const withTransfer = await readDocument(path);
      assert.deepEqual(validateDocument(withTransfer), []);
      assert.deepEqual(withTransfer.data.animations[`${fixture.animation}-transfer`], sourceClip);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const fixture of [
  { version: "4.2", commit: "e7dc1435fa4a0083ab431f1b28e083c14a1f5c68",
    sha256: "64321cf1cc5864d9c23bb92bc355b9f7f80f61710de413a2bf65e94c734a3472" },
  { version: "4.3", commit: "7ce5d0daac13268fa3ed68eb174c2822ef2692c9",
    sha256: "f45b7a36097c60692e78fef20626103eab0532e3e40701fb29438e9d75dfa057" },
]) {
  test(`Spine ${fixture.version} official linked meshes use valid version-specific source references`, { timeout: 30_000 }, async () => {
    const response = await fetch(`${repository}/${fixture.commit}/examples/goblins/export/goblins-pro.json`);
    assert.equal(response.ok, true);
    const original = await response.text();
    assert.equal(createHash("sha256").update(original).digest("hex"), fixture.sha256);
    const document = parseDocument("/tmp/goblins-pro.json", original);
    assert.deepEqual(validateDocument(document), []);
    const field = fixture.version === "4.3" ? "source" : "parent";
    const linked = document.data.skins.find((skin) => skin.name === "goblingirl").attachments["left-foot"]["left-foot"];
    assert.equal(linked.type, "linkedmesh");
    assert.equal(linked[field], "left-foot");
    const references = referenceGraph(document, "attachment", "left-foot");
    assert.ok(references.references.some((reference) => reference.path.endsWith(`/left-foot/${field}`)));
  });
}
