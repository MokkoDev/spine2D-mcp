import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

function result(response){assert.equal(response.isError,undefined,response.content?.[0]?.text);return response.structuredContent}
test("MCP rig workflow starts review, previews a draft, validates saved joints, and builds JSON",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-mcp-"));
  const client=new Client({name:"rig-review-test",version:"0.1.0"},{capabilities:{elicitation:{form:{}}}});
  let approvalRequests=0;
  let shouldApprove=false;
  client.setRequestHandler("elicitation/create",async request=>{approvalRequests++;assert.match(request.params.message,/Approve this complete Spine rig/);return {action:"accept",content:{approved:shouldApprove}}});
  const transport=new StdioClientTransport({command:new URL("../startup.sh",import.meta.url).pathname});
  try {
    const images=join(folder,"images");await mkdir(images);const png=new PNG({width:24,height:40});
    for(let y=2;y<39;y++)for(let x=3;x<21;x++)png.data.set([20,170,80,255],(y*24+x)*4);
    await writeFile(join(images,"body.png"),PNG.sync.write(png));
    await client.connect(transport);
    const menu=result(await client.callTool({name:"spine_workflow_guide",arguments:{goal:"rig_review"}}));
    assert.ok(menu.primaryTools.includes("spine_start_rig_review"));
    const started=result(await client.callTool({name:"spine_start_rig_review",arguments:{imagesDir:images,outputDir:join(folder,"review"),editorVersion:"4.2"}}));
    assert.match(started.url,/^http:\/\/127\.0\.0\.1:/);
    const draft=result(await client.callTool({name:"spine_validate_rig_manifest",arguments:{manifestPath:started.manifestPath}}));
    assert.equal(draft.valid,true);assert.equal(draft.errors.length,0);
    const preview=result(await client.callTool({name:"spine_preview_rig",arguments:{manifestPath:started.manifestPath,outputDir:join(folder,"previews")}}));
    assert.equal(preview.snapshots.length,3);
    assert.match(preview.reviewId,/^[0-9a-f-]{36}$/);
    const m=JSON.parse(await readFile(started.manifestPath,"utf8"));m.parts[0].setupRotationDeg=5;
    const page=await (await fetch(started.url)).text();assert.match(page,/Part view/);
    const token=new URL(started.url).searchParams.get("token"),hash=(await import("node:crypto")).createHash("sha256").update(JSON.stringify(JSON.parse(await readFile(started.manifestPath,"utf8")))).digest("hex");
    const saved=await fetch(new URL(started.url).origin+"/manifest?token="+token,{method:"POST",headers:{"If-Match":hash},body:JSON.stringify(m)});assert.equal(saved.status,200);
    const checked=result(await client.callTool({name:"spine_validate_rig_manifest",arguments:{manifestPath:started.manifestPath}}));assert.equal(checked.valid,true,JSON.stringify(checked.errors));
    const stale=await client.callTool({name:"spine_confirm_rig_review",arguments:{reviewId:preview.reviewId}});
    assert.equal(stale.isError,true);assert.equal(stale.structuredContent.code,"RIG_REVIEW_STALE");assert.equal(approvalRequests,0);
    const reviewed=result(await client.callTool({name:"spine_preview_rig",arguments:{manifestPath:started.manifestPath,outputDir:join(folder,"previews")}}));
    const out=join(folder,"body.json");
    const unapproved=await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:reviewed.reviewId,outputDataPath:out,editorVersion:"4.2"}});
    assert.equal(unapproved.isError,true);assert.equal(unapproved.structuredContent.code,"RIG_CONFIRMATION_REQUIRED");
    const browserBuild=await fetch(new URL(started.url).origin+"/build?token="+token,{method:"POST"});
    assert.equal(browserBuild.status,403);
    const declined=await client.callTool({name:"spine_confirm_rig_review",arguments:{reviewId:reviewed.reviewId}});
    assert.equal(declined.isError,true);assert.equal(declined.structuredContent.code,"RIG_CONFIRMATION_DECLINED");
    shouldApprove=true;
    const confirmed=result(await client.callTool({name:"spine_confirm_rig_review",arguments:{reviewId:reviewed.reviewId}}));
    assert.equal(confirmed.approved,true);assert.equal(approvalRequests,2);
    const built=result(await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:reviewed.reviewId,outputDataPath:out,editorVersion:"4.2"}}));
    assert.equal(built.outputDataPath,out);assert.equal(JSON.parse(await readFile(out,"utf8")).slots.length,1);
    const duplicate=await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:reviewed.reviewId,outputDataPath:out,editorVersion:"4.2"}});
    assert.equal(duplicate.isError,true);assert.equal(duplicate.structuredContent.code,"OUTPUT_EXISTS");
    await writeFile(join(images,"body.png"),PNG.sync.write(new PNG({width:24,height:40})));
    const changedImage=await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:reviewed.reviewId,outputDataPath:join(folder,"other.json"),editorVersion:"4.2"}});
    assert.equal(changedImage.isError,true);assert.equal(changedImage.structuredContent.code,"INVALID_RIG_MANIFEST");
  } finally {await client.close().catch(()=>undefined);await rm(folder,{recursive:true,force:true})}
});

