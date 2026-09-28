import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

function result(response){assert.equal(response.isError,undefined,response.content?.[0]?.text);return JSON.parse(response.content[0].text)}
test("MCP rig workflow starts review, previews a draft, validates saved joints, and builds JSON",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"spine-rig-mcp-"));
  const client=new Client({name:"rig-review-test",version:"0.1.0"});
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
    const m=JSON.parse(await readFile(started.manifestPath,"utf8"));m.parts[0].setupRotationDeg=5;
    const page=await (await fetch(started.url)).text();assert.match(page,/Part view/);
    const token=new URL(started.url).searchParams.get("token"),hash=(await import("node:crypto")).createHash("sha256").update(JSON.stringify(JSON.parse(await readFile(started.manifestPath,"utf8")))).digest("hex");
    const saved=await fetch(new URL(started.url).origin+"/manifest?token="+token,{method:"POST",headers:{"If-Match":hash},body:JSON.stringify(m)});assert.equal(saved.status,200);
    const checked=result(await client.callTool({name:"spine_validate_rig_manifest",arguments:{manifestPath:started.manifestPath}}));assert.equal(checked.valid,true,JSON.stringify(checked.errors));
    const out=join(folder,"body.json");const built=result(await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,outputDataPath:out,editorVersion:"4.2"}}));
    assert.equal(built.outputDataPath,out);assert.equal(JSON.parse(await readFile(out,"utf8")).slots.length,1);
    const duplicate=await client.callTool({name:"spine_build_rig_from_landmarks",arguments:{manifestPath:started.manifestPath,outputDataPath:out,editorVersion:"4.2"}});
    assert.equal(duplicate.isError,true);assert.equal(JSON.parse(duplicate.content[0].text).code,"OUTPUT_EXISTS");
  } finally {await client.close().catch(()=>undefined);await rm(folder,{recursive:true,force:true})}
});
