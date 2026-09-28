import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { SpineError } from "./errors.js";
import { buildRigFromLandmarks, calculateRigPlacements, imageDirectory, inventoryImages, readImageInfo, readRigManifest, suggestRigManifest, validateRigManifest, type RigManifest } from "./landmark-rig.js";
import { RIG_INCOMPLETE_NEXT_ACTION, RIG_READY_NEXT_ACTION } from "../workflow-guide.js";

function scriptJson(value: unknown) { return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }
function sha(text: string) { return createHash("sha256").update(text).digest("hex"); }
const sessions = new Map<string, Server>();

async function checkRigDraftSources(current: RigManifest, draft: RigManifest, manifestPath: string, allowReviewedImages: boolean) {
  const oldById = new Map(current.parts.map((part) => [part.id, part]));
  if (!Array.isArray(draft.parts) || draft.schemaVersion !== current.schemaVersion || draft.spineVersion !== current.spineVersion
    || draft.imagesDir !== current.imagesDir || draft.parts.length !== current.parts.length
    || draft.parts.some((part) => !part || !oldById.has(part.id) || part.image !== oldById.get(part.id)!.image)
    || new Set(draft.parts.map((part) => part.id)).size !== draft.parts.length)
    throw new SpineError("IMMUTABLE_IMAGE_METADATA", "Assembly edits cannot change source images or part identities.");
  for (const part of draft.parts) {
    const old = oldById.get(part.id)!;
    if (part.width === old.width && part.height === old.height && part.sha256 === old.sha256) continue;
    if (!allowReviewedImages) throw new SpineError("IMMUTABLE_IMAGE_METADATA", "Assembly edits cannot change source image metadata.");
    const actual = await readImageInfo(imageDirectory(current, manifestPath), part.image);
    if (part.width !== actual.width || part.height !== actual.height || part.sha256 !== actual.sha256)
      throw new SpineError("IMAGE_REVIEW_REQUIRED", `Changed image ${part.image} needs current dimensions and hash; review its landmarks.`);
  }
}

async function writeRigDraft(manifestPath: string, draft: RigManifest, sourceHash: string) {
  const temp = join(dirname(manifestPath), `.rig-manifest-${randomUUID()}.json`);
  try {
    await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
    if (sha(JSON.stringify(await readRigManifest(manifestPath))) !== sourceHash)
      throw new SpineError("RIG_DRAFT_CHANGED", "The rig draft changed while it was being saved. Reload it before retrying.");
    await rename(temp, manifestPath);
  } finally { await rm(temp, { force: true }); }
  return sha(JSON.stringify(draft));
}

export async function saveRigDraft(input: { manifestPath: string; sourceHash: string; draft: RigManifest }) {
  const manifestPath = resolve(input.manifestPath);
  const current = await readRigManifest(manifestPath);
  if (sha(JSON.stringify(current)) !== input.sourceHash)
    throw new SpineError("RIG_DRAFT_CHANGED", "The rig draft changed since it was opened. Reload it before saving an assembled draft.");
  const draft = input.draft;
  await checkRigDraftSources(current, draft, manifestPath, false);
  const checked = await validateRigManifest(draft, manifestPath);
  if (!checked.valid) throw new SpineError("INVALID_RIG_MANIFEST", "Connect and place every part before saving the assembled draft.", { diagnostics: checked.diagnostics });
  const sourceHash = await writeRigDraft(manifestPath, draft, input.sourceHash);
  return { manifestPath, sourceHash, reviewStatus: "ready_for_visual_preview",
    diagnostics: checked.diagnostics,
    nextAction: RIG_READY_NEXT_ACTION };
}

