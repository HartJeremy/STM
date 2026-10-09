const APP_VERSION = '0.6.0';
const DB_NAME = 'starcatcher-sm';
const DB_VERSION = 3;
const WORKSPACE_KEY = 'workspace-v5';
const LEGACY_SHOW_KEY = 'show';
const LEGACY_CHECK_KEY = 'checks';

let db;
let starterWorkspace;
let workspaceData;
let showData;
let checks = {};
let currentView = 'tonight';
let presetMode = '';
let manageTab = 'production';
let attendanceDate = localDateKey();
let runActFilter = 'ALL';
let runPersonFilter = 'ALL';
let runSearch = '';
let deferredPrompt = null;
let imageUrlCache = new Map();
let pendingImageAction = null;
let pendingPhotoPicker = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const now = () => new Date().toISOString();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function newUUID(){ return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16);}); }
function isUUID(value){ return UUID_RE.test(String(value||'')); }
function clone(value){ return JSON.parse(JSON.stringify(value)); }
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prettyDate(dateKey) {
  const [y,m,d] = dateKey.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}

function groupBy(rows, keyFn) {
  return rows.reduce((out, row) => {
    const k = keyFn(row) || 'Other';
    (out[k] ||= []).push(row);
    return out;
  }, {});
}


function slugify(s) {
  return String(s || 'production').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'production';
}
function sortedActs() { return (showData?.acts || []).slice().sort((a,b)=>Number(a.order||0)-Number(b.order||0)); }
function actName(id) { return sortedActs().find(a=>a.id===id)?.name || id || 'Unspecified'; }
function actOrder(id) { const i=sortedActs().findIndex(a=>a.id===id); return i<0?999:i; }
function actOptions(includeBlank=false) { const out=sortedActs().map(a=>[a.id,a.name]); if(includeBlank) out.push(['','Unspecified']); return out; }
function sortedLocations() { return (showData?.locations || []).filter(x=>x.active!==false).slice().sort((a,b)=>Number(a.order||0)-Number(b.order||0)||String(a.name).localeCompare(String(b.name))); }
function locationOptions() { return sortedLocations().map(x=>[x.id,x.name]); }
function locationById(id){ return (showData?.locations||[]).find(x=>x.id===id) || null; }
function locationIdByName(name){ const n=String(name||'').trim().toLowerCase(); return (showData?.locations||[]).find(x=>String(x.name||'').trim().toLowerCase()===n)?.id || ''; }
function locationName(id,fallback=''){ return locationById(id)?.name || fallback || 'Unassigned'; }
function presetLocationId(row){ return row?.locationId || locationIdByName(row?.area) || ''; }
function productionPropById(id){ return (showData?.props||[]).find(x=>x.id===id) || null; }
function productionPropName(id,fallback=''){ return productionPropById(id)?.name || fallback || 'Unnamed prop'; }
function productionById(id){ return (workspaceData?.productions||[]).find(p=>p.production?.id===id) || null; }
function globalPersonById(id){ return (workspaceData?.people||[]).find(p=>p.id===id) || null; }
function inventoryById(id){ return (workspaceData?.inventory||[]).find(a=>a.id===id) || null; }
function reservationForProp(propId,productionId=showData?.production?.id){ return (workspaceData?.reservations||[]).find(r=>r.productionId===productionId&&r.productionPropId===propId) || null; }
function activeProduction(){ return productionById(workspaceData?.activeProductionId) || workspaceData?.productions?.[0] || null; }
function setActiveRefs(){ showData=activeProduction(); if(!showData)return; checks=showData.checks ||= {}; presetMode=sortedActs().some(a=>a.id===presetMode)?presetMode:(sortedActs()[0]?.id||''); }

function ensureShowStructure(data) {
  data ||= {}; data.production ||= {};
  data.production.id ||= newUUID();
  data.production.title ||= 'Untitled Production'; data.production.company ||= '';
  data.production.startDate ||= ''; data.production.endDate ||= ''; data.production.status ||= 'active';
  for(const k of ['people','props','movements','presets']) if(!Array.isArray(data[k])) data[k]=[];
  if(!data.images || typeof data.images!=='object') data.images={act1:[],act2:[],custom:[]};
  data.images.act1 ||= []; data.images.act2 ||= []; data.images.custom ||= [];
  if(!data.areaPhotos || typeof data.areaPhotos!=='object' || Array.isArray(data.areaPhotos)) data.areaPhotos={};
  if(!data.attendance || typeof data.attendance!=='object' || Array.isArray(data.attendance)) data.attendance={};
  if(!data.checks || typeof data.checks!=='object' || Array.isArray(data.checks)) data.checks={};
  data.settings ||= {}; data.settings.attendanceStatuses=['waiting','here','late','missing','excused','notcalled'];
  if(!Array.isArray(data.acts) || !data.acts.length) data.acts=[{id:newUUID(),name:'Act I',order:1,notes:'Preshow preset',updatedAt:now()}];
  if(!Array.isArray(data.locations) || !data.locations.length) data.locations=['Stage Left','Stage Right','Center Stage','Onstage','Backstage'].map((name,i)=>({id:newUUID(),name,order:i+1,active:true,updatedAt:now()}));
  for(const a of data.acts) a.id ||= newUUID();
  for(const l of data.locations) l.id ||= newUUID();
  for(const p of data.props) { p.id ||= newUUID(); if(p.assetId===undefined)p.assetId=null; }
  for(const m of data.movements) m.id ||= newUUID();
  for(const p of data.presets) { p.id ||= newUUID(); p.locationId ||= data.locations.find(l=>l.name===p.area)?.id || ''; }
  for(const p of data.people) p.id ||= newUUID();
  for(const arr of Object.values(data.images)) for(const im of arr) im.id ||= newUUID();
  data.changeover=[]; data.schemaVersion=5; data.appVersion=APP_VERSION; return data;
}

