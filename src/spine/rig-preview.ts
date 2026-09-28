import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";

import { packAtlas } from "./cli.js";
import { SpineError } from "./errors.js";
import { assembleRig, compileRig, imageDirectory, readRigManifest, validateRigManifest, type Point, type RigManifest } from "./landmark-rig.js";
import { createPlayerPreview } from "./player.js";

const atlasCache = new Map<string, string>();
function put(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height || a <= 0) return;
  const i = (y * png.width + x) * 4, old = png.data[i + 3] / 255, now = a / 255, total = now + old * (1 - now);
  if (!total) return;
  png.data[i] = (r * now + png.data[i] * old * (1 - now)) / total;
  png.data[i + 1] = (g * now + png.data[i + 1] * old * (1 - now)) / total;
  png.data[i + 2] = (b * now + png.data[i + 2] * old * (1 - now)) / total;
  png.data[i + 3] = total * 255;
}
function line(png: PNG, a: Point, b: Point, color: [number, number, number]) {
  const count = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) * 2));
  for (let i = 0; i <= count; i++) {
    const t = i / count, x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(png, x + dx, y + dy, ...color);
  }
}
function dot(png: PNG, p: Point, color: [number, number, number]) {
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= 25)
    put(png, Math.round(p[0]) + dx, Math.round(p[1]) + dy, ...color);
}
function drawPart(target: PNG, source: PNG, center: Point, angle: number, screen: (p: Point) => Point, scale: number) {
  const c = screen(center), co = Math.cos(angle), si = Math.sin(angle);
  const corners: Point[] = [[-source.width/2, -source.height/2], [source.width/2, -source.height/2],
    [-source.width/2, source.height/2], [source.width/2, source.height/2]];
  const transformed = corners.map(([x,y]) => [c[0] + (x*co-y*si)*scale, c[1] + (x*si+y*co)*scale] as Point);
  const minX = Math.max(0, Math.floor(Math.min(...transformed.map(p => p[0])))), maxX = Math.min(target.width-1, Math.ceil(Math.max(...transformed.map(p => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...transformed.map(p => p[1])))), maxY = Math.min(target.height-1, Math.ceil(Math.max(...transformed.map(p => p[1]))));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const dx = (x-c[0])/scale, dy = (y-c[1])/scale;
    const u = Math.floor(dx*co+dy*si+source.width/2), v = Math.floor(-dx*si+dy*co+source.height/2);
    if (u < 0 || v < 0 || u >= source.width || v >= source.height) continue;
    const i = (v*source.width+u)*4;
    put(target,x,y,source.data[i],source.data[i+1],source.data[i+2],source.data[i+3]);
  }
}
export async function previewRig(manifestPath: string, outputDir: string) {
  const path = resolve(manifestPath), manifest = await readRigManifest(path);
  const validation = await validateRigManifest(manifest, path);
  const blocking = validation.errors;
  if (blocking.length) throw new SpineError("INVALID_RIG_MANIFEST", "Fix rig manifest geometry and connections before previewing.", { diagnostics: validation.diagnostics });
  const root = resolve(outputDir); await mkdir(root, { recursive: true });
  const previewDir = await mkdtemp(join(root, "rig-preview-"));
  const imagesDir = imageDirectory(manifest, path);
  const sources = new Map(await Promise.all(manifest.parts.map(async (part) => [part.id, PNG.sync.read(await readFile(resolve(imagesDir, part.image)))] as const)));
  const poses = [{ name: "setup", angles: {} }, ...manifest.parts.flatMap((part) => [
    { name: `${part.id}-minus30`, angles: { [part.id]: -30 } }, { name: `${part.id}-plus30`, angles: { [part.id]: 30 } },
  ])];
  const placementSets = poses.map((pose) => assembleRig(manifest, pose.angles));
  const allPoints: Point[] = [];
  for (const placements of placementSets) for (const placement of placements) {
    const part = manifest.parts.find((p) => p.id === placement.id)!;
    const a = -placement.imageAngleDeg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    for (const [x,y] of [[-part.width/2,-part.height/2],[part.width/2,-part.height/2],[-part.width/2,part.height/2],[part.width/2,part.height/2]])
      allPoints.push([placement.center[0]+x*co-y*si,placement.center[1]-(x*si+y*co)]);
  }
  allPoints.push([0,0]);
  const minX = Math.min(...allPoints.map(p=>p[0]))-20, maxX = Math.max(...allPoints.map(p=>p[0]))+20;
  const minY = Math.min(...allPoints.map(p=>p[1]))-20, maxY = Math.max(...allPoints.map(p=>p[1]))+20;
  const scale = Math.min(2, 1800/(maxX-minX), 1800/(maxY-minY));
  const width = Math.max(64, Math.ceil((maxX-minX)*scale)), height = Math.max(64, Math.ceil((maxY-minY)*scale));
  const screen = (p: Point): Point => [(p[0]-minX)*scale,(maxY-p[1])*scale];
  const snapshots: { pose: string; path: string }[] = [];
  for (let index=0;index<poses.length;index++) {
    const png = new PNG({width,height});
    for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
      const c = ((Math.floor(x/16)+Math.floor(y/16))&1)?225:244; put(png,x,y,c,c,c);
    }
    const placement = new Map(placementSets[index].map((p)=>[p.id,p]));
    const groundY = screen([0,0])[1]; line(png,[0,groundY],[width-1,groundY],[90,105,115]);
    for (const id of manifest.drawOrder) {
      const p=placement.get(id)!;drawPart(png,sources.get(id)!,p.center,-p.imageAngleDeg*Math.PI/180,screen,scale);
    }
    for (const part of manifest.parts) {
      const p=placement.get(part.id)!;line(png,screen(p.pivot),screen(p.tip),[28,110,210]);
      dot(png,screen(p.pivot),[246,165,49]);
      dot(png,screen(p.tip),[246,165,49]);
    }
    const target=join(previewDir,`${String(index).padStart(3,"0")}-${poses[index].name}.png`);
    await writeFile(target,PNG.sync.write(png),{flag:"wx"});snapshots.push({pose:poses[index].name,path:target});
  }
  const outputDataPath = join(previewDir,"rig.json");
  const imageKey = createHash("sha256").update(JSON.stringify({ version: manifest.spineVersion,
    images: [...validation.images.values()].map((i)=>[i.image,i.sha256]).sort() })).digest("hex");
  let runtimePreview: Record<string,unknown>;
  try {
    const compiled = compileRig(manifest,path,outputDataPath);
    await writeFile(outputDataPath,compiled.text,{flag:"wx"});
    let atlasPath = atlasCache.get(imageKey);
    if (!atlasPath || !(await readFile(atlasPath).catch(()=>undefined))) {
      const atlasRelative = relative(imagesDir, root);
      const atlasOutput = !atlasRelative || (!isAbsolute(atlasRelative) && atlasRelative !== ".." && !atlasRelative.startsWith(`..${sep}`)) ? tmpdir() : root;
      const atlas = await packAtlas(imagesDir,atlasOutput,"rig",manifest.spineVersion);
      atlasPath=atlas.atlasFiles[0];atlasCache.set(imageKey,atlasPath);
    }
    const player=await createPlayerPreview({skeletonPath:outputDataPath,atlasPath,outputDir:root,debugBones:true});
    runtimePreview={available:true,htmlPath:player.htmlPath,atlasPath,playerVersion:player.playerVersion};
  } catch(error) {
    runtimePreview={available:false,code:error instanceof SpineError?error.code:"RUNTIME_PREVIEW_FAILED",message:error instanceof Error?error.message:String(error)};
  }
  return {manifestPath:path,previewDir,outputDataPath,snapshots,runtimePreview,diagnostics:validation.diagnostics,
    visualApproval:"pending_user_review"};
}