export async function reviewHtml(manifest: RigManifest, manifestPath: string, token: string) {
  const dir = imageDirectory(manifest, manifestPath);
  const actual = Object.fromEntries((await Promise.all(manifest.parts.map(async (part) => {
    const info = await readImageInfo(dir, part.image);
    return [part.id, { width: info.width, height: info.height, sha256: info.sha256 }] as const;
  }))));
  const images = await Promise.all(manifest.parts.map(async (part) => {
    const bytes = await readFile(resolve(dir, part.image));
    return [part.id, `data:image/png;base64,${bytes.toString("base64")}`] as const;
  }));
  const diagnostics = (await validateRigManifest(manifest, manifestPath)).diagnostics;
  const initial = scriptJson({ manifest, images: Object.fromEntries(images), actual, diagnostics, token, manifestPath, hash: sha(JSON.stringify(manifest)) });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spine rig review</title>
<style>
:root{font:14px system-ui,sans-serif;color:#e6e9ed;background:#171b22}*{box-sizing:border-box}body{margin:0}header{padding:14px 20px;border-bottom:1px solid #344052;display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:18px;margin:0}button,input,select{font:inherit}button{background:#344b65;border:1px solid #66809b;color:#fff;padding:5px 9px;border-radius:4px;cursor:pointer}button:hover{background:#476788}button:disabled{opacity:.45;cursor:default}label{display:inline-flex;align-items:center;gap:5px}select,input[type=number],input[type=text]{background:#202b38;border:1px solid #536679;color:#fff;padding:4px;max-width:160px}input[type=range]{vertical-align:middle}.layout{display:grid;grid-template-columns:260px minmax(350px,1fr) minmax(350px,1fr);min-height:calc(100vh - 66px)}aside{border-right:1px solid #344052;padding:14px 14px 72px;display:flex;flex-direction:column;gap:12px}.views{grid-column:span 2;display:grid;grid-template-columns:1fr 1fr}.view{padding:12px;min-width:0}.view:first-child{border-right:1px solid #344052}h2{font-size:16px;margin:0}.view-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}.view-heading button{font-size:12px}.canvas-wrap{overflow:auto;border:1px solid #526074;background:#272c35}canvas{display:block;width:100%;height:auto;touch-action:none;cursor:crosshair}.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:7px}.history-actions{position:fixed;left:12px;bottom:12px;z-index:5;display:flex;gap:6px;padding:6px;background:#202b38;border:1px solid #526074;border-radius:6px}.muted{color:#aeb9c7;font-size:12px}.status{min-height:2em;white-space:pre-wrap}.landmarks{max-height:220px;overflow:auto}.landmark{padding:3px 0}footer{padding:8px 15px;border-top:1px solid #344052;color:#aeb9c7}@media(max-width:1100px){.layout{display:block}.views{display:block}.view:first-child{border-right:0}.canvas-wrap{max-width:800px}}
</style></head><body><header><h1>Spine rig review</h1><span id="file"></span><button id="save" type="button">Save now</button><button id="refresh-images" hidden>Review changed PNGs</button><button id="download">Download manifest</button><button id="build">Build native project</button><span id="save-state" class="muted"></span></header>
<div class="layout"><aside>
<div class="stack"><label>Part <select id="part"></select></label><label>Zoom <input id="zoom" type="range" min="0.5" max="5" step="0.1" value="2"><span id="zoom-value">2×</span></label></div>
<div class="stack"><strong>Landmarks</strong><div id="landmarks" class="landmarks"></div><div class="row"><input id="new-landmark" type="text" placeholder="new landmark name"><button id="add-landmark">Add</button></div><div class="muted">Drag a marker to adjust its position. Coordinates use the full PNG canvas.</div></div>
<div class="stack"><label>Pivot <select id="pivot"></select></label><label>Tip <select id="tip"></select></label><label>Parent part <select id="parent"></select></label><label>Parent landmark <select id="parent-landmark"></select></label><button id="make-root">Make selected part root</button></div>
<div class="stack"><strong>Assembly</strong><label>Root X <input id="root-x" type="number" step="0.1"></label><label>Root Y <input id="root-y" type="number" step="0.1"></label><label>Setup rotation <input id="rotation" type="range" min="-180" max="180" step="0.1" value="0"><input id="rotation-number" type="number" step="0.1" value="0">°</label><div class="row"><button id="order-back">Move back</button><button id="order-front">Move front</button></div><div id="order-list" class="muted"></div><button id="pose-test">Test bend ±30°</button></div>
<div id="status" class="status muted"></div><div class="history-actions" role="group" aria-label="Edit history"><button id="undo" type="button" title="Ctrl+Z" aria-keyshortcuts="Control+Z">Undo</button><button id="redo" type="button" title="Ctrl+Shift+Z" aria-keyshortcuts="Control+Shift+Z">Redo</button></div></aside>
<div class="views"><section class="view"><div class="view-heading"><h2>Part view</h2></div><div class="canvas-wrap"><canvas id="part-canvas" width="760" height="700"></canvas></div><div id="pointer" class="muted">Pointer: —</div></section><section class="view"><div class="view-heading"><h2>Assembly view</h2><button id="toggle-bones" type="button" aria-pressed="true">Hide skeleton</button><button id="toggle-points" type="button" aria-pressed="true">Hide points</button></div><div class="canvas-wrap"><canvas id="assembly-canvas" width="760" height="700"></canvas></div><div class="muted">Drag the selected tip handle to rotate its part and connected children. Click a part in the unconnected tray to select it, then choose its parent landmark. The white line marks the ground.</div></section></div></div>
<footer>Canvas outlines include transparent padding. Changes save automatically; Undo and Redo affect rig edits. Playback pose tests reset and never change landmarks.</footer>
<script id="rig-data" type="application/json">${initial}</script><script>
(function(){'use strict';
const boot=JSON.parse(document.getElementById('rig-data').textContent);let m=boot.manifest;let saved=JSON.stringify(m);for(const p of m.parts)delete p.confirmed;delete m.drawOrderConfirmed;let savedHash=boot.hash;let selected=m.root.part;let zoom=2;let drag=null;let pose={};let testing=false;let showBones=true;let showPoints=true;let trayHits=[];let saveTimer=null;let savePromise=null;let history=[JSON.stringify(m)];let historyIndex=0;let status=document.getElementById('status');const $=id=>document.getElementById(id);const pc=$('part-canvas'),ac=$('assembly-canvas'),pctx=pc.getContext('2d'),actx=ac.getContext('2d');const imgs={};for(const [id,src] of Object.entries(boot.images)){const im=new Image();im.onload=draw;im.src=src;imgs[id]=im}
$('file').textContent=boot.manifestPath;const part=()=>m.parts.find(p=>p.id===selected);const byId=id=>m.parts.find(p=>p.id===id);const rad=d=>d*Math.PI/180;const deg=r=>r*180/Math.PI;
function fillSelect(el,items,value){el.innerHTML='';for(const [v,label] of items){const o=document.createElement('option');o.value=v;o.textContent=label;el.append(o)}el.value=value}
function orderedParts(){const ids=new Set(m.parts.map(p=>p.id));return [...new Set([...(Array.isArray(m.drawOrder)?m.drawOrder:[]),...m.parts.map(p=>p.id)])].filter(id=>ids.has(id))}
function syncPartSelect(){fillSelect($('part'),orderedParts().map(id=>[id,id]),selected)}
function sync(){const p=part();syncPartSelect();const names=Object.keys(p.landmarks);fillSelect($('pivot'),names.map(n=>[n,n]),p.pivot);fillSelect($('tip'),names.map(n=>[n,n]),p.tip);fillSelect($('parent'),[['','— root / unconnected —'],...orderedParts().filter(id=>id!==p.id).map(id=>[id,id])],p.parent?.part||'');updateParentLandmarks();$('root-x').value=String(m.root.world[0]);$('root-y').value=String(m.root.world[1]);$('rotation').value=String(p.setupRotationDeg);$('rotation-number').value=String(p.setupRotationDeg);$('zoom').value=String(zoom);$('zoom-value').textContent=zoom.toFixed(1)+'×';$('make-root').disabled=m.root.part===p.id;renderLandmarks();dirty();draw()}
function updateParentLandmarks(){const p=part(),parent=byId($('parent').value);fillSelect($('parent-landmark'),parent?Object.keys(parent.landmarks).map(n=>[n,n]):[['','—']],p.parent?.landmark||'')}
function renderLandmarks(){const box=$('landmarks');box.innerHTML='';for(const [name,v] of Object.entries(part().landmarks)){const row=document.createElement('div');row.className='landmark';row.textContent=name+' ('+v[0].toFixed(2)+', '+v[1].toFixed(2)+')';box.append(row)}}
function dirty(){const pending=JSON.stringify(m)!==saved;$('save-state').textContent=location.protocol==='file:'?(pending?'Download to save':'Saved snapshot'):savePromise?'Saving…':pending?'Autosave pending':'Saved';$('save').disabled=!pending&&!savePromise;$('undo').disabled=historyIndex===0;$('redo').disabled=historyIndex===history.length-1;const stale=m.parts.some(p=>{const a=boot.actual[p.id];return a&&(p.width!==a.width||p.height!==a.height||p.sha256!==a.sha256)});$('refresh-images').hidden=!stale;$('order-list').textContent='Back → front: '+m.drawOrder.join(' → ')}
function changed(commit=true){if(commit){const snapshot=JSON.stringify(m);if(snapshot!==history[historyIndex]){history=history.slice(0,historyIndex+1);history.push(snapshot);if(history.length>100)history.shift();historyIndex=history.length-1}scheduleSave()}syncPartSelect();renderLandmarks();dirty();draw()}
function restoreHistory(index){if(index<0||index>=history.length)return;historyIndex=index;m=JSON.parse(history[index]);drag=null;if(!m.parts.some(p=>p.id===selected))selected=m.root.part;sync();scheduleSave()}
function undo(){restoreHistory(historyIndex-1)}function redo(){restoreHistory(historyIndex+1)}
function checker(ctx,x,y,w,h,step=14){for(let iy=0;iy<h;iy+=step)for(let ix=0;ix<w;ix+=step){ctx.fillStyle=((ix/step+iy/step)&1)?'#d0d3d6':'#f3f4f6';ctx.fillRect(x+ix,y+iy,Math.min(step,w-ix),Math.min(step,h-iy))}}
function dot(ctx,x,y,name){ctx.fillStyle='#ffce68';ctx.strokeStyle='#10202a';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.font='14px system-ui';ctx.fillStyle='#fff';ctx.strokeStyle='#18212a';ctx.lineWidth=3;ctx.strokeText(name,x+9,y-8);ctx.fillText(name,x+9,y-8)}
function partTransform(){const p=part(),s=zoom,x=(pc.width-p.width*s)/2,y=(pc.height-p.height*s)/2;return{x,y,s}}
function drawPart(){const p=part(),t=partTransform();pctx.fillStyle='#242a33';pctx.fillRect(0,0,pc.width,pc.height);checker(pctx,t.x,t.y,p.width*t.s,p.height*t.s,Math.max(8,Math.round(12*t.s)));const im=imgs[p.id];if(im?.complete)pctx.drawImage(im,t.x,t.y,p.width*t.s,p.height*t.s);pctx.strokeStyle='#fff';pctx.lineWidth=1.5;pctx.strokeRect(t.x,t.y,p.width*t.s,p.height*t.s);pctx.strokeStyle='#00c9ea';pctx.setLineDash([5,3]);const b=imageBounds(im);if(b)pctx.strokeRect(t.x+b[0]*t.s,t.y+b[1]*t.s,(b[2]-b[0])*t.s,(b[3]-b[1])*t.s);pctx.setLineDash([]);for(const [n,v] of Object.entries(p.landmarks))dot(pctx,t.x+v[0]*t.s,t.y+v[1]*t.s,n);const pivot=p.landmarks[p.pivot];if(pivot){const x=t.x+pivot[0]*t.s,y=t.y+pivot[1]*t.s,a=-rad(p.setupRotationDeg);pctx.strokeStyle='#ffdc70';pctx.lineWidth=2;pctx.beginPath();pctx.moveTo(x,y);pctx.lineTo(x+26*Math.cos(a),y+26*Math.sin(a));pctx.stroke()}pctx.fillStyle='#fff';pctx.fillText('White: PNG canvas   Cyan: opaque pixels   Rotation: '+p.setupRotationDeg.toFixed(1)+'°',12,22)}
const boundsCache={};function imageBounds(im){if(!im?.complete||!im.naturalWidth)return null;if(boundsCache[im.src])return boundsCache[im.src];const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let x0=c.width,y0=c.height,x1=-1,y1=-1;for(let y=0;y<c.height;y++)for(let xx=0;xx<c.width;xx++)if(d[(y*c.width+xx)*4+3]>16){x0=Math.min(x0,xx);y0=Math.min(y0,y);x1=Math.max(x1,xx);y1=Math.max(y1,y)}return boundsCache[im.src]=x1<0?null:[x0,y0,x1+1,y1+1]}
const rigPlacements = ${calculateRigPlacements.toString()};
function placements(){return rigPlacements(m,pose)}
function worldScreen(p){return[ac.width/2+p[0]*zoom,ac.height-90-p[1]*zoom]}function screenWorld(p){return[(p[0]-ac.width/2)/zoom,(ac.height-90-p[1])/zoom]}
function drawAssembly(){actx.fillStyle='#252b34';actx.fillRect(0,0,ac.width,ac.height);const all=placements();actx.strokeStyle='#f5f5f5';actx.lineWidth=2;actx.beginPath();actx.moveTo(0,ac.height-90);actx.lineTo(ac.width,ac.height-90);actx.stroke();for(const id of m.drawOrder){const p=byId(id),a=all[id],im=imgs[id];if(!p||!a||!im?.complete)continue;const c=worldScreen(a.center);actx.save();actx.translate(c[0],c[1]);actx.rotate(-rad(a.imageAngleDeg));actx.drawImage(im,-p.width*zoom/2,-p.height*zoom/2,p.width*zoom,p.height*zoom);actx.restore()}
for(const p of m.parts){const a=all[p.id];if(!a)continue;const b=worldScreen(a.pivot),t=worldScreen(a.tip);if(showBones){actx.strokeStyle=p.id===selected?'#ffdc70':'#80bbff';actx.lineWidth=p.id===selected?3:2;actx.beginPath();actx.moveTo(b[0],b[1]);actx.lineTo(t[0],t[1]);actx.stroke()}if(showPoints){dot(actx,b[0],b[1],p.id+(p.id===selected?' pivot':''));if(p.id===selected){dot(actx,t[0],t[1],'rotate');for(const [name,w] of Object.entries(a.landmarks))if(name!==p.pivot&&name!==p.tip){const v=worldScreen(w);dot(actx,v[0],v[1],name)}}}}
const loose=m.parts.filter(p=>!all[p.id]);trayHits=[];if(!loose.length)return;const left=ac.width-218,top=8,width=210,rows=Math.ceil(loose.length/2),cellH=Math.min(116,(ac.height-48)/rows);actx.fillStyle='#18232f';actx.fillRect(left,top,width,ac.height-16);actx.strokeStyle='#586c81';actx.strokeRect(left,top,width,ac.height-16);actx.fillStyle='#fff';actx.font='13px system-ui';actx.fillText('Unconnected parts ('+loose.length+')',left+8,top+19);actx.font='11px system-ui';for(let i=0;i<loose.length;i++){const p=loose[i],im=imgs[p.id],col=i%2,row=Math.floor(i/2),x=left+5+col*102,y=top+29+row*cellH,w=98,h=cellH-4;trayHits.push({id:p.id,x,y,w,h});actx.fillStyle=p.id===selected?'#455b73':'#293747';actx.fillRect(x,y,w,h);actx.strokeStyle=p.id===selected?'#ffdc70':'#46596b';actx.strokeRect(x,y,w,h);if(im?.complete){const scale=Math.min(2,(w-12)/p.width,(h-28)/p.height);const iw=p.width*scale,ih=p.height*scale;actx.drawImage(im,x+(w-iw)/2,y+4+(h-28-ih)/2,iw,ih)}actx.fillStyle='#fff';actx.fillText(p.id.slice(0,15),x+5,y+h-7)}}
function draw(){if(part()){drawPart();drawAssembly()}}
function canvasPoint(e,c){const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]}
pc.addEventListener('pointerdown',e=>{const p=canvasPoint(e,pc),t=partTransform();let best=null,d=14;for(const [n,v] of Object.entries(part().landmarks)){const dist=Math.hypot(p[0]-t.x-v[0]*t.s,p[1]-t.y-v[1]*t.s);if(dist<d){best=n;d=dist}}if(best){clearTimeout(saveTimer);drag={kind:'landmark',name:best};pc.setPointerCapture(e.pointerId)}});
pc.addEventListener('pointermove',e=>{const p=canvasPoint(e,pc),t=partTransform(),u=(p[0]-t.x)/t.s,v=(p[1]-t.y)/t.s;$('pointer').textContent='Pointer: ('+u.toFixed(2)+', '+v.toFixed(2)+') px from image top-left';if(drag?.kind==='landmark'){part().landmarks[drag.name]=[Math.max(0,Math.min(part().width,u)),Math.max(0,Math.min(part().height,v))];changed(false)}});function finishDrag(kind){if(drag?.kind===kind){drag=null;changed()}}pc.addEventListener('pointerup',()=>finishDrag('landmark'));pc.addEventListener('pointercancel',()=>finishDrag('landmark'));
ac.addEventListener('pointerdown',e=>{const p=canvasPoint(e,ac),hit=trayHits.find(t=>p[0]>=t.x&&p[0]<t.x+t.w&&p[1]>=t.y&&p[1]<t.y+t.h);if(hit){selected=hit.id;sync();return}if(!showPoints)return;const a=placements()[selected];if(!a)return;const tip=worldScreen(a.tip);if(Math.hypot(p[0]-tip[0],p[1]-tip[1])<25){clearTimeout(saveTimer);drag={kind:'rotate',base:part().setupRotationDeg,angle:Math.atan2(p[1]-worldScreen(a.pivot)[1],p[0]-worldScreen(a.pivot)[0])};ac.setPointerCapture(e.pointerId)}});ac.addEventListener('pointermove',e=>{if(drag?.kind!=='rotate')return;const p=canvasPoint(e,ac),a=placements()[selected],b=worldScreen(a.pivot);const angle=Math.atan2(p[1]-b[1],p[0]-b[0]);const val=drag.base+deg(angle-drag.angle);part().setupRotationDeg=Math.round(val*10)/10;$('rotation').value=String(part().setupRotationDeg);$('rotation-number').value=String(part().setupRotationDeg);changed(false)});ac.addEventListener('pointerup',()=>finishDrag('rotate'));ac.addEventListener('pointercancel',()=>finishDrag('rotate'));
$('toggle-bones').onclick=()=>{showBones=!showBones;$('toggle-bones').textContent=showBones?'Hide skeleton':'Show skeleton';$('toggle-bones').setAttribute('aria-pressed',String(showBones));draw()};$('toggle-points').onclick=()=>{showPoints=!showPoints;$('toggle-points').textContent=showPoints?'Hide points':'Show points';$('toggle-points').setAttribute('aria-pressed',String(showPoints));draw()};
$('part').onchange=e=>{selected=e.target.value;sync()};$('zoom').oninput=e=>{zoom=Number(e.target.value);$('zoom-value').textContent=zoom.toFixed(1)+'×';draw()};$('pivot').onchange=e=>{part().pivot=e.target.value;if(m.root.part===selected)m.root.landmark=part().pivot;changed()};$('tip').onchange=e=>{part().tip=e.target.value;changed()};$('parent').onchange=e=>{const id=e.target.value,pa=byId(id);part().parent=pa?{part:id,landmark:Object.keys(pa.landmarks)[0]}:null;updateParentLandmarks();changed()};$('parent-landmark').onchange=e=>{if(part().parent)part().parent.landmark=e.target.value;changed()};$('make-root').onclick=()=>{const old=byId(m.root.part);if(old&&old.id!==selected)old.parent=null;part().parent=null;m.root.part=selected;m.root.landmark=part().pivot;sync();changed()};function rotation(v,commit=true){if(!Number.isFinite(v))return;part().setupRotationDeg=v;$('rotation').value=String(v);$('rotation-number').value=String(v);changed(commit);if(!commit)scheduleSave()}$('rotation').oninput=e=>rotation(Number(e.target.value),false);$('rotation').onchange=e=>rotation(Number(e.target.value));$('rotation-number').onchange=e=>rotation(Number(e.target.value));
$('root-x').onchange=e=>{const v=Number(e.target.value);if(Number.isFinite(v)){m.root.world[0]=v;changed()}};$('root-y').onchange=e=>{const v=Number(e.target.value);if(Number.isFinite(v)){m.root.world[1]=v;changed()}};
$('add-landmark').onclick=()=>{const n=$('new-landmark').value.trim();if(!n||Object.hasOwn(part().landmarks,n)){status.textContent='Enter a new unique landmark name.';return}part().landmarks[n]=[part().width/2,part().height/2];$('new-landmark').value='';sync();changed()};function moveOrder(delta){const i=m.drawOrder.indexOf(selected),j=i+delta;if(j<0||j>=m.drawOrder.length)return;[m.drawOrder[i],m.drawOrder[j]]=[m.drawOrder[j],m.drawOrder[i]];sync();changed()}$('order-back').onclick=()=>moveOrder(-1);$('order-front').onclick=()=>moveOrder(1);
$('pose-test').onclick=()=>{if(testing)return;testing=true;const id=selected,start=performance.now();function tick(now){const dt=now-start;if(dt>=1800){delete pose[id];testing=false;draw();return}pose[id]=30*Math.sin(dt/1800*Math.PI*4);draw();requestAnimationFrame(tick)}requestAnimationFrame(tick)};
$('refresh-images').onclick=()=>{let count=0;for(const p of m.parts){const a=boot.actual[p.id];if(a&&(p.width!==a.width||p.height!==a.height||p.sha256!==a.sha256)){p.width=a.width;p.height=a.height;p.sha256=a.sha256;count++}}if(count){sync();changed();status.textContent=count+' changed PNGs need landmark review. Reposition their markers where needed.'}};
function download(){const blob=new Blob([JSON.stringify(m,null,2)+'\\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=boot.manifestPath.split(/[\\/]/).pop();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}$('download').onclick=download;
function scheduleSave(delay=500){if(location.protocol==='file:')return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;void save()},delay)}
async function save(){clearTimeout(saveTimer);saveTimer=null;if(location.protocol==='file:'){download();status.textContent='Downloaded manifest. Use the local editor URL for autosave.';return false}if(savePromise){const okay=await savePromise;return okay?save():false}const snapshot=JSON.stringify(m);if(snapshot===saved){dirty();return true}const hash=savedHash;savePromise=(async()=>{try{const res=await fetch('/manifest?token='+encodeURIComponent(boot.token),{method:'POST',headers:{'Content-Type':'application/json','If-Match':hash},body:snapshot}),data=await res.json();if(!res.ok)throw Error(data.message||'Save failed');saved=snapshot;savedHash=data.hash;status.textContent='Autosaved. '+data.errors.length+' build errors, '+data.visualWarnings.length+' visual warnings.'+(data.htmlUpdateWarning?' Standalone HTML update: '+data.htmlUpdateWarning:'');return true}catch(err){status.textContent='Autosave failed: '+String(err);return false}})();dirty();const okay=await savePromise;savePromise=null;dirty();return okay&&JSON.stringify(m)!==saved?save():okay}$('save').onclick=()=>{void save()};
$('undo').onclick=undo;$('redo').onclick=redo;document.addEventListener('keydown',e=>{if(!(e.ctrlKey||e.metaKey)||e.altKey||e.key.toLowerCase()!=='z')return;if(e.target?.closest?.('input[type=text],textarea,[contenteditable=true]'))return;e.preventDefault();if(e.shiftKey)redo();else undo()});
$('build').onclick=async()=>{if(location.protocol==='file:'){download();status.textContent='Downloaded manifest. Use spine_build_rig_from_landmarks to build.';return}if(!(await save()))return;status.textContent='Building…';try{const res=await fetch('/build?token='+encodeURIComponent(boot.token),{method:'POST'}),data=await res.json();if(!res.ok)throw Error(data.message||'Build failed');status.textContent='Built '+data.outputDataPath+(data.outputProjectPath?' and '+data.outputProjectPath:'')}catch(err){status.textContent=String(err)}};
sync();if(boot.diagnostics.length)status.textContent=boot.diagnostics.slice(0,5).map(d=>d.code+': '+d.message).join('\\n')+(boot.diagnostics.length>5?'\\n… '+(boot.diagnostics.length-5)+' more diagnostics':'');if(JSON.stringify(m)!==saved)scheduleSave();})();
</script></body></html>`;
}

export async function startRigReview(input: { imagesDir: string; manifestPath?: string; outputDir: string; editorVersion: "4.2" | "4.3" }) {
  const imagesDir = resolve(input.imagesDir);
  const manifestPath = resolve(input.manifestPath ?? join(dirname(imagesDir), "rig-landmarks.json"));
  const outputDir = resolve(input.outputDir);
  const images = await inventoryImages(imagesDir);
  let manifest: RigManifest;
  if (await stat(manifestPath).catch(() => undefined)) manifest = await readRigManifest(manifestPath);
  else {
    manifest = await suggestRigManifest(imagesDir, manifestPath, input.editorVersion);
    await mkdir(dirname(manifestPath), { recursive: true });
    try { await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; manifest = await readRigManifest(manifestPath); }
  }
  if (manifest.spineVersion !== input.editorVersion) throw new SpineError("VERSION_MISMATCH", "Manifest Spine version and editor version differ.");
  if (imageDirectory(manifest, manifestPath) !== imagesDir) throw new SpineError("IMAGES_DIR_MISMATCH", "The existing manifest refers to a different images directory.");
  const token = randomBytes(24).toString("hex");
  const html = await reviewHtml(manifest, manifestPath, token);
  await mkdir(outputDir, { recursive: true });
  const htmlPath = join(outputDir, `rig-review-${randomUUID()}.html`);
  await writeFile(htmlPath, html, { flag: "wx" });
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    if (url.searchParams.get("token") !== token) { json(403, { message: "Invalid review session token." }); return; }
    if (request.method === "GET" && url.pathname === "/") {
      try {
        const current = await readRigManifest(manifestPath);
        const page = await reviewHtml(current, manifestPath, token);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(page);
      } catch (error) { json(500, { message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/manifest") {
      try {
        const current = await readRigManifest(manifestPath);
        const currentHash = sha(JSON.stringify(current));
        if (request.headers["if-match"] !== currentHash) { json(409, { message: "Manifest changed on disk. Reload before saving." }); return; }
        let raw = "";
        for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 4_000_000) throw new SpineError("MANIFEST_TOO_LARGE", "Manifest exceeds 4 MB."); }
        const next = JSON.parse(raw) as RigManifest;
        await checkRigDraftSources(current, next, manifestPath, true);
        const check = await validateRigManifest(next, manifestPath);
        const nextHash = await writeRigDraft(manifestPath, next, currentHash);
        let htmlUpdateWarning: string | undefined;
        try {
          const nextHtml = await reviewHtml(next, manifestPath, token);
          const tempHtml = join(outputDir, `.rig-review-${randomUUID()}.html`);
          try { await writeFile(tempHtml, nextHtml, { flag: "wx" }); await rename(tempHtml, htmlPath); }
          finally { await rm(tempHtml, { force: true }); }
        } catch (error) { htmlUpdateWarning = error instanceof Error ? error.message : String(error); }
        json(200, { manifestPath, hash: nextHash, errors: check.errors, visualWarnings: check.visualWarnings,
          ...(htmlUpdateWarning ? { htmlUpdateWarning } : {}) });
      } catch (error) { json(400, { message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/build") {
      try {
        const name = basename(manifestPath, ".json");
        const run = randomUUID();
        const result = await buildRigFromLandmarks({ manifestPath, outputDataPath: join(outputDir, `${name}-${run}.json`),
          outputProjectPath: join(outputDir, `${name}-${run}.spine`), editorVersion: input.editorVersion });
        json(200, result);
      } catch (error) { json(400, { message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    json(404, { message: "Unknown route." });
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { server.off("error", no); yes(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new SpineError("REVIEW_SERVER_FAILED", "Could not start review server.");
  server.unref();
  sessions.set(token, server);
  const validation = await validateRigManifest(manifest, manifestPath);
  return { url: `http://127.0.0.1:${address.port}/?token=${token}`, manifestPath, htmlPath, imageCount: images.length,
    manifest, sourceHash: sha(JSON.stringify(manifest)),
    diagnostics: validation.diagnostics,
    reviewStatus: validation.valid ? "ready_for_visual_preview" : "needs_assembly",
    nextAction: validation.valid ? RIG_READY_NEXT_ACTION : RIG_INCOMPLETE_NEXT_ACTION };
}
