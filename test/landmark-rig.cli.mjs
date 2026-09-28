import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";

import { buildRigFromLandmarks, compileRig, suggestRigManifest } from "../dist/spine/landmark-rig.js";
import { exportData } from "../dist/spine/cli.js";
import { previewRig } from "../dist/spine/rig-preview.js";

function png(w,h,top) {const image=new PNG({width:w,height:h});for(let y=top;y<h;y++)for(let x=4;x<w-4;x++)image.data.set([90,180,230,255],(y*w+x)*4);return PNG.sync.write(image)}
for(const version of ["4.2","4.3"])test(`real Spine ${version} import/export preserves landmark rig transforms`,{timeout:240_000},async()=>{
  assert.ok(process.env.SPINE_CLI_PATH,"Set SPINE_CLI_PATH for CLI tests.");
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-cli-"));
  try {
    const images=join(folder,"images");await mkdir(images);await writeFile(join(images,"body.png"),png(60,90,4));await writeFile(join(images,"leg.png"),png(33,70,17));
    const manifestPath=join(folder,"rig-landmarks.json"),m=await suggestRigManifest(images,manifestPath,version);
    const body=m.parts.find(p=>p.id==="body"),leg=m.parts.find(p=>p.id==="leg");
    m.root={part:"body",landmark:"pelvis",world:[0,95]};
    body.pivot="pelvis";body.tip="neck";body.landmarks={pelvis:[29.5,72.5],neck:[33,10],hip:[19,74]};body.confirmed=Object.keys(body.landmarks);body.setupRotationDeg=11;
    leg.pivot="hip";leg.tip="knee";leg.landmarks={hip:[11.5,19.5],knee:[15,62]};leg.confirmed=Object.keys(leg.landmarks);leg.parent={part:"body",landmark:"hip"};leg.setupRotationDeg=-17;
    m.drawOrder=["leg","body"];m.drawOrderConfirmed=true;
    await writeFile(manifestPath,JSON.stringify(m,null,2));
    const dataPath=join(folder,"rig.json"),projectPath=join(folder,"rig.spine");
    const built=await buildRigFromLandmarks({manifestPath,outputDataPath:dataPath,outputProjectPath:projectPath,editorVersion:version});
    assert.equal(built.outputProjectPath,projectPath);
    const original=JSON.parse(await readFile(dataPath,"utf8"));
    const settingsPath=join(folder,"export.json");await writeFile(settingsPath,JSON.stringify({class:"export-json",extension:".json",format:"JSON",prettyPrint:true,nonessential:true,cleanUp:false,packAtlas:null,packSource:"attachments",packTarget:"single",warnings:true,version:null,all:true,output:"",id:-1,input:"",open:false}));
    const exported=await exportData(projectPath,settingsPath,join(folder,"exports"),version);
    assert.equal(exported.files.length,1);
    const round=JSON.parse(await readFile(exported.files[0],"utf8"));
    const bones=new Map(round.bones.map(b=>[b.name,b]));
    for(const before of original.bones){const after=bones.get(before.name);assert.ok(after,`Missing bone ${before.name}`);for(const key of ["x","y","rotation","length"]){assert.ok(Math.abs((before[key]??0)-(after[key]??0))<.5,`${version} bone ${before.name} ${key}: ${before[key]} != ${after[key]}`)}}
    const attachments=round.skins.find(s=>s.name==="default").attachments;
    for(const [slot,byName] of Object.entries(original.skins[0].attachments)){const name=Object.keys(byName)[0],before=byName[name],after=attachments[slot][name];assert.ok(after);for(const key of ["x","y","rotation","width","height"])assert.ok(Math.abs((before[key]??0)-(after[key]??0))<.5,`${version} attachment ${slot} ${key}: ${before[key]} != ${after[key]}`)}
    const preview=await previewRig(manifestPath,join(folder,"previews"));
    assert.equal(preview.snapshots.length,5);assert.equal(preview.runtimePreview.available,true,JSON.stringify(preview.runtimePreview));
  } finally {await rm(folder,{recursive:true,force:true})}
});
