import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { assembleRig, buildRigFromLandmarks, compileRig, readImageInfo, readRigManifest, suggestRigManifest, validateRigManifest } from "../dist/spine/landmark-rig.js";
import { startRigReview } from "../dist/spine/rig-review.js";
import { previewRig } from "../dist/spine/rig-preview.js";

function png(width, height, left, top, right, bottom) {
  const image = new PNG({width,height});
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)image.data.set([220,80,40,255],(y*width+x)*4);
  return PNG.sync.write(image);
}
function rotate(p, deg) { const a=deg*Math.PI/180;return [p[0]*Math.cos(a)-p[1]*Math.sin(a),p[0]*Math.sin(a)+p[1]*Math.cos(a)] }
function close(actual,expected,eps=.5) { assert.ok(Math.abs(actual[0]-expected[0])<eps && Math.abs(actual[1]-expected[1])<eps, `${actual} != ${expected}`); }

for (const version of ["4.2","4.3"]) test(`landmark compiler places padded, rotated Spine ${version} parts at reviewed joints`, async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-landmarks-"));
  try {
    const images=join(folder,"images");await mkdir(images);
    await writeFile(join(images,"torso.png"),png(80,120,16,8,70,118));
    await writeFile(join(images,"thigh.png"),png(44,92,10,22,36,90));
    const manifestPath=join(folder,"rig-landmarks.json");
    const m=await suggestRigManifest(images,manifestPath,version);
    const torso=m.parts.find(p=>p.id==="torso"),thigh=m.parts.find(p=>p.id==="thigh");
    m.root={part:"torso",landmark:"pelvis",world:[23,118]};
    torso.landmarks={pelvis:[32.25,91.75],leftHip:[20.5,97.25],neck:[42.1,8.6]};torso.pivot="pelvis";torso.tip="neck";torso.setupRotationDeg=13;
    thigh.landmarks={hip:[14.4,25.2],knee:[18.7,74.3]};thigh.pivot="hip";thigh.tip="knee";thigh.parent={part:"torso",landmark:"leftHip"};thigh.setupRotationDeg=-17;
    m.drawOrder=["thigh","torso"];
    await writeFile(manifestPath,JSON.stringify(m,null,2));
    const check=await validateRigManifest(m,manifestPath);assert.equal(check.valid,true,JSON.stringify(check.errors));
    const dataPath=join(folder,"rig.json");const {document,placements}=compileRig(m,manifestPath,dataPath);
    const byId=Object.fromEntries(placements.map(p=>[p.id,p]));close(byId.torso.pivot,m.root.world);close(byId.thigh.pivot,byId.torso.landmarks.leftHip);
    const bones=document.data.bones;const slots=document.data.slots;
    assert.deepEqual(slots.map(s=>s.name),["slot:thigh","slot:torso"]);
    const boneByName=Object.fromEntries(bones.map(b=>[b.name,b]));
    for (const part of m.parts) {
      const placement=byId[part.id],bone=boneByName[`part:${part.id}`];
      const p=part.landmarks[part.pivot],t=part.landmarks[part.tip];
      const d=[t[0]-p[0],-(t[1]-p[1])];
      assert.ok(Math.abs(bone.length-Math.hypot(...d))<1e-6);
      const a=document.data.skins[0].attachments[`slot:${part.id}`][part.id];
      const center=[placement.pivot[0],placement.pivot[1]];
      const local=rotate([a.x,a.y],placement.boneAngleDeg);
      close([center[0]+local[0],center[1]+local[1]],placement.center,1e-5);
      close([placement.center[0]+rotate([p[0]-part.width/2,part.height/2-p[1]],placement.imageAngleDeg)[0],placement.center[1]+rotate([p[0]-part.width/2,part.height/2-p[1]],placement.imageAngleDeg)[1]],placement.pivot,1e-5);
      assert.equal(a.width,part.width);assert.equal(a.height,part.height);
    }
    assert.equal(document.data.skeleton.images,"images/");
    const result=await buildRigFromLandmarks({manifestPath,outputDataPath:dataPath,editorVersion:version});
    assert.equal(result.outputDataPath,dataPath);
    assert.deepEqual(await readRigManifest(manifestPath),m);
    await assert.rejects(buildRigFromLandmarks({manifestPath,outputDataPath:dataPath,editorVersion:version}),{code:"OUTPUT_EXISTS"});
    const stale=structuredClone(m);stale.parts[1].width++;
    const invalid=await validateRigManifest(stale,manifestPath);assert.ok(invalid.errors.some(d=>d.code==="STALE_IMAGE_DIMENSIONS"));
    stale.parts[1].width--;stale.parts[1].landmarks.hip=[-1,2];
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="LANDMARK_OUTSIDE_CANVAS"));
    stale.parts[1].landmarks.hip=[14.4,25.2];stale.drawOrder=["torso","torso"];
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="INVALID_DRAW_ORDER"));
    stale.drawOrder=["thigh","torso"];stale.parts.find(p=>p.id==="torso").parent={part:"thigh",landmark:"knee"};
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="ROOT_HAS_PARENT"));
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="PART_CYCLE"));
    stale.parts.find(p=>p.id==="torso").parent=null;stale.parts.find(p=>p.id==="thigh").parent={part:"torso",landmark:"missing"};
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="UNRESOLVED_CONNECTION"));
    stale.parts.find(p=>p.id==="thigh").parent={part:"torso",landmark:"leftHip"};stale.parts.find(p=>p.id==="thigh").sha256="0".repeat(64);
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="STALE_IMAGE_HASH"));
    stale.parts.find(p=>p.id==="thigh").sha256=thigh.sha256;stale.parts.find(p=>p.id==="thigh").image="missing.png";
    assert.ok((await validateRigManifest(stale,manifestPath)).errors.some(d=>d.code==="IMAGE_NOT_FOUND"));
    const draft=structuredClone(m);
    const draftPath=join(folder,"draft.json");await writeFile(draftPath,JSON.stringify(draft));
    const preview=await previewRig(draftPath,join(folder,"previews"));
    assert.equal(preview.snapshots.length,5);
    assert.ok(preview.runtimePreview);
  } finally {await rm(folder,{recursive:true,force:true})}
});