test("direct JSON rig commits and imports cannot bypass confirmation",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-bypass-"));
  const client=new Client({name:"rig-bypass-test",version:"0.1.0"});
  const transport=new StdioClientTransport({command:new URL("../startup.sh",import.meta.url).pathname});
  try {
    await client.connect(transport);
    const path=join(folder,"direct.json");
    result(await client.callTool({name:"spine_create_skeleton",arguments:{dataPath:path,version:"4.2"}}));
    const stage=result(await client.callTool({name:"spine_preview_edit",arguments:{path,operations:[
      {kind:"upsert_bone",name:"body",parent:"root",values:{length:30}},
      {kind:"upsert_slot",name:"body",bone:"body",values:{attachment:"body"}},
      {kind:"upsert_slot",name:"head",bone:"body",values:{attachment:"head"}},
      {kind:"upsert_region_attachment",skin:"default",slot:"body",name:"body",values:{width:24,height:40}},
      {kind:"upsert_region_attachment",skin:"default",slot:"head",name:"head",values:{width:24,height:24}},
    ]}}));
    const commit=await client.callTool({name:"spine_commit_edit",arguments:{editId:stage.editId}});
    assert.equal(commit.isError,true);assert.equal(commit.structuredContent.code,"RIG_REVIEW_REQUIRED");
    assert.equal(JSON.parse(await readFile(path,"utf8")).slots.length,0);
    const direct={skeleton:{spine:"4.2",images:"./images/"},bones:[{name:"root"}],
      slots:[{name:"body",bone:"root",attachment:"body"},{name:"head",bone:"root",attachment:"head"}],
      skins:[{name:"default",attachments:{body:{body:{type:"region",width:24,height:40}},head:{head:{type:"region",width:24,height:24}}}}],animations:{}};
    await writeFile(path,JSON.stringify(direct));
    const imported=await client.callTool({name:"spine_import_data",arguments:{dataPath:path,outputProjectPath:join(folder,"direct.spine"),editorVersion:"4.2"}});
    assert.equal(imported.isError,true);assert.equal(imported.structuredContent.code,"RIG_REVIEW_REQUIRED");
    const finalized=await client.callTool({name:"spine_finalize_animation",arguments:{dataPath:path,dataSettingsPath:"missing",previewSettingsPath:"missing",outputDir:folder,animation:"walk",editorVersion:"4.2"}});
    assert.equal(finalized.isError,true);assert.equal(finalized.structuredContent.code,"RIG_REVIEW_REQUIRED");
  } finally {await client.close().catch(()=>undefined);await rm(folder,{recursive:true,force:true})}
});