function blankProduction(title,company,firstActName='Act I') {
  const pid=newUUID(), actId=newUUID();
  return ensureShowStructure({schemaVersion:5,appVersion:APP_VERSION,imageBundleVersion:'custom',production:{id:pid,title:title||'Untitled Production',company:company||'',startDate:'',endDate:'',status:'active',updatedAt:now(),dataAuthority:'Locally created production'},acts:[{id:actId,name:firstActName||'Act I',order:1,notes:'Preshow preset',updatedAt:now()}],locations:['Stage Left','Stage Right','Center Stage','Onstage','Backstage'].map((name,i)=>({id:newUUID(),name,order:i+1,active:true,updatedAt:now()})),people:[],props:[],movements:[],presets:[],images:{act1:[],act2:[],custom:[]},areaPhotos:{},attendance:{},checks:{},settings:{attendanceStatuses:['waiting','here','late','missing','excused','notcalled']}});
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getKV(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv','readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function setKV(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv','readwrite');
    const req = tx.objectStore('kv').put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getImageBlob(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images','readonly');
    const req = tx.objectStore('images').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function putImageBlob(id, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images','readwrite');
    const req = tx.objectStore('images').put(blob, id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteImageBlob(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images','readwrite');
    const req = tx.objectStore('images').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function allStoredImages() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images','readonly');
    const store = tx.objectStore('images');
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => {
      const out = {};
      (keysReq.result || []).forEach((k,i) => out[k] = valsReq.result[i]);
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

function overlayById(seedRows = [], localRows = []) {
  const local = new Map(localRows.map(x => [x.id, x]));
  const merged = seedRows.map(x => local.has(x.id) ? {...x, ...local.get(x.id)} : x);
  for (const row of localRows) if (!seedRows.some(s => s.id === row.id)) merged.push(row);
  return merged;
}

function mergeAreaPhotos(seed = {}, local = {}) {
  const out = {...seed};
  for (const [k,v] of Object.entries(local || {})) out[k] = {...(out[k] || {}), ...v};
  return out;
}

function ensureWorkspaceStructure(ws){
  ws ||= {}; ws.schemaVersion=5; ws.appVersion=APP_VERSION; ws.workspaceId ||= newUUID();
  ws.organization ||= {id:newUUID(),name:'Community Theatre',updatedAt:now()}; ws.organization.id ||= newUUID();
  if(!Array.isArray(ws.productions))ws.productions=[]; if(!Array.isArray(ws.people))ws.people=[]; if(!Array.isArray(ws.inventory))ws.inventory=[]; if(!Array.isArray(ws.reservations))ws.reservations=[];
  ws.productions=ws.productions.map(ensureShowStructure); for(const p of ws.people)p.id ||= newUUID(); for(const a of ws.inventory){a.id ||= newUUID();a.trackingMode ||= 'unique';a.quantity=Math.max(1,Number(a.quantity||1));} for(const r of ws.reservations)r.id ||= newUUID();
  if(!ws.activeProductionId || !ws.productions.some(p=>p.production.id===ws.activeProductionId))ws.activeProductionId=ws.productions[0]?.production.id||'';
  ws.updatedAt=now(); return ws;
}

function seedMatchByLegacy(seedRows,oldId){ return (seedRows||[]).find(x=>x.legacyId===oldId || x.id===oldId) || null; }
function globalPersonForName(name, preferredId=''){
  const key=String(name||'').trim().toLowerCase(); let person=(workspaceData?.people||[]).find(x=>x.id===preferredId) || (workspaceData?.people||[]).find(x=>String(x.name||'').trim().toLowerCase()===key);
  if(!person){ person={id:preferredId&&isUUID(preferredId)?preferredId:newUUID(),name:String(name||'').trim(),notes:'',active:true,updatedAt:now()}; workspaceData.people.push(person); }
  return person;
}

async function upgradeLegacyProduction(local, legacyChecks={}, seedProd=null){
  local=clone(local||{}); const seed=seedProd && (local.production?.id===seedProd.production?.legacyId || local.production?.title===seedProd.production?.title) ? seedProd : null;
  const prodId=seed?.production?.id || (isUUID(local.production?.id)?local.production.id:newUUID());
  const out=clone(local); out.production={...(seed?.production||{}),...(local.production||{}),id:prodId,legacyId:local.production?.legacyId||local.production?.id||'',startDate:local.production?.startDate||'',endDate:local.production?.endDate||'',status:local.production?.status||'active'};
  const maps={act:new Map(),loc:new Map(),prop:new Map(),assignment:new Map(),preset:new Map(),image:new Map()};
  const upgrade=(rows,seedRows,map,kind)=> (rows||[]).map(row=>{const sr=seedMatchByLegacy(seedRows,row.id);const id=sr?.id || (isUUID(row.id)?row.id:newUUID());map.set(row.id,id);return {...(sr||{}),...row,id,legacyId:row.legacyId||row.id||'',updatedAt:row.updatedAt||now()};});
  out.acts=upgrade(local.acts,seed?.acts,maps.act,'act');
  out.locations=upgrade(local.locations,seed?.locations,maps.loc,'location');
  out.props=upgrade(local.props,seed?.props,maps.prop,'prop').map(x=>({...x,assetId:x.assetId||null}));
  const locByName=new Map(out.locations.map(x=>[String(x.name||'').trim().toLowerCase(),x.id]));
  // People are production assignments that point to one workspace-level person UUID.
  out.people=upgrade(local.people,seed?.people,maps.assignment,'assignment').map(x=>{const seeded=seedMatchByLegacy(seed?.people,x.legacyId);const gp=globalPersonForName(x.name,seeded?.personId||x.personId||'');return {...x,personId:gp.id,name:gp.name};});
  out.movements=upgrade(local.movements,seed?.movements,new Map(),'movement').map(x=>({...x,propId:maps.prop.get(x.propId)||x.propId||'',act:maps.act.get(x.act)||x.act||'',fromLocationId:x.fromLocationId||locByName.get(String(x.from||'').trim().toLowerCase())||'',toLocationId:x.toLocationId||locByName.get(String(x.to||'').trim().toLowerCase())||''}));
  out.presets=upgrade(local.presets,seed?.presets,maps.preset,'preset').map(x=>({...x,propId:maps.prop.get(x.propId)||x.propId||'',act:maps.act.get(x.act)||x.act||'',locationId:x.locationId&&maps.loc.get(x.locationId)?maps.loc.get(x.locationId):(x.locationId||locByName.get(String(x.area||'').trim().toLowerCase())||'')}));
  out.images={act1:[],act2:[],custom:[]};
  for(const bucket of ['act1','act2','custom']) out.images[bucket]=upgrade(local.images?.[bucket],seed?.images?.[bucket],maps.image,'image').map(x=>({...x,scope:maps.act.get(x.scope)||x.scope||''}));
  const areaPhotos={};
  for(const [oldKey,rec0] of Object.entries(local.areaPhotos||{})){const rec=clone(rec0),act=maps.act.get(rec.act)||rec.act||'',loc=rec.locationId&&maps.loc.get(rec.locationId)?maps.loc.get(rec.locationId):(rec.locationId||locByName.get(String(rec.area||'').trim().toLowerCase())||'');if(!act||!loc)continue;const sr=seed?.areaPhotos?.[`${act}::${loc}`];areaPhotos[`${act}::${loc}`]={...(sr||{}),...rec,id:sr?.id||(isUUID(rec.id)?rec.id:newUUID()),act,actId:act,locationId:loc,imageRefs:(rec.imageRefs||[]).map(id=>maps.image.get(id)||id),updatedAt:rec.updatedAt||now()};}
  out.areaPhotos=areaPhotos;
  out.attendance={}; for(const [date,bucket] of Object.entries(local.attendance||{})){out.attendance[date]={};for(const [pid,status] of Object.entries(bucket||{}))out.attendance[date][maps.assignment.get(pid)||pid]=status;}
  out.checks={}; const legacy=legacyChecks&&Object.values(legacyChecks).some(v=>typeof v==='boolean')?{[localDateKey()]:legacyChecks}:legacyChecks||{};for(const [date,bucket] of Object.entries(legacy)){out.checks[date]={};for(const [id,val] of Object.entries(bucket||{}))out.checks[date][maps.preset.get(id)||id]=!!val;}
  out.schemaVersion=5;out.appVersion=APP_VERSION; return {production:ensureShowStructure(out),imageIdMap:maps.image};
}

async function migrateLegacyWorkspace(legacy,legacyChecks,seedWs){
  workspaceData=ensureWorkspaceStructure(clone(seedWs)); workspaceData.productions=[]; workspaceData.people=[]; workspaceData.inventory=[]; workspaceData.reservations=[];
  const seedProd=seedWs.productions?.[0]||null; const migrated=await upgradeLegacyProduction(legacy,legacyChecks,seedProd); workspaceData.productions=[migrated.production]; workspaceData.activeProductionId=migrated.production.production.id;
  // Preserve locally replaced/uploaded images under their new UUID keys.
  for(const [oldId,newId] of migrated.imageIdMap.entries()){if(oldId===newId)continue;const blob=await getImageBlob(oldId);if(blob)await putImageBlob(newId,blob);}
  return ensureWorkspaceStructure(workspaceData);
}

function mergeImageMeta(a = {}, b = {}) {
  return {
    act1: mergeById(a.act1 || [], b.act1 || []),
    act2: mergeById(a.act2 || [], b.act2 || []),
    custom: mergeById(a.custom || [], b.custom || [])
  };
}

async function init() {
  db=await openDB(); starterWorkspace=ensureWorkspaceStructure(await (await fetch('data/seed-workspace.json',{cache:'no-store'})).json());
  workspaceData=await getKV(WORKSPACE_KEY);
  if(!workspaceData){
    const legacy=await getKV(LEGACY_SHOW_KEY), legacyChecks=await getKV(LEGACY_CHECK_KEY)||{};
    workspaceData=legacy ? await migrateLegacyWorkspace(legacy,legacyChecks,starterWorkspace) : clone(starterWorkspace);
    await setKV(WORKSPACE_KEY,workspaceData);
  } else workspaceData=ensureWorkspaceStructure(workspaceData);
  setActiveRefs(); if(!showData){workspaceData=clone(starterWorkspace);setActiveRefs();await setKV(WORKSPACE_KEY,workspaceData);}
  $('#productionTitle').textContent=showData.production?.title||'Stage Manager'; bindShell(); route('tonight'); registerSW();
}

function bindShell() {
  $$('.navbtn').forEach(btn => btn.addEventListener('click', () => route(btn.dataset.view)));
  $('#closePhoto').addEventListener('click', () => $('#photoDialog').close());
  $('#photoDialog').addEventListener('click', e => { if (e.target === $('#photoDialog')) $('#photoDialog').close(); });
  $('#closeForm').addEventListener('click', () => $('#formDialog').close());
  $('#cancelEdit').addEventListener('click', () => $('#formDialog').close());
  $('#closePhotoPicker').addEventListener('click', () => $('#photoPickerDialog').close());
  $('#cancelPhotoPicker').addEventListener('click', () => $('#photoPickerDialog').close());
  $('#savePhotoPicker').addEventListener('click', savePhotoPicker);
  $('#uploadFromPicker').addEventListener('click', () => {
    if (!pendingPhotoPicker) return;
    pendingImageAction = {type:'add', scope:pendingPhotoPicker.act, reopenPicker:true};
    chooseImageFile();
  });
  $('#imageFile').addEventListener('change', handleImageFile);
  $('#importFile').addEventListener('change', handleImportFile);

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn').hidden = true;
  });
}

function setPageTitle(title) {
  $('#pageTitle').textContent = title;
}

function route(view) {
  currentView=view; $$('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if(view==='tonight')renderTonight(); else if(view==='presets')renderPresets(); else if(view==='run')renderRun(); else if(view==='checkin')renderCheckin(); else if(view==='shows')renderShows(); else if(view==='manage')renderManage(); else renderTonight();
  window.scrollTo({top:0,behavior:'auto'});
}

function nightChecks(date=localDateKey()){ checks=showData.checks ||= {}; checks[date] ||= {}; return checks[date]; }

function isChecked(id, date = localDateKey()) {
  return !!nightChecks(date)[id];
}

async function setChecked(id,value,date=localDateKey()){ nightChecks(date)[id]=!!value; await saveWorkspace(); }

function checklistStats(rows, date = localDateKey()) {
  return {done: rows.filter(x => isChecked(x.id, date)).length, total: rows.length};
}

function progressHTML(done,total) {
  const pct = total ? Math.round(done/total*100) : 0;
  return `<div class="progressline"><div class="progress"><span style="width:${pct}%"></span></div><small>${done}/${total} · ${pct}%</small></div>`;
}

function currentAttendance(date = attendanceDate) {
  showData.attendance[date] ||= {};
  return showData.attendance[date];
}

function attendanceStatus(personId, date = attendanceDate) {
  return currentAttendance(date)[personId] || 'waiting';
}

function attendanceSummary(date = attendanceDate) {
  const people = (showData.people || []).filter(p => p.active !== false);
  const statuses = people.map(p => attendanceStatus(p.id,date));
  const stillNeed = people.filter(p => attendanceStatus(p.id,date) === 'waiting');
  const missing = people.filter(p => attendanceStatus(p.id,date) === 'missing');
  const here = statuses.filter(s => s === 'here' || s === 'late').length;
  const accounted = statuses.filter(s => s !== 'waiting').length;
  return {people, stillNeed, missing, here, accounted, total:people.length};
}

function renderTonight() {
  setPageTitle('Tonight'); const date=localDateKey(),attendance=attendanceSummary(date),acts=sortedActs();
  const stats=acts.map(a=>({act:a,stats:checklistStats(showData.presets.filter(x=>x.act===a.id),date)}));
  const needed=attendance.stillNeed.length?attendance.stillNeed.slice(0,4).map(p=>p.name.split(' ')[0]).join(', ')+(attendance.stillNeed.length>4?` +${attendance.stillNeed.length-4}`:''):'Everyone accounted for';
  const conflicts=workspaceConflicts().filter(c=>c.productionIds.includes(showData.production.id));
  $('#view').innerHTML=`<div class="toolbar"><div><div class="eyebrow">${esc(prettyDate(date))}</div><div class="smalltext muted">${esc(showData.production.company||'')}</div></div><span class="spacer"></span><button id="switchShow" class="btn secondary compact">Productions (${workspaceData.productions.length})</button></div>${conflicts.length?`<div class="notice"><strong>${conflicts.length} shared-asset conflict${conflicts.length===1?'':'s'}</strong><div class="smalltext">Resolve under Manage → Inventory.</div></div>`:''}<div class="summary-grid"><div class="summary-tile"><strong>${attendance.accounted}/${attendance.total}</strong><span>People accounted for</span></div>${stats.map(({act,stats},i)=>`<div class="summary-tile"><strong>${stats.done}/${stats.total}</strong><span>${esc(act.name)} ${i===0?'preshow':'setup'}</span></div>`).join('')}</div><div class="${attendance.stillNeed.length||attendance.missing.length?'needed':'needed good'}"><strong>${attendance.stillNeed.length?`${attendance.stillNeed.length} still need check-in`:'Cast & crew accounted for'}</strong><div class="smalltext">${esc(needed)}${attendance.missing.length?` · Missing: ${esc(attendance.missing.map(p=>p.name.split(' ')[0]).join(', '))}`:''}</div></div><div class="flow">${flowCard('checkin','Check-in','Cast and stage crew',attendance.stillNeed.length?`${attendance.stillNeed.length} waiting`:'Complete',!attendance.stillNeed.length)}${stats.map(({act,stats},i)=>flowCard('presets',act.name,i===0?'Preshow preset':`Setup before ${act.name}`,stats.total?`${stats.done}/${stats.total}`:'No items',stats.total>0&&stats.done===stats.total,act.id)).join('')}${flowCard('run','Run track','Search prop, person, page, cue or location',`${showData.movements.length} entries`,true)}${flowCard('manage','Manage production','Production, locations, props, inventory and photos','Edit',true)}</div>`;
  $('#switchShow').addEventListener('click',()=>route('shows')); $$('[data-flow]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.presetMode)presetMode=b.dataset.presetMode;route(b.dataset.flow);}));
}

function flowCard(view,title,sub,badge,good,preset='') {
  return `<button class="flow-card ${good?'good':'warn'}" data-flow="${view}" ${preset?`data-preset-mode="${preset}"`:''}><span><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="flow-badge">${esc(badge)} ›</span></button>`;
}

function renderPresets() {
  setPageTitle('Presets'); const acts=sortedActs(); if(!acts.some(a=>a.id===presetMode))presetMode=acts[0]?.id||'';
  $('#view').innerHTML=`<div class="segmented act-segments">${acts.map(a=>`<button class="segment-btn ${presetMode===a.id?'active':''}" data-preset-tab="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div><div id="presetBody"></div>`;
  $$('[data-preset-tab]').forEach(b=>b.addEventListener('click',()=>{presetMode=b.dataset.presetTab;renderPresets();})); if(presetMode)renderPresetBody(presetMode);else $('#presetBody').innerHTML='<div class="empty">Add an act under Manage → Production.</div>';
}

function renderPresetBody(actId) {
  const acts=sortedActs(),idx=acts.findIndex(a=>a.id===actId),act=acts[idx]||{name:actId},rows=showData.presets.filter(x=>x.act===actId),stats=checklistStats(rows),groups=groupBy(rows,x=>presetLocationId(x)||'unassigned');
  const intro=idx<=0?'Target state before the show starts.':`Target state before ${act.name}. Complete this during the break/changeover from ${acts[idx-1]?.name||'the previous act'}.`;
  const body=$('#presetBody');body.innerHTML=`<div class="notice oknotice"><strong>${esc(act.name)} setup</strong><div class="smalltext">${esc(intro)}</div></div><div class="toolbar"><div><div class="eyebrow">${esc(act.name)}</div>${progressHTML(stats.done,stats.total)}</div><span class="spacer"></span><button class="btn secondary compact" id="resetPreset">Reset tonight</button></div>${Object.keys(groups).length?Object.entries(groups).map(([locId,items],i)=>renderLocationCard(actId,locId,items,i===0)).join(''):'<div class="empty">No preset items yet. Add them under Manage → Presets.</div>'}`;bindPresetBodyEvents(actId,rows);hydrateImages(body);
}

function renderLocationCard(act,locationId,items,open=false){const done=items.filter(i=>isChecked(i.id)).length,refs=getAreaImageRefs(act,locationId),label=locationName(locationId,items[0]?.area||'Unassigned');return `<details class="location-card" ${open?'open':''}><summary><span><strong>${esc(label)}</strong><small>${done}/${items.length} checked</small></span><span>${done===items.length?'✓':'›'}</span></summary><div class="location-body">${refs.length?photoStrip(refs):'<div class="smalltext muted" style="padding-top:10px">No reference photo assigned.</div>'}${items.map(item=>`<label class="checkrow ${isChecked(item.id)?'done':''}"><input type="checkbox" data-check="${esc(item.id)}" ${isChecked(item.id)?'checked':''}><span class="check-main"><strong>${esc(item.item)}</strong>${item.notes?`<div class="check-note">${esc(item.notes)}</div>`:''}</span>${item.critical?'<span class="tag critical">critical</span>':''}</label>`).join('')}</div></details>`;}

function bindPresetBodyEvents(act,rows){$$('[data-check]').forEach(box=>box.addEventListener('change',async()=>{await setChecked(box.dataset.check,box.checked);const row=box.closest('.checkrow');row?.classList.toggle('done',box.checked);const card=box.closest('.location-card');if(card){const all=$$('[data-check]',card),done=all.filter(x=>x.checked).length,small=$('summary small',card);if(small)small.textContent=`${done}/${all.length} checked`;}}));bindPhotoButtons();$('#resetPreset')?.addEventListener('click',async()=>{if(!confirm(`Reset this preset for tonight?`))return;const bucket=nightChecks();rows.forEach(x=>delete bucket[x.id]);await saveWorkspace();renderPresets();});}

function allImageMeta() {
  return [...(showData.images.act1||[]), ...(showData.images.act2||[]), ...(showData.images.custom||[])];
}

function imageMeta(id) {
  return allImageMeta().find(x => x.id === id) || null;
}

function getAreaImageRefs(act,locationId){const key=`${act}::${locationId}`;return (showData.areaPhotos?.[key]?.imageRefs||[]).filter(id=>imageMeta(id));}

function photoStrip(ids) {
  return `<div class="section-photo-strip">${ids.map(id => {
    const meta = imageMeta(id);
    if (!meta) return '';
    return `<button type="button" class="photo-thumb" data-photo-id="${esc(id)}"><img data-image-id="${esc(id)}" ${meta.src?`src="${esc(meta.src)}"`:''} alt="${esc(meta.label||'Reference photo')}"><span>${esc(meta.label||id)}</span></button>`;
  }).join('')}</div>`;
}

async function resolveImageUrl(id) {
  if (imageUrlCache.has(id)) return imageUrlCache.get(id);
  const blob = await getImageBlob(id);
  if (blob) {
    const url = URL.createObjectURL(blob);
    imageUrlCache.set(id,url);
    return url;
  }
  return imageMeta(id)?.src || '';
}

async function hydrateImages(root = document) {
  for (const img of $$('img[data-image-id]',root)) {
    const id = img.dataset.imageId;
    const url = await resolveImageUrl(id);
    if (url) img.src = url;
  }
}

function bindPhotoButtons(root = document) {
  $$('[data-photo-id]',root).forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.photoId;
    const meta = imageMeta(id);
    $('#photoCaption').textContent = meta?.label || 'Reference photo';
    $('#photoFull').src = await resolveImageUrl(id);
    $('#photoDialog').showModal();
  }));
}

function movementSort(a,b) { const aa=actOrder(a.act),bb=actOrder(b.act);if(aa!==bb)return aa-bb;const pa=Number(String(a.page||'').match(/\d+/)?.[0]||9999),pb=Number(String(b.page||'').match(/\d+/)?.[0]||9999);if(pa!==pb)return pa-pb;return Number(a.order||0)-Number(b.order||0); }

function renderRun() {
  setPageTitle('Run Track'); const people=[...new Set((showData.movements||[]).flatMap(x=>(x.person||'').split(/,|\//).map(s=>s.trim()).filter(Boolean)))].sort(),rows=(showData.movements||[]).slice().sort(movementSort),acts=sortedActs();if(runActFilter!=='ALL'&&!acts.some(a=>a.id===runActFilter))runActFilter='ALL';
  $('#view').innerHTML=`<div class="run-controls"><div class="search-wrap"><input id="runSearch" class="searchbar" autocomplete="off" inputmode="search" placeholder="Search prop, person, page, cue, location…" value="${esc(runSearch)}"><button id="clearSearch" class="btn secondary compact" ${runSearch?'':'hidden'}>Clear</button></div><div class="filterrow"><button class="chip ${runActFilter==='ALL'?'active':''}" data-run-act="ALL">All</button>${acts.map(a=>`<button class="chip ${runActFilter===a.id?'active':''}" data-run-act="${esc(a.id)}">${esc(a.name)}</button>`).join('')}<select id="runPerson" class="select-compact"><option value="ALL">All people</option>${people.map(p=>`<option value="${esc(p)}" ${runPersonFilter===p?'selected':''}>${esc(p)}</option>`).join('')}</select></div><div id="resultsCount" class="results-count"></div></div><div id="runResults">${rows.map(renderMoveCard).join('')}</div>`;
  const input=$('#runSearch');input.addEventListener('input',()=>{runSearch=input.value;$('#clearSearch').hidden=!runSearch;applyRunFilter();});$('#clearSearch').addEventListener('click',()=>{runSearch='';input.value='';$('#clearSearch').hidden=true;input.focus();applyRunFilter();});$$('[data-run-act]').forEach(btn=>btn.addEventListener('click',()=>{runActFilter=btn.dataset.runAct;$$('[data-run-act]').forEach(x=>x.classList.toggle('active',x===btn));applyRunFilter();}));$('#runPerson').addEventListener('change',e=>{runPersonFilter=e.target.value;applyRunFilter();});applyRunFilter();
}

function renderMoveCard(m){const prop=productionPropName(m.propId,m.propName),from=m.fromLocationId?locationName(m.fromLocationId,m.from):m.from,to=m.toLocationId?locationName(m.toLocationId,m.to):m.to,search=[prop,actName(m.act),m.scene,m.page,m.person,from,to,m.cue,m.notes].join(' ').toLowerCase();return `<article class="move-card ${m.review?'review':''}" data-run-row data-act="${esc(m.act||'')}" data-person="${esc((m.person||'').toLowerCase())}" data-search="${esc(search)}"><div class="move-head"><strong>${esc(prop)}</strong><span class="move-loc">${m.act?esc(actName(m.act)):''}${m.page?` · p${esc(m.page)}`:''}</span></div>${m.cue?`<div class="move-cue">${esc(m.cue)}</div>`:''}<div class="move-meta">${m.scene?`<span>Scene ${esc(m.scene)}</span>`:''}${m.person?`<span><b>${esc(m.person)}</b></span>`:''}${from||to?`<span class="move-route">${esc(from||'—')} → ${esc(to||'—')}</span>`:''}${m.review?'<span class="tag review">review</span>':''}</div></article>`;}

function applyRunFilter() {
  const q = runSearch.trim().toLowerCase();
  let visible = 0;
  $$('[data-run-row]').forEach(row => {
    const actOK = runActFilter === 'ALL' || row.dataset.act === runActFilter;
    const personOK = runPersonFilter === 'ALL' || row.dataset.person.includes(runPersonFilter.toLowerCase());
    const searchOK = !q || row.dataset.search.includes(q);
    const show = actOK && personOK && searchOK;
    row.hidden = !show;
    if (show) visible++;
  });
  $('#resultsCount').textContent = `${visible} matching ${visible===1?'entry':'entries'}`;
}

function renderCheckin() {
  setPageTitle('Check-in');
  const summary = attendanceSummary(attendanceDate);
  const groups = {
    cast: summary.people.filter(p => p.group === 'cast'),
    crew: summary.people.filter(p => p.group !== 'cast')
  };
  const waitingNames = summary.stillNeed.map(p => p.name).join(', ');
  const missingNames = summary.missing.map(p => p.name).join(', ');
  $('#view').innerHTML = `
    <div class="attendance-head">
      <div><div class="eyebrow">Nightly company check</div><h2 style="margin:.15rem 0 0">${summary.accounted}/${summary.total} accounted for</h2></div>
      <div class="datefield"><label for="attendanceDate">Date</label><input id="attendanceDate" type="date" value="${esc(attendanceDate)}"></div>
    </div>
    <div class="${summary.stillNeed.length||summary.missing.length?'needed':'needed good'}">
      ${summary.stillNeed.length?`<div><strong>Still need (${summary.stillNeed.length}):</strong> ${esc(waitingNames)}</div>`:'<div><strong>No one still waiting.</strong></div>'}
      ${summary.missing.length?`<div style="margin-top:4px"><strong>Marked missing:</strong> ${esc(missingNames)}</div>`:''}
    </div>
    <div class="toolbar"><button id="resetAttendance" class="btn secondary compact">Reset this date</button><span class="spacer"></span><button id="managePeople" class="btn secondary compact">Edit roster</button></div>
    ${attendanceGroupHTML('Cast',groups.cast)}
    ${attendanceGroupHTML('Stage crew',groups.crew)}`;

  $('#attendanceDate').addEventListener('change', e => {attendanceDate=e.target.value||localDateKey();renderCheckin();});
  $('#resetAttendance').addEventListener('click', async () => {
    if (!confirm(`Reset all check-ins for ${prettyDate(attendanceDate)}?`)) return;
    showData.attendance[attendanceDate] = {};
    await saveShow();
    renderCheckin();
  });
  $('#managePeople').addEventListener('click',()=>{manageTab='people';route('manage');});
  bindAttendanceRows();
}

function attendanceGroupHTML(label, people) {
  const accounted = people.filter(p => attendanceStatus(p.id)!=='waiting').length;
  return `<section class="attendance-group"><h3><span>${esc(label)}</span><span class="muted">${accounted}/${people.length}</span></h3>${people.length?people.map(attendanceRowHTML).join(''):'<div class="empty">No people in this group yet.</div>'}</section>`;
}

function attendanceRowHTML(p) {
  const status = attendanceStatus(p.id);
  const icon = status === 'here' ? '✓' : status === 'late' ? 'L' : status === 'missing' ? '!' : status === 'excused' ? 'E' : status === 'notcalled' ? '—' : '○';
  return `<div class="attendance-row ${esc(status)}" data-att-row="${esc(p.id)}">
    <button class="arrival-btn" type="button" data-arrive="${esc(p.id)}" aria-label="Toggle ${esc(p.name)} here">${icon}</button>
    <div><div class="person-name">${esc(p.name)}</div><div class="person-role">${esc(p.role||'')}</div></div>
    <select class="status-select" data-status="${esc(p.id)}">
      ${[['waiting','Waiting'],['here','Here'],['late','Late'],['missing','Missing'],['excused','Excused'],['notcalled','Not called']].map(([v,l])=>`<option value="${v}" ${status===v?'selected':''}>${l}</option>`).join('')}
    </select>
  </div>`;
}

function bindAttendanceRows() {
  $$('[data-arrive]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.arrive;
    const status = attendanceStatus(id);
    currentAttendance()[id] = status === 'here' ? 'waiting' : 'here';
    await saveShow();
    renderCheckin();
  }));
  $$('[data-status]').forEach(sel => sel.addEventListener('change', async () => {
    currentAttendance()[sel.dataset.status] = sel.value;
    await saveShow();
    renderCheckin();
  }));
}


function parseDateDay(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return null;const [y,m,d]=value.split('-').map(Number);return Math.floor(Date.UTC(y,m-1,d)/86400000);}
function dayToDate(day){const d=new Date(day*86400000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function effectiveReservationRange(r){const prod=productionById(r.productionId),start=r.startDate||prod?.production?.startDate||'',end=r.endDate||prod?.production?.endDate||'';return {start,end,startDay:parseDateDay(start),endDay:parseDateDay(end)};}
function assetConflictWindows(asset){const cap=asset.trackingMode==='bulk'?Math.max(1,Number(asset.quantity||1)):1,rows=(workspaceData.reservations||[]).filter(r=>r.assetId===asset.id).map(r=>({...r,range:effectiveReservationRange(r)})).filter(r=>r.range.startDay!==null&&r.range.endDay!==null&&r.range.endDay>=r.range.startDay),bounds=[...new Set(rows.flatMap(r=>[r.range.startDay,r.range.endDay+1]))].sort((a,b)=>a-b),out=[];for(let i=0;i<bounds.length-1;i++){const start=bounds[i],end=bounds[i+1]-1,active=rows.filter(r=>r.range.startDay<=start&&r.range.endDay>=start),required=active.reduce((n,r)=>n+Math.max(1,Number(r.quantity||1)),0);if(required>cap){const productionIds=[...new Set(active.map(r=>r.productionId))];out.push({id:`${asset.id}:${start}`,assetId:asset.id,assetName:asset.name,startDate:dayToDate(start),endDate:dayToDate(end),required,capacity:cap,productionIds,reservationIds:active.map(r=>r.id)});}}return out;}
function workspaceConflicts(){return (workspaceData.inventory||[]).flatMap(assetConflictWindows);}
function reservationHasConflict(res){return !!res&&workspaceConflicts().some(c=>c.reservationIds.includes(res.id));}
function productionConflictCount(productionId){return workspaceConflicts().filter(c=>c.productionIds.includes(productionId)).length;}

async function switchProduction(id){if(!productionById(id))return;workspaceData.activeProductionId=id;setActiveRefs();runActFilter='ALL';runPersonFilter='ALL';runSearch='';attendanceDate=localDateKey();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;route('tonight');}
async function deleteProduction(id){const prod=productionById(id);if(!prod||workspaceData.productions.length<=1)return;if(!confirm(`Delete ${prod.production.title}? This removes its local production data and reservations.`))return;workspaceData.productions=workspaceData.productions.filter(p=>p.production.id!==id);workspaceData.reservations=workspaceData.reservations.filter(r=>r.productionId!==id);if(workspaceData.activeProductionId===id)workspaceData.activeProductionId=workspaceData.productions[0].production.id;setActiveRefs();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;renderShows();}
function renderShows(){setPageTitle('Productions');const conflicts=workspaceConflicts();$('#view').innerHTML=`<div class="toolbar"><div><div class="eyebrow">Workspace</div><h2>${workspaceData.productions.length} production${workspaceData.productions.length===1?'':'s'}</h2></div><span class="spacer"></span><button id="newShow" class="btn primary compact">+ Production</button></div>${conflicts.length?`<div class="notice"><strong>${conflicts.length} shared-asset conflict window${conflicts.length===1?'':'s'}</strong><div class="smalltext">Open Manage → Inventory for details.</div></div>`:''}<div class="production-grid">${workspaceData.productions.slice().sort((a,b)=>(a.production.startDate||'9999').localeCompare(b.production.startDate||'9999')||a.production.title.localeCompare(b.production.title)).map(prod=>{const id=prod.production.id,active=id===workspaceData.activeProductionId,cc=productionConflictCount(id),people=(prod.people||[]).filter(p=>p.active!==false).length;return `<article class="production-card ${active?'active':''}"><div class="production-card-head"><div><div class="eyebrow">${esc(prod.production.status||'active')}</div><h3>${esc(prod.production.title)}</h3><div class="smalltext muted">${esc(prod.production.company||'')}</div></div>${active?'<span class="tag critical">open</span>':''}</div><div class="production-metrics"><span>${(prod.acts||[]).length} act${(prod.acts||[]).length===1?'':'s'}</span><span>${people} people</span><span class="${cc?'conflict-text':''}">${cc?`${cc} conflict${cc===1?'':'s'}`:'No conflicts'}</span></div><div class="smalltext muted">${prod.production.startDate||prod.production.endDate?`${esc(prod.production.startDate||'…')} → ${esc(prod.production.endDate||'…')}`:'Dates not set'}</div><div class="row-actions" style="margin-top:12px"><button class="btn ${active?'secondary':'primary'} compact" data-open-show="${id}">${active?'Open':'Switch to show'}</button>${workspaceData.productions.length>1?`<button class="mini-btn" data-delete-show="${id}">Delete</button>`:''}</div></article>`;}).join('')}</div>`;$('#newShow').addEventListener('click',startNewProduction);$$('[data-open-show]').forEach(b=>b.addEventListener('click',()=>switchProduction(b.dataset.openShow)));$$('[data-delete-show]').forEach(b=>b.addEventListener('click',()=>deleteProduction(b.dataset.deleteShow)));}

function renderManageInventory(){const conflicts=workspaceConflicts(),assets=(workspaceData.inventory||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));manageBody(`<div class="toolbar"><button id="addAsset" class="btn primary compact">+ Shared asset</button></div>${conflicts.length?`<section class="manage-section conflict-section"><div class="manage-section-head"><strong>Conflicts</strong><span class="tag review">${conflicts.length}</span></div>${conflicts.map(c=>`<div class="listrow"><div><div class="listrow-title">${esc(c.assetName)}</div><div class="listrow-meta">${esc(c.startDate)} → ${esc(c.endDate)} · need ${c.required}, have ${c.capacity} · ${esc(c.productionIds.map(id=>productionById(id)?.production?.title||'Unknown').join(' + '))}</div></div></div>`).join('')}</section>`:'<div class="notice oknotice"><strong>No shared-asset conflicts found.</strong><div class="smalltext">Conflict checks require reservation dates.</div></div>'}<section class="manage-section"><div class="manage-section-head"><strong>Shared inventory</strong><span class="muted smalltext">${assets.length}</span></div>${assets.length?assets.map(asset=>{const rs=(workspaceData.reservations||[]).filter(r=>r.assetId===asset.id),cc=assetConflictWindows(asset).length;return `<div class="listrow"><div><div class="listrow-title">${esc(asset.name)}</div><div class="listrow-meta">${asset.trackingMode==='bulk'?`Bulk · qty ${asset.quantity}`:'Unique physical item'} · ID ${esc(asset.id.slice(0,8))} · ${rs.length} reservation${rs.length===1?'':'s'}${cc?` · ${cc} CONFLICT`:''}</div>${rs.length?`<div class="smalltext muted">${rs.map(r=>`${esc(productionById(r.productionId)?.production?.title||'Unknown')}: ${esc(r.startDate||'no start')} → ${esc(r.endDate||'no end')}${asset.trackingMode==='bulk'?` · qty ${r.quantity}`:''}`).join('<br>')}</div>`:''}</div><div class="row-actions"><button class="mini-btn" data-edit-asset="${asset.id}">Edit</button><button class="mini-btn" data-del-asset="${asset.id}">Delete</button></div></div>`;}).join(''):'<div class="empty">No shared inventory yet. Add reusable props, furniture, scenic pieces, costumes or equipment here.</div>'}</section>`);$('#addAsset').addEventListener('click',()=>openAssetForm());$$('[data-edit-asset]').forEach(b=>b.addEventListener('click',()=>openAssetForm(inventoryById(b.dataset.editAsset))));$$('[data-del-asset]').forEach(b=>b.addEventListener('click',()=>deleteAsset(b.dataset.delAsset)));}
function openAssetForm(asset={}){openForm(asset.id?'Edit shared asset':'Add shared asset',[['name','Asset name','text',asset.name||''],['category','Category','select',asset.category||'prop',[['prop','Prop'],['scenic','Set / scenic'],['furniture','Furniture'],['costume','Costume'],['equipment','Equipment'],['other','Other']]],['trackingMode','Tracking','select',asset.trackingMode||'unique',[['unique','Unique physical item'],['bulk','Bulk / quantity pool']]],['quantity','Total quantity','number',String(asset.quantity||1)],['notes','Notes / identifying marks','textarea',asset.notes||''],['active','Active inventory','checkbox',asset.active!==false]],async vals=>{if(!vals.name.trim())throw new Error('Asset name is required.');const mode=vals.trackingMode,qty=mode==='unique'?1:Math.max(1,Number(vals.quantity||1)),data={name:vals.name.trim(),category:vals.category,trackingMode:mode,quantity:qty,notes:vals.notes,active:vals.active,updatedAt:now()};if(asset.id)Object.assign(asset,data);else workspaceData.inventory.push({id:newUUID(),...data});await saveWorkspace();renderManage();});}
async function deleteAsset(id){const asset=inventoryById(id);if(!asset)return;const rs=(workspaceData.reservations||[]).filter(r=>r.assetId===id);if(rs.length){alert(`${asset.name} has ${rs.length} production reservation(s). Unlink those production props first.`);return;}if(!confirm(`Delete shared asset ${asset.name}?`))return;workspaceData.inventory=workspaceData.inventory.filter(a=>a.id!==id);await saveWorkspace();renderManage();}

async function getSupabaseStatus(){
  const client=window.supabaseClient;
  if(!client)return {ok:false,message:'Supabase client is not available. Check your connection and configuration.'};
  try{
    const {data,error}=await client.from('app_health').select('message,created_at').limit(1);
    if(error)throw error;
    const {data:sessionData}=await client.auth.getSession();
    return {ok:true,message:data?.[0]?.message||'Supabase connected.',signedIn:!!sessionData?.session,email:sessionData?.session?.user?.email||''};
  }catch(err){return {ok:false,message:err?.message||String(err)};}
}

function renderManageDatabase(){
  const cfg=window.STM_SUPABASE||{};
  manageBody(`<section class="manage-section"><div class="manage-section-head"><strong>Supabase database</strong><span id="dbStatusTag" class="tag review">checking</span></div><div style="padding:14px"><div class="filemeta"><strong>Project</strong><br>${esc(cfg.url||'Not configured')}</div><div id="dbStatus" class="notice" style="margin-top:12px"><strong>Checking connection…</strong></div><div class="toolbar" style="margin-top:12px"><button id="testDatabase" class="btn secondary compact">Test connection</button></div><div class="smalltext muted" style="margin-top:12px">The app is connected to the Supabase project configuration, but v0.6 still treats IndexedDB as the operational source while the relational migration is being verified. Run <code>supabase-schema.sql</code> once in the Supabase SQL Editor before migrating production data.</div></div></section>`);
  const paint=async()=>{const box=$('#dbStatus'),tag=$('#dbStatusTag');if(!box||!tag)return;box.innerHTML='<strong>Checking connection…</strong>';tag.textContent='checking';tag.className='tag review';const st=await getSupabaseStatus();if(st.ok){box.className='notice oknotice';box.innerHTML=`<strong>Database connection successful.</strong><div class="smalltext">${esc(st.message)}${st.signedIn?` · Signed in as ${esc(st.email)}`:' · No user signed in yet.'}</div>`;tag.textContent='connected';tag.className='tag critical';}else{box.className='notice';box.innerHTML=`<strong>Database not ready.</strong><div class="smalltext">${esc(st.message)}</div>`;tag.textContent='setup needed';tag.className='tag review';}};
  $('#testDatabase').addEventListener('click',paint);paint();
}

function renderManage(){setPageTitle('Manage');const tabs=[['production','Production'],['people','People'],['locations','Locations'],['presets','Presets'],['run','Run'],['props','Props'],['inventory','Inventory'],['images','Images'],['database','Database'],['backup','Backup']];$('#view').innerHTML=`<div class="manage-tabs">${tabs.map(([k,l])=>`<button class="manage-tab ${manageTab===k?'active':''}" data-manage-tab="${k}">${l}</button>`).join('')}</div><div id="manageBody"></div>`;$$('[data-manage-tab]').forEach(b=>b.addEventListener('click',()=>{manageTab=b.dataset.manageTab;renderManage();}));if(manageTab==='production')renderManageProduction();else if(manageTab==='people')renderManagePeople();else if(manageTab==='locations')renderManageLocations();else if(manageTab==='presets')renderManagePresets();else if(manageTab==='run')renderManageRun();else if(manageTab==='props')renderManageProps();else if(manageTab==='inventory')renderManageInventory();else if(manageTab==='images')renderManageImages();else if(manageTab==='database')renderManageDatabase();else renderBackup();}

function manageBody(html) { $('#manageBody').innerHTML = html; }


function renderManageProduction(){const acts=sortedActs();manageBody(`<section class="manage-section"><div class="manage-section-head"><div><strong>${esc(showData.production.title||'Untitled Production')}</strong><div class="smalltext muted">${esc(showData.production.company||'No company set')}</div></div><button id="editProduction" class="mini-btn">Edit</button></div><div style="padding:14px"><div class="filemeta">${showData.production.startDate||showData.production.endDate?`Active window: ${esc(showData.production.startDate||'…')} → ${esc(showData.production.endDate||'…')}`:'Set rehearsal/use dates to enable shared-asset conflict checking.'}</div><div class="toolbar" style="margin-top:10px"><button id="allProductions" class="btn secondary compact">All productions (${workspaceData.productions.length})</button><button id="newProduction" class="btn primary compact">+ New production</button></div></div></section><div class="toolbar"><button id="addAct" class="btn primary compact">+ Add act</button></div><section class="manage-section"><div class="manage-section-head"><strong>Acts / sections</strong><span class="muted smalltext">${acts.length}</span></div>${acts.map((a,i)=>`<div class="listrow"><div><div class="listrow-title">${esc(a.name)}</div><div class="listrow-meta">${i===0?'Preshow preset':`Setup/changeover after ${esc(acts[i-1]?.name||'previous act')}`}${a.notes?` · ${esc(a.notes)}`:''}</div></div><div class="row-actions"><button class="mini-btn" data-act-up="${esc(a.id)}" ${i===0?'disabled':''}>↑</button><button class="mini-btn" data-act-down="${esc(a.id)}" ${i===acts.length-1?'disabled':''}>↓</button><button class="mini-btn" data-edit-act="${esc(a.id)}">Edit</button><button class="mini-btn" data-del-act="${esc(a.id)}" ${acts.length===1?'disabled':''}>Delete</button></div></div>`).join('')}</section>`);$('#editProduction').addEventListener('click',openProductionForm);$('#allProductions').addEventListener('click',()=>route('shows'));$('#newProduction').addEventListener('click',startNewProduction);$('#addAct').addEventListener('click',()=>openActForm());$$('[data-edit-act]').forEach(b=>b.addEventListener('click',()=>openActForm(showData.acts.find(x=>x.id===b.dataset.editAct))));$$('[data-act-up]').forEach(b=>b.addEventListener('click',()=>moveAct(b.dataset.actUp,-1)));$$('[data-act-down]').forEach(b=>b.addEventListener('click',()=>moveAct(b.dataset.actDown,1)));$$('[data-del-act]').forEach(b=>b.addEventListener('click',()=>deleteAct(b.dataset.delAct)));}

function openProductionForm(){openForm('Production details',[['title','Production title','text',showData.production.title||''],['company','Company / venue','text',showData.production.company||''],['startDate','First rehearsal / asset-use date','date',showData.production.startDate||''],['endDate','Strike / final asset-use date','date',showData.production.endDate||''],['status','Status','select',showData.production.status||'active',[['active','Active'],['planning','Planning'],['complete','Complete']]]],async vals=>{if(!vals.title.trim())throw new Error('Production title is required.');if(vals.startDate&&vals.endDate&&vals.endDate<vals.startDate)throw new Error('End date cannot be before start date.');Object.assign(showData.production,vals,{updatedAt:now()});await saveShow();$('#productionTitle').textContent=showData.production.title;renderManage();});}

function openActForm(act={}){openForm(act.id?'Edit act':'Add act',[['name','Act / section name','text',act.name||`Act ${sortedActs().length+1}`],['notes','Notes','textarea',act.notes||'']],async vals=>{if(!vals.name.trim())throw new Error('Act name is required.');if(act.id)Object.assign(act,vals,{updatedAt:now()});else showData.acts.push({id:newUUID(),name:vals.name,notes:vals.notes,order:sortedActs().length+1,updatedAt:now()});normalizeActOrders();await saveShow();renderManage();});}

function normalizeActOrders(){sortedActs().forEach((a,i)=>a.order=i+1);}
async function moveAct(id,delta){const acts=sortedActs(),i=acts.findIndex(a=>a.id===id),j=i+delta;if(i<0||j<0||j>=acts.length)return;[acts[i].order,acts[j].order]=[acts[j].order,acts[i].order];await saveShow();renderManage();}
async function deleteAct(id){const act=showData.acts.find(x=>x.id===id);if(!act||showData.acts.length<=1)return;const pc=showData.presets.filter(x=>x.act===id).length,mc=showData.movements.filter(x=>x.act===id).length;if(!confirm(`Delete ${act.name}? This also removes ${pc} preset item(s), ${mc} movement(s), and its photo assignments.`))return;showData.acts=showData.acts.filter(x=>x.id!==id);showData.presets=showData.presets.filter(x=>x.act!==id);showData.movements=showData.movements.filter(x=>x.act!==id);for(const k of Object.keys(showData.areaPhotos||{}))if(k.startsWith(`${id}::`))delete showData.areaPhotos[k];showData.images.custom=(showData.images.custom||[]).filter(x=>x.scope!==id);normalizeActOrders();presetMode=sortedActs()[0]?.id||'';await saveShow();renderManage();}
async function startNewProduction(){openForm('New production',[['title','Production title','text',''],['company','Company / venue','text',showData?.production?.company||workspaceData.organization?.name||''],['firstAct','First act / section','text','Act I'],['startDate','First rehearsal / asset-use date','date',''],['endDate','Strike / final asset-use date','date','']],async vals=>{if(!vals.title.trim())throw new Error('Production title is required.');if(vals.startDate&&vals.endDate&&vals.endDate<vals.startDate)throw new Error('End date cannot be before start date.');const prod=blankProduction(vals.title,vals.company,vals.firstAct);prod.production.startDate=vals.startDate;prod.production.endDate=vals.endDate;workspaceData.productions.push(prod);workspaceData.activeProductionId=prod.production.id;setActiveRefs();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;runActFilter='ALL';runPersonFilter='ALL';runSearch='';route('tonight');});}

function renderManageLocations(){const rows=sortedLocations();manageBody(`<div class="toolbar"><button id="addLocation" class="btn primary compact">+ Add location</button></div><div class="notice oknotice"><strong>Locations have permanent IDs.</strong><div class="smalltext">Rename freely; presets/photos stay attached to the same location UUID.</div></div><section class="manage-section">${rows.map((x,i)=>`<div class="listrow"><div><div class="listrow-title">${esc(x.name)}</div><div class="listrow-meta">${showData.presets.filter(p=>presetLocationId(p)===x.id).length} preset item(s)</div></div><div class="row-actions"><button class="mini-btn" data-loc-up="${x.id}" ${i===0?'disabled':''}>↑</button><button class="mini-btn" data-loc-down="${x.id}" ${i===rows.length-1?'disabled':''}>↓</button><button class="mini-btn" data-edit-location="${x.id}">Edit</button><button class="mini-btn" data-del-location="${x.id}">Delete</button></div></div>`).join('')}</section>`);$('#addLocation').addEventListener('click',()=>openLocationForm());$$('[data-edit-location]').forEach(b=>b.addEventListener('click',()=>openLocationForm(showData.locations.find(x=>x.id===b.dataset.editLocation))));$$('[data-loc-up]').forEach(b=>b.addEventListener('click',()=>moveLocation(b.dataset.locUp,-1)));$$('[data-loc-down]').forEach(b=>b.addEventListener('click',()=>moveLocation(b.dataset.locDown,1)));$$('[data-del-location]').forEach(b=>b.addEventListener('click',()=>deleteLocation(b.dataset.delLocation)));}

function openLocationForm(loc={}){openForm(loc.id?'Edit location':'Add location',[['name','Location / area name','text',loc.name||'']],async vals=>{const name=vals.name.trim();if(!name)throw new Error('Location name is required.');if(showData.locations.some(x=>x.id!==loc.id&&x.name.toLowerCase()===name.toLowerCase()))throw new Error('That location already exists.');if(loc.id){loc.name=name;loc.updatedAt=now();}else showData.locations.push({id:newUUID(),name,order:sortedLocations().length+1,active:true,updatedAt:now()});normalizeLocationOrders();await saveShow();renderManage();});}

function normalizeLocationOrders(){sortedLocations().forEach((x,i)=>x.order=i+1);}
async function moveLocation(id,delta){const rows=sortedLocations(),i=rows.findIndex(x=>x.id===id),j=i+delta;if(i<0||j<0||j>=rows.length)return;[rows[i].order,rows[j].order]=[rows[j].order,rows[i].order];await saveShow();renderManage();}
async function deleteLocation(id){const loc=showData.locations.find(x=>x.id===id);if(!loc)return;const used=showData.presets.filter(x=>presetLocationId(x)===id).length;if(used){alert(`${loc.name} is used by ${used} preset item(s). Move those items before deleting it.`);return;}if(Object.values(showData.areaPhotos||{}).some(v=>v.locationId===id&&(v.imageRefs||[]).length)){alert(`${loc.name} still has photo assignments. Remove them before deleting it.`);return;}showData.locations=showData.locations.filter(x=>x.id!==id);normalizeLocationOrders();await saveShow();renderManage();}

function renderManagePeople() {
  const active = (showData.people||[]).slice().sort((a,b)=>(a.group||'').localeCompare(b.group||'') || a.name.localeCompare(b.name));
  const groups = groupBy(active,x=>x.group==='cast'?'Cast':'Stage crew');
  manageBody(`<div class="toolbar"><button id="addPerson" class="btn primary compact">+ Add person</button></div>${Object.entries(groups).map(([g,rows])=>`<section class="manage-section"><div class="manage-section-head"><strong>${esc(g)}</strong><span class="muted smalltext">${rows.length}</span></div>${rows.map(p=>`<div class="listrow"><div><div class="listrow-title">${esc(p.name)}</div><div class="listrow-meta">${esc(p.role||'')}${p.active===false?' · inactive':''}</div></div><div class="row-actions"><button class="mini-btn" data-edit-person="${p.id}">Edit</button></div></div>`).join('')}</section>`).join('')}`);
  $('#addPerson').addEventListener('click',()=>openPersonForm());
  $$('[data-edit-person]').forEach(b=>b.addEventListener('click',()=>openPersonForm(showData.people.find(x=>x.id===b.dataset.editPerson))));
}

function openPersonForm(person={}){const gp=person.personId?globalPersonById(person.personId):null;openForm(person.id?'Edit person':'Add person',[['name','Name','text',gp?.name||person.name||''],['role','Role / assignment','text',person.role||''],['group','Group','select',person.group||'crew',[['cast','Cast'],['crew','Stage crew']]],['notes','Production notes','textarea',person.notes||''],['active','Expected / active','checkbox',person.active!==false]],async vals=>{if(!vals.name.trim())throw new Error('Name is required.');let global=gp||workspaceData.people.find(x=>x.name.trim().toLowerCase()===vals.name.trim().toLowerCase());if(!global){global={id:newUUID(),name:vals.name.trim(),notes:'',active:true,updatedAt:now()};workspaceData.people.push(global);}else if(global.name!==vals.name.trim()){global.name=vals.name.trim();global.updatedAt=now();for(const prod of workspaceData.productions)for(const a of prod.people||[])if(a.personId===global.id)a.name=global.name;}if(person.id)Object.assign(person,{role:vals.role,group:vals.group,notes:vals.notes,active:vals.active,personId:global.id,name:global.name,updatedAt:now()});else showData.people.push({id:newUUID(),personId:global.id,name:global.name,role:vals.role,group:vals.group,notes:vals.notes,active:vals.active,updatedAt:now()});await saveShow();renderManage();});}

function renderManagePresets(){const acts=sortedActs();manageBody(`<div class="toolbar"><button id="addPreset" class="btn primary compact">+ Add preset item</button><button id="addPresetLocation" class="btn secondary compact">+ Location</button></div>${acts.map((act,i)=>{const rows=showData.presets.filter(x=>x.act===act.id),groups=groupBy(rows,x=>presetLocationId(x)||'unassigned');return `<div class="eyebrow" style="margin:14px 2px 8px">${esc(act.name)} ${i===0?'· preshow':'· setup/changeover'}</div>${Object.keys(groups).length?Object.entries(groups).map(([locId,items])=>{const label=locationName(locId,items[0]?.area||'Unassigned');return `<section class="manage-section"><div class="manage-section-head"><div><strong>${esc(label)}</strong><div class="smalltext muted">${getAreaImageRefs(act.id,locId).length} reference photo(s)</div></div><button class="mini-btn" data-area-photos="${esc(act.id)}||${esc(locId)}">Photos</button></div>${items.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.item)}</div><div class="listrow-meta">${x.critical?'Critical · ':''}${esc(x.notes||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-preset="${x.id}">Edit</button><button class="mini-btn" data-del-preset="${x.id}">Delete</button></div></div>`).join('')}</section>`;}).join(''):'<div class="empty">No preset items.</div>'}`;}).join('')}`);$('#addPreset').addEventListener('click',()=>openPresetForm());$('#addPresetLocation').addEventListener('click',()=>openLocationForm());$$('[data-edit-preset]').forEach(b=>b.addEventListener('click',()=>openPresetForm(showData.presets.find(x=>x.id===b.dataset.editPreset))));$$('[data-del-preset]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this preset item?'))return;showData.presets=showData.presets.filter(x=>x.id!==b.dataset.delPreset);await saveShow();renderManage();}));$$('[data-area-photos]').forEach(b=>b.addEventListener('click',()=>{const [act,loc]=b.dataset.areaPhotos.split('||');openAreaPhotoPicker(act,loc);}));}

function openPresetForm(x={}){const locs=locationOptions();if(!locs.length){alert('Add a location first under Manage → Locations.');manageTab='locations';renderManage();return;}const propOpts=[['','No linked prop'],...(showData.props||[]).slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p=>[p.id,p.name])];openForm(x.id?'Edit preset item':'Add preset item',[['act','Act / section','select',x.act||sortedActs()[0]?.id||'',actOptions()],['locationId','Location / area','select',presetLocationId(x)||locs[0][0],locs],['propId','Linked production prop','select',x.propId||'',propOpts],['item','Item / required state','text',x.item||''],['kind','Type','text',x.kind||'Preset'],['notes','Notes','textarea',x.notes||''],['critical','Critical','checkbox',!!x.critical]],async vals=>{if(!vals.item.trim()||!vals.locationId)throw new Error('Location and item are required.');const data={...vals,area:locationName(vals.locationId),updatedAt:now()};if(x.id)Object.assign(x,data);else showData.presets.push({id:newUUID(),...data});await saveShow();renderManage();});}

function renderManageRun(){const rows=(showData.movements||[]).slice().sort(movementSort);manageBody(`<div class="toolbar"><button id="addMove" class="btn primary compact">+ Add movement</button></div><section class="manage-section">${rows.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(productionPropName(x.propId,x.propName))}</div><div class="listrow-meta">${esc(actName(x.act))} · Sc ${esc(x.scene||'—')} · p${esc(x.page||'—')} · ${esc(x.person||'unassigned')}</div><div class="smalltext">${esc(x.cue||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-move="${x.id}">Edit</button><button class="mini-btn" data-del-move="${x.id}">Delete</button></div></div>`).join('')}</section>`);$('#addMove').addEventListener('click',()=>openMoveForm());$$('[data-edit-move]').forEach(b=>b.addEventListener('click',()=>openMoveForm(showData.movements.find(x=>x.id===b.dataset.editMove))));$$('[data-del-move]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this movement?'))return;showData.movements=showData.movements.filter(x=>x.id!==b.dataset.delMove);await saveShow();renderManage();}));}

function openMoveForm(x={}){const props=(showData.props||[]).slice().sort((a,b)=>a.name.localeCompare(b.name)),locs=[['','— Unspecified / free text —'],...locationOptions()];openForm(x.id?'Edit movement':'Add movement',[['propId','Prop','select',x.propId||props[0]?.id||'',props.map(p=>[p.id,p.name])],['act','Act / section','select',x.act||sortedActs()[0]?.id||'',actOptions(true)],['scene','Scene','text',x.scene||''],['page','Page','text',x.page||''],['person','Who','text',x.person||''],['fromLocationId','From location (optional)','select',x.fromLocationId||'',locs],['from','From / instruction','text',x.from||''],['toLocationId','To location (optional)','select',x.toLocationId||'',locs],['to','To / instruction','text',x.to||''],['cue','Cue / instruction','textarea',x.cue||''],['notes','Notes','textarea',x.notes||''],['review','Needs review','checkbox',!!x.review]],async vals=>{const prop=productionPropById(vals.propId);if(!prop)throw new Error('Choose a prop.');const data={...vals,propName:prop.name,from:vals.from||locationName(vals.fromLocationId,''),to:vals.to||locationName(vals.toLocationId,''),updatedAt:now()};if(x.id)Object.assign(x,data);else showData.movements.push({id:newUUID(),order:99999,...data});await saveShow();renderManage();});}

function renderManageProps(){const rows=(showData.props||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));manageBody(`<div class="toolbar"><button id="addProp" class="btn primary compact">+ Add prop</button><button id="goInventory" class="btn secondary compact">Shared inventory</button></div><div class="notice oknotice"><strong>Production props have permanent UUIDs.</strong><div class="smalltext">Link a prop to shared inventory only when it is the same physical reusable item.</div></div><section class="manage-section">${rows.map(x=>{const asset=inventoryById(x.assetId),res=reservationForProp(x.id),conf=asset?reservationHasConflict(res):false;return `<div class="listrow"><div><div class="listrow-title">${esc(x.name)}</div><div class="listrow-meta">${x.review?'Needs review · ':''}${asset?`Shared: ${esc(asset.name)}${res?` · ${esc(res.startDate||'no start')} → ${esc(res.endDate||'no end')}`:''}${conf?' · CONFLICT':''}`:'Production-only'}${x.notes?` · ${esc(x.notes)}`:''}</div></div><div class="row-actions"><button class="mini-btn" data-edit-prop="${x.id}">Edit</button><button class="mini-btn" data-del-prop="${x.id}">Delete</button></div></div>`;}).join('')}</section>`);$('#addProp').addEventListener('click',()=>openPropForm());$('#goInventory').addEventListener('click',()=>{manageTab='inventory';renderManage();});$$('[data-edit-prop]').forEach(b=>b.addEventListener('click',()=>openPropForm(showData.props.find(x=>x.id===b.dataset.editProp))));$$('[data-del-prop]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.delProp;if(!confirm('Delete this production prop? Movement records that reference it will remain.'))return;showData.props=showData.props.filter(x=>x.id!==id);workspaceData.reservations=workspaceData.reservations.filter(r=>!(r.productionId===showData.production.id&&r.productionPropId===id));await saveShow();renderManage();}));}

function openPropForm(x={}){const res=x.id?reservationForProp(x.id):null,assets=(workspaceData.inventory||[]).slice().sort((a,b)=>a.name.localeCompare(b.name)),assetOpts=[['','Production-only / not shared'],...assets.map(a=>[a.id,`${a.name}${a.trackingMode==='bulk'?` (qty ${a.quantity})`:''}`])];openForm(x.id?'Edit prop':'Add prop',[['name','Name','text',x.name||''],['notes','Notes','textarea',x.notes||''],['ready','Ready / acquired','checkbox',!!x.ready],['review','Needs review','checkbox',!!x.review],['assetId','Shared inventory asset','select',x.assetId||'',assetOpts],['reserveQty','Quantity reserved','number',String(res?.quantity||1)],['reserveStart','Needed from','date',res?.startDate||showData.production.startDate||''],['reserveEnd','Needed through','date',res?.endDate||showData.production.endDate||'']],async vals=>{if(!vals.name.trim())throw new Error('Prop name is required.');if(vals.reserveStart&&vals.reserveEnd&&vals.reserveEnd<vals.reserveStart)throw new Error('Reservation end date cannot be before start date.');let prop=x;if(x.id){Object.assign(prop,{name:vals.name,notes:vals.notes,ready:vals.ready,review:vals.review,assetId:vals.assetId||null,updatedAt:now()});}else{prop={id:newUUID(),sourcePage:'',sourceRow:'',name:vals.name,notes:vals.notes,ready:vals.ready,review:vals.review,assetId:vals.assetId||null,updatedAt:now()};showData.props.push(prop);}for(const m of showData.movements)if(m.propId===prop.id)m.propName=prop.name;workspaceData.reservations=workspaceData.reservations.filter(r=>!(r.productionId===showData.production.id&&r.productionPropId===prop.id));if(prop.assetId){const asset=inventoryById(prop.assetId),qty=asset?.trackingMode==='unique'?1:Math.max(1,Number(vals.reserveQty||1));workspaceData.reservations.push({id:res?.id||newUUID(),assetId:prop.assetId,productionId:showData.production.id,productionPropId:prop.id,quantity:qty,startDate:vals.reserveStart||'',endDate:vals.reserveEnd||'',notes:'',updatedAt:now()});}await saveShow();renderManage();});}

function imageScopeList(scope) {
  return allImageMeta().filter(x => x.scope === scope && x.hidden !== true);
}

function imageUsage(id) {
  return Object.values(showData.areaPhotos||{}).filter(x=>(x.imageRefs||[]).includes(id)).length;
}

function renderManageImages() { const acts=sortedActs();manageBody(acts.map(act=>{const imgs=imageScopeList(act.id);return `<div class="toolbar" style="margin-top:10px"><div class="eyebrow">${esc(act.name)} image library</div><span class="spacer"></span><button class="btn primary compact" data-add-photo-act="${esc(act.id)}">+ Photo</button></div><div class="image-grid">${imgs.length?imgs.map(imageCardHTML).join(''):'<div class="empty">No photos for this act yet.</div>'}</div>`;}).join(''));$$('[data-add-photo-act]').forEach(b=>b.addEventListener('click',()=>{pendingImageAction={type:'add',scope:b.dataset.addPhotoAct};chooseImageFile();}));bindImageCardActions();hydrateImages($('#manageBody')); }

function imageCardHTML(meta) {
  const used=imageUsage(meta.id);
  return `<div class="image-card"><button type="button" class="photo-thumb" style="width:100%;display:block" data-photo-id="${esc(meta.id)}"><img style="width:100%;height:auto;aspect-ratio:4/3;object-fit:cover" data-image-id="${esc(meta.id)}" ${meta.src?`src="${esc(meta.src)}"`:''} alt="${esc(meta.label||'Reference photo')}"></button><div class="image-card-body"><div class="image-card-title">${esc(meta.label||meta.id)}</div><div class="image-card-meta">${used} location${used===1?'':'s'} · ${meta.source==='custom'?'uploaded':'bundled'}${imageUrlCache.has(meta.id)?' / replaced':''}</div><div class="image-card-actions"><button class="mini-btn" data-img-label="${meta.id}">Rename</button><button class="mini-btn" data-img-replace="${meta.id}">Replace</button></div><div class="image-card-actions"><button class="mini-btn" data-img-assign="${meta.id}">Assign</button><button class="mini-btn" data-img-restore="${meta.id}">Restore</button>${meta.source==='custom'?`<button class="mini-btn" data-img-delete="${meta.id}">Delete</button>`:''}</div></div></div>`;
}

function bindImageCardActions() {
  bindPhotoButtons($('#manageBody'));
  $$('[data-img-label]').forEach(b=>b.addEventListener('click',()=>{
    const meta=imageMeta(b.dataset.imgLabel); if(!meta)return;
    openForm('Rename image',[['label','Label','text',meta.label||'']],async vals=>{meta.label=vals.label||meta.label;meta.updatedAt=now();await saveShow();renderManage();});
  }));
  $$('[data-img-replace]').forEach(b=>b.addEventListener('click',()=>{pendingImageAction={type:'replace',id:b.dataset.imgReplace};chooseImageFile();}));
  $$('[data-img-restore]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.imgRestore;await deleteImageBlob(id);clearImageCache(id);renderManage();}));
  $$('[data-img-assign]').forEach(b=>b.addEventListener('click',()=>openImageAssignment(b.dataset.imgAssign)));
  $$('[data-img-delete]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.imgDelete;if(!confirm('Delete this uploaded image from the library?'))return;
    showData.images.custom=showData.images.custom.filter(x=>x.id!==id);
    for(const v of Object.values(showData.areaPhotos||{}))v.imageRefs=(v.imageRefs||[]).filter(x=>x!==id);
    await deleteImageBlob(id);clearImageCache(id);await saveShow();renderManage();
  }));
}

function chooseImageFile() {
  const input=$('#imageFile'); input.value=''; input.click();
}

async function handleImageFile(e){const file=e.target.files?.[0];if(!file||!pendingImageAction)return;if(!file.type.startsWith('image/')){alert('Please choose an image file.');return;}const action=pendingImageAction;let id;if(action.type==='replace'){id=action.id;await putImageBlob(id,file);}else{id=newUUID();const meta={id,label:file.name.replace(/\.[^.]+$/,''),scope:action.scope,source:'custom',src:'',hidden:false,updatedAt:now()};showData.images.custom.push(meta);await putImageBlob(id,file);await saveShow();}clearImageCache(id);pendingImageAction=null;if(action.reopenPicker&&pendingPhotoPicker){pendingPhotoPicker.selected.add(id);openAreaPhotoPicker(pendingPhotoPicker.act,pendingPhotoPicker.locationId,true);}else renderManage();}

function clearImageCache(id) {
  const url=imageUrlCache.get(id); if(url)URL.revokeObjectURL(url); imageUrlCache.delete(id);
}

function openAreaPhotoPicker(act,locationId,preserve=false){const key=`${act}::${locationId}`,existing=showData.areaPhotos[key]?.imageRefs||[],area=locationName(locationId);if(!preserve||!pendingPhotoPicker||pendingPhotoPicker.act!==act||pendingPhotoPicker.locationId!==locationId)pendingPhotoPicker={act,locationId,selected:new Set(existing)};$('#photoPickerTitle').textContent=`${area} reference photos`;const library=imageScopeList(act);$('#photoPickerGrid').innerHTML=library.map(meta=>`<label class="image-choice ${pendingPhotoPicker.selected.has(meta.id)?'selected':''}"><input type="checkbox" data-pick-img="${meta.id}" ${pendingPhotoPicker.selected.has(meta.id)?'checked':''}><img data-image-id="${meta.id}" ${meta.src?`src="${esc(meta.src)}"`:''} alt="${esc(meta.label||'Reference photo')}"><span>${esc(meta.label||meta.id)}</span></label>`).join('');$$('[data-pick-img]',$('#photoPickerGrid')).forEach(box=>box.addEventListener('change',()=>{if(box.checked)pendingPhotoPicker.selected.add(box.dataset.pickImg);else pendingPhotoPicker.selected.delete(box.dataset.pickImg);box.closest('.image-choice').classList.toggle('selected',box.checked);}));hydrateImages($('#photoPickerGrid'));$('#photoPickerDialog').showModal();}

async function savePhotoPicker(){if(!pendingPhotoPicker)return;const {act,locationId,selected}=pendingPhotoPicker,area=locationName(locationId);showData.areaPhotos[`${act}::${locationId}`]={id:showData.areaPhotos[`${act}::${locationId}`]?.id||newUUID(),act,actId:act,locationId,area,imageRefs:[...selected],updatedAt:now()};await saveShow();$('#photoPickerDialog').close();pendingPhotoPicker=null;renderManage();}

function openImageAssignment(id){const meta=imageMeta(id);if(!meta)return;const act=meta.scope,locIds=[...new Set(showData.presets.filter(x=>x.act===act).map(presetLocationId).filter(Boolean))],used=new Set(Object.values(showData.areaPhotos||{}).filter(v=>v.act===act&&(v.imageRefs||[]).includes(id)).map(v=>v.locationId));$('#formFields').innerHTML=`<div class="eyebrow">${esc(meta.label)}</div><h2>Assign to locations</h2>${locIds.map(locId=>`<label class="checkrow"><input type="checkbox" name="areaAssign" value="${esc(locId)}" ${used.has(locId)?'checked':''}><span class="check-main">${esc(locationName(locId))}</span></label>`).join('')}`;$('#formTitle').textContent='Image assignment';const dlg=$('#formDialog');dlg.showModal();$('#editForm').onsubmit=async ev=>{ev.preventDefault();const chosen=new Set($$('input[name="areaAssign"]:checked',dlg).map(x=>x.value));for(const locId of locIds){const key=`${act}::${locId}`,rec=showData.areaPhotos[key]||{id:newUUID(),act,actId:act,locationId:locId,area:locationName(locId),imageRefs:[],updatedAt:now()},set=new Set(rec.imageRefs||[]);if(chosen.has(locId))set.add(id);else set.delete(id);rec.imageRefs=[...set];rec.updatedAt=now();showData.areaPhotos[key]=rec;}await saveShow();dlg.close();renderManage();};}

function normalizeOptions(opts=[]) {
  return opts.map(o => Array.isArray(o) ? {value:o[0],label:o[1]} : {value:o,label:o});
}

function openForm(title,fields,onSave){$('#formTitle').textContent=title;$('#formFields').innerHTML=fields.map(([k,label,type,value,opts])=>{if(type==='select'){const options=normalizeOptions(opts);return `<div class="formgroup"><label>${esc(label)}</label><select name="${esc(k)}">${options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>`;}if(type==='textarea')return `<div class="formgroup"><label>${esc(label)}</label><textarea name="${esc(k)}">${esc(value)}</textarea></div>`;if(type==='checkbox')return `<div class="formgroup"><label class="checkboxline"><input type="checkbox" name="${esc(k)}" ${value?'checked':''}> <span>${esc(label)}</span></label></div>`;const inputType=['date','number','text'].includes(type)?type:'text';return `<div class="formgroup"><label>${esc(label)}</label><input type="${inputType}" name="${esc(k)}" value="${esc(value)}" ${inputType==='number'?'min="1" step="1"':''}></div>`;}).join('');const dlg=$('#formDialog');dlg.showModal();$('#editForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target),vals={};for(const [k,,type] of fields)vals[k]=type==='checkbox'?e.target.elements[k].checked:String(fd.get(k)??'');try{await onSave(vals);dlg.close();}catch(err){alert(err.message||String(err));}};}

function renderBackup(){const last=localStorage.getItem('lastExport')||'Not yet';manageBody(`<section class="manage-section"><div class="manage-section-head"><strong>This production</strong></div><div style="padding:14px"><p class="filemeta">Send one production to another device without replacing other shows. UUIDs are preserved.</p><div class="backup-actions"><button id="exportProduction" class="btn primary">Export production</button><button id="exportProductionFull" class="btn secondary">Export + photos</button><button id="importProduction" class="btn secondary">Import production</button></div></div></section><section class="manage-section"><div class="manage-section-head"><strong>Whole workspace</strong></div><div style="padding:14px"><p class="filemeta">Includes every production, shared people, inventory, reservations and local photos.</p><div class="backup-actions"><button id="exportWorkspace" class="btn secondary">Export workspace</button><button id="importWorkspaceMerge" class="btn secondary">Import + merge workspace</button><button id="importWorkspaceReplace" class="btn danger">Replace workspace</button></div><p class="filemeta">Last export: ${esc(last)}</p></div></section><section class="manage-section"><div class="manage-section-head"><strong>Bundled starter</strong></div><div style="padding:14px"><p class="filemeta">Restore/add the bundled Peter and the Starcatcher production without deleting other productions.</p><button id="resetSeed" class="btn secondary">Restore Starcatcher starter</button></div></section>`);$('#exportProduction').addEventListener('click',()=>exportProduction(false));$('#exportProductionFull').addEventListener('click',()=>exportProduction(true));$('#importProduction').addEventListener('click',()=>chooseImport('production'));$('#exportWorkspace').addEventListener('click',exportWorkspaceFull);$('#importWorkspaceMerge').addEventListener('click',()=>chooseImport('workspace-merge'));$('#importWorkspaceReplace').addEventListener('click',()=>chooseImport('workspace-replace'));$('#resetSeed').addEventListener('click',resetSeed);}

function downloadBlob(blob, filename) {
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);
  localStorage.setItem('lastExport',new Date().toLocaleString());
}

async function exportProduction(includePhotos=false){const personIds=new Set((showData.people||[]).map(x=>x.personId).filter(Boolean)),reservations=(workspaceData.reservations||[]).filter(r=>r.productionId===showData.production.id),assetIds=new Set(reservations.map(r=>r.assetId).filter(Boolean)),payload={type:'stage-manager-production',version:3,appVersion:APP_VERSION,exportedAt:now(),production:showData,people:workspaceData.people.filter(p=>personIds.has(p.id)),inventory:workspaceData.inventory.filter(a=>assetIds.has(a.id)),reservations};if(includePhotos){const stored=await allStoredImages(),ids=new Set(allImageMeta().map(x=>x.id)),images={};for(const [id,blob] of Object.entries(stored))if(ids.has(id))images[id]=await blobToDataURL(blob);payload.images=images;}downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`${slugify(showData.production.title)}-${includePhotos?'full-':''}production-${localDateKey()}.stage.json`);if(currentView==='manage'&&manageTab==='backup')renderBackup();}

function blobToDataURL(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
}

async function exportWorkspaceFull(){const stored=await allStoredImages(),images={};for(const [id,blob] of Object.entries(stored))images[id]=await blobToDataURL(blob);const payload={type:'stage-manager-workspace',version:3,appVersion:APP_VERSION,exportedAt:now(),workspace:workspaceData,images};downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`stage-manager-workspace-${localDateKey()}.stage.json`);if(currentView==='manage'&&manageTab==='backup')renderBackup();}

function chooseImport(mode) {
  const input=$('#importFile');input.dataset.mode=mode;input.value='';input.click();
}

function validateShow(x){return x&&typeof x==='object'&&Array.isArray(x.props)&&Array.isArray(x.movements)&&Array.isArray(x.presets)&&x.production&&typeof x.production==='object';}

async function handleImportFile(e){const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text()),mode=e.target.dataset.mode||'production';if(mode.startsWith('workspace')){if(parsed?.type!=='stage-manager-workspace'||!parsed.workspace)throw new Error('Not a Stage Manager workspace backup.');const incoming=ensureWorkspaceStructure(parsed.workspace);if(mode==='workspace-replace'){if(!confirm('Replace this entire local workspace?'))return;workspaceData=incoming;}else workspaceData=mergeWorkspace(workspaceData,incoming);if(parsed.images)for(const [id,dataUrl] of Object.entries(parsed.images)){await putImageBlob(id,dataURLToBlob(dataUrl));clearImageCache(id);}setActiveRefs();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;alert('Workspace import complete.');renderBackup();return;}
    let pkg=parsed,incomingProd,people=[],inventory=[],reservations=[],images={};if(parsed?.type==='stage-manager-production'&&validateShow(parsed.production)){incomingProd=ensureShowStructure(parsed.production);people=parsed.people||[];inventory=parsed.inventory||[];reservations=parsed.reservations||[];images=parsed.images||{};}else if(validateShow(parsed)){const migrated=await upgradeLegacyProduction(parsed,{},starterWorkspace.productions?.[0]);incomingProd=migrated.production;}else throw new Error('Not a valid production file.');
    workspaceData.people=mergeById(workspaceData.people||[],people);workspaceData.inventory=mergeById(workspaceData.inventory||[],inventory);workspaceData.reservations=mergeById(workspaceData.reservations||[],reservations);const existing=productionById(incomingProd.production.id);if(existing){const merged=mergeShow(existing,incomingProd),idx=workspaceData.productions.indexOf(existing);workspaceData.productions[idx]=merged;}else workspaceData.productions.push(incomingProd);workspaceData.activeProductionId=incomingProd.production.id;if(images)for(const [id,dataUrl] of Object.entries(images)){await putImageBlob(id,dataURLToBlob(dataUrl));clearImageCache(id);}setActiveRefs();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;alert(existing?'Production merged by UUID.':'Production added.');route('tonight');
  }catch(err){alert(`Import failed: ${err.message||err}`);}finally{e.target.value='';}}

function dataURLToBlob(dataURL) {
  const [head,body]=dataURL.split(',');
  const mime=(head.match(/data:(.*?);/)||[])[1]||'application/octet-stream';
  const bin=atob(body);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return new Blob([arr],{type:mime});
}

function mergeById(local=[], incoming=[]) {
  const map=new Map(local.map(x=>[x.id,x]));
  for(const x of incoming){const cur=map.get(x.id);if(!cur){map.set(x.id,x);continue;}const a=Date.parse(cur.updatedAt||0),b=Date.parse(x.updatedAt||0);if(!a||!b||b>=a)map.set(x.id,{...cur,...x});}
  return [...map.values()];
}

function mergeShow(a,b){const areaPhotos={...(a.areaPhotos||{})};for(const [k,v] of Object.entries(b.areaPhotos||{})){const cur=areaPhotos[k];if(!cur||Date.parse(v.updatedAt||0)>=Date.parse(cur.updatedAt||0))areaPhotos[k]=v;}return ensureShowStructure({...a,production:{...(a.production||{}),...(b.production||{})},acts:mergeById(a.acts||[],b.acts||[]),locations:mergeById(a.locations||[],b.locations||[]),people:mergeById(a.people||[],b.people||[]),props:mergeById(a.props||[],b.props||[]),movements:mergeById(a.movements||[],b.movements||[]),presets:mergeById(a.presets||[],b.presets||[]),images:mergeImageMeta(a.images||{},b.images||{}),areaPhotos,attendance:{...(a.attendance||{}),...(b.attendance||{})},checks:{...(a.checks||{}),...(b.checks||{})},settings:{...(a.settings||{}),...(b.settings||{})},appVersion:APP_VERSION});}
function mergeWorkspace(a,b){a=ensureWorkspaceStructure(a);b=ensureWorkspaceStructure(b);const prodMap=new Map(a.productions.map(p=>[p.production.id,p]));for(const p of b.productions){const cur=prodMap.get(p.production.id);prodMap.set(p.production.id,cur?mergeShow(cur,p):p);}return ensureWorkspaceStructure({...a,productions:[...prodMap.values()],people:mergeById(a.people||[],b.people||[]),inventory:mergeById(a.inventory||[],b.inventory||[]),reservations:mergeById(a.reservations||[],b.reservations||[])});}

async function resetSeed(){const starter=clone(starterWorkspace.productions?.[0]);if(!starter)return;if(!confirm('Restore the bundled Peter and the Starcatcher production? Other productions and shared inventory will stay.'))return;const existing=productionById(starter.production.id);if(existing){const i=workspaceData.productions.indexOf(existing);workspaceData.productions[i]=starter;}else workspaceData.productions.push(starter);for(const gp of starterWorkspace.people||[])if(!workspaceData.people.some(x=>x.id===gp.id))workspaceData.people.push(gp);workspaceData.activeProductionId=starter.production.id;setActiveRefs();await saveWorkspace();$('#productionTitle').textContent=showData.production.title;renderBackup();}

async function saveShow(){showData=ensureShowStructure(showData);showData.production.updatedAt=now();showData.appVersion=APP_VERSION;const idx=workspaceData.productions.findIndex(p=>p.production.id===showData.production.id);if(idx>=0)workspaceData.productions[idx]=showData;else workspaceData.productions.push(showData);workspaceData.activeProductionId=showData.production.id;checks=showData.checks;await saveWorkspace();}
async function saveWorkspace(){workspaceData=ensureWorkspaceStructure(workspaceData);workspaceData.appVersion=APP_VERSION;workspaceData.updatedAt=now();await setKV(WORKSPACE_KEY,workspaceData);}

async function registerSW() {
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js')}catch(err){console.warn('Service worker registration failed',err);}}
}

init().catch(err=>{
  console.error(err);
  $('#view').innerHTML=`<div class="notice"><strong>App startup error</strong><div>${esc(err.message||err)}</div></div>`;
});