test("landmark validation reports a bend seam as a visual warning",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-seam-"));
  try {
    const images=join(folder,"images");await mkdir(images);
    await writeFile(join(images,"upper.png"),png(40,70,10,2,30,25));
    await writeFile(join(images,"lower.png"),png(40,70,10,45,30,68));
    const path=join(folder,"rig.json"),m=await suggestRigManifest(images,path,"4.2");
    const upper=m.parts.find(p=>p.id==="upper"),lower=m.parts.find(p=>p.id==="lower");
    m.root={part:"upper",landmark:"start",world:[0,100]};
    upper.pivot="start";upper.tip="joint";upper.landmarks={start:[20,5],joint:[20,30]};
    lower.pivot="joint";lower.tip="end";lower.landmarks={joint:[20,5],end:[20,65]};
    lower.parent={part:"upper",landmark:"joint"};
    const checked=await validateRigManifest(m,path);
    assert.equal(checked.valid,true,JSON.stringify(checked.errors));
    assert.ok(checked.visualWarnings.some(d=>d.code==="SEAM_GAP"));
  } finally {await rm(folder,{recursive:true,force:true})}
});

test("review editor saves only its fixed manifest, rejects stale writes, and serves standalone fallback", async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-review-"));
  try {
    const images=join(folder,"images");await mkdir(images);await writeFile(join(images,"body.png"),png(24,30,2,3,22,29));
    const result=await startRigReview({imagesDir:images,outputDir:join(folder,"review"),editorVersion:"4.2"});
    const page=await (await fetch(result.url)).text();assert.match(page,/Part view/);assert.match(page,/Assembly view/);assert.match(page,/Download manifest/);
    assert.doesNotThrow(()=>new Function(page.match(/<script>\n([\s\S]*)<\/script>/)[1]));
    assert.equal((await readFile(result.htmlPath,"utf8")),page);
    const initial=await readRigManifest(result.manifestPath),token=new URL(result.url).searchParams.get("token"),base=new URL(result.url).origin;
    initial.parts[0].setupRotationDeg=5;
    const hash=(await import("node:crypto")).createHash("sha256").update(JSON.stringify(await readRigManifest(result.manifestPath))).digest("hex");
    const saved=await fetch(base+"/manifest?token="+token,{method:"POST",headers:{"Content-Type":"application/json","If-Match":hash},body:JSON.stringify(initial)});
    assert.equal(saved.status,200,await saved.text());assert.equal((await readRigManifest(result.manifestPath)).parts[0].setupRotationDeg,5);
    const reloaded=await (await fetch(result.url)).text();assert.match(reloaded,/"setupRotationDeg":5/);
    const stale=await fetch(base+"/manifest?token="+token,{method:"POST",headers:{"If-Match":hash},body:JSON.stringify(initial)});assert.equal(stale.status,409);
    await writeFile(join(images,"body.png"),png(26,30,2,3,24,29));
    const changed=await readRigManifest(result.manifestPath),actual=await readImageInfo(images,"body.png");
    changed.parts[0].width=actual.width;changed.parts[0].height=actual.height;changed.parts[0].sha256=actual.sha256;
    const changedHash=(await import("node:crypto")).createHash("sha256").update(JSON.stringify(await readRigManifest(result.manifestPath))).digest("hex");
    const refreshed=await fetch(base+"/manifest?token="+token,{method:"POST",headers:{"If-Match":changedHash},body:JSON.stringify(changed)});
    assert.equal(refreshed.status,200,await refreshed.text());
    assert.equal((await readRigManifest(result.manifestPath)).parts[0].width,26);
    assert.equal((await validateRigManifest(await readRigManifest(result.manifestPath),result.manifestPath)).valid,true);
    const forbidden=await fetch(base+"/manifest?token=bad",{method:"POST"});assert.equal(forbidden.status,403);
  } finally {await rm(folder,{recursive:true,force:true})}
});