test("rig review stays unapproved when the MCP client cannot prompt the user",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-no-elicit-"));
  const client=new Client({name:"rig-no-elicit-test",version:"0.1.0"});
  const transport=new StdioClientTransport({command:new URL("../startup.sh",import.meta.url).pathname});
  try {
    const images=join(folder,"images");await mkdir(images);
    const png=new PNG({width:16,height:16});
    for(let y=2;y<14;y++)for(let x=2;x<14;x++)png.data.set([30,100,200,255],(y*16+x)*4);
    await writeFile(join(images,"body.png"),PNG.sync.write(png));
    await client.connect(transport);
    const started=result(await client.callTool({name:"spine_start_rig_review",arguments:{imagesDir:images,outputDir:join(folder,"review"),editorVersion:"4.2"}}));
    const preview=result(await client.callTool({name:"spine_preview_rig",arguments:{manifestPath:started.manifestPath,outputDir:join(folder,"previews")}}));
    const confirmation=await client.callTool({name:"spine_confirm_rig_review",arguments:{reviewId:preview.reviewId}});
    assert.notEqual(confirmation.structuredContent?.approved,true);
    const built=await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:preview.reviewId,outputDataPath:join(folder,"body.json"),editorVersion:"4.2"}});
    assert.equal(built.isError,true);
    assert.equal(built.structuredContent.code,"RIG_CONFIRMATION_REQUIRED");
  } finally {await client.close().catch(()=>undefined);await rm(folder,{recursive:true,force:true})}
});

test("approved multi-part rig permits motion but invalidates on rig or image changes",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-approved-"));
  const client=new Client({name:"rig-approved-test",version:"0.1.0"},{capabilities:{elicitation:{form:{}}}});
  client.setRequestHandler("elicitation/create",async()=>({action:"accept",content:{approved:true}}));
  const transport=new StdioClientTransport({command:new URL("../startup.sh",import.meta.url).pathname});
  try {
    const images=join(folder,"images");await mkdir(images);
    const png=new PNG({width:24,height:40});
    for(let y=1;y<39;y++)for(let x=3;x<21;x++)png.data.set([20,170,80,255],(y*24+x)*4);
    for(const name of ["body","head"])await writeFile(join(images,`${name}.png`),PNG.sync.write(png));
    await client.connect(transport);
    const started=result(await client.callTool({name:"spine_start_rig_review",arguments:{imagesDir:images,outputDir:join(folder,"review"),editorVersion:"4.2"}}));
    const draft=structuredClone(started.manifest),body=draft.parts.find(p=>p.id==="body"),head=draft.parts.find(p=>p.id==="head");
    draft.root={part:"body",landmark:body.pivot,world:[0,40]};body.parent=null;head.parent={part:"body",landmark:body.tip};draft.drawOrder=["body","head"];
    result(await client.callTool({name:"spine_save_rig_draft",arguments:{manifestPath:started.manifestPath,sourceHash:started.sourceHash,draft}}));
    const preview=result(await client.callTool({name:"spine_preview_rig",arguments:{manifestPath:started.manifestPath,outputDir:join(folder,"previews")}}));
    result(await client.callTool({name:"spine_confirm_rig_review",arguments:{reviewId:preview.reviewId}}));
    const path=join(folder,"approved.json");
    result(await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,reviewId:preview.reviewId,outputDataPath:path,editorVersion:"4.2"}}));
    const motion=result(await client.callTool({name:"spine_preview_edit",arguments:{path,operations:[
      {kind:"upsert_animation",name:"nod"},
      {kind:"set_keyframe",animation:"nod",selector:{section:"bones",target:"part:head",timelineType:"rotate"},time:0,values:{value:0}},
      {kind:"set_keyframe",animation:"nod",selector:{section:"bones",target:"part:head",timelineType:"rotate"},time:0.5,values:{value:12}},
    ]}}));
    result(await client.callTool({name:"spine_commit_edit",arguments:{editId:motion.editId}}));
    const rigEdit=result(await client.callTool({name:"spine_upsert_bone",arguments:{path,name:"part:head",parent:"part:body",values:{length:18}}}));
    const blocked=await client.callTool({name:"spine_commit_edit",arguments:{editId:rigEdit.editId}});
    assert.equal(blocked.isError,true);assert.equal(blocked.structuredContent.code,"RIG_REVIEW_REQUIRED");
    await writeFile(join(images,"head.png"),PNG.sync.write(new PNG({width:24,height:40})));
    const changedImage=await client.callTool({name:"spine_import_data",arguments:{dataPath:path,outputProjectPath:join(folder,"changed.spine"),editorVersion:"4.2"}});
    assert.equal(changedImage.isError,true);assert.equal(changedImage.structuredContent.code,"RIG_REVIEW_REQUIRED");
  } finally {await client.close().catch(()=>undefined);await rm(folder,{recursive:true,force:true})}
});
