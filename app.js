const APP_VERSION = '0.4.0';
const DB_NAME = 'starcatcher-sm';
const DB_VERSION = 2;
const SHOW_KEY = 'show';
const CHECK_KEY = 'checks';

let db;
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

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const now = () => new Date().toISOString();

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
function locationOptions() { return sortedLocations().map(x=>[x.name,x.name]); }

function ensureShowStructure(data) {
  data ||= {}; data.production ||= {};
  data.production.id ||= `production-${Date.now()}`;
  data.production.title ||= 'Untitled Production'; data.production.company ||= '';
  for(const k of ['people','props','movements','presets']) if(!Array.isArray(data[k])) data[k]=[];
  if(!data.images || typeof data.images!=='object') data.images={act1:[],act2:[],custom:[]};
  data.images.act1 ||= []; data.images.act2 ||= []; data.images.custom ||= [];
  if(!data.areaPhotos || typeof data.areaPhotos!=='object' || Array.isArray(data.areaPhotos)) data.areaPhotos={};
  if(!data.attendance || typeof data.attendance!=='object' || Array.isArray(data.attendance)) data.attendance={};
  data.settings ||= {}; data.settings.attendanceStatuses=['waiting','here','late','missing','excused','notcalled'];
  if(!Array.isArray(data.acts) || !data.acts.length) {
    const seen=[]; for(const row of [...data.presets,...data.movements]){const a=String(row.act||'').trim();if(a&&!seen.includes(a))seen.push(a);} if(!seen.length)seen.push('I');
    data.acts=seen.map((id,i)=>({id,name:id.startsWith('Act ')?id:`Act ${id}`,order:i+1,notes:'',updatedAt:now()}));
  }
  if(!Array.isArray(data.locations) || !data.locations.length) {
    const seen=[]; for(const row of data.presets){const a=String(row.area||'').trim();if(a&&!seen.includes(a))seen.push(a);} if(!seen.length)seen.push('Stage Left','Stage Right','Center Stage','Onstage','Backstage');
    data.locations=seen.map((name,i)=>({id:`loc-${Date.now()}-${i}`,name,order:i+1,active:true,updatedAt:now()}));
  }
  data.changeover=[]; data.schemaVersion=Math.max(Number(data.schemaVersion||0),4); data.appVersion=APP_VERSION; return data;
}
function blankProduction(title,company,firstActName='Act I') {
  const ts=Date.now(); return ensureShowStructure({schemaVersion:4,appVersion:APP_VERSION,imageBundleVersion:'custom',production:{id:`production-${ts}`,title:title||'Untitled Production',company:company||'',updatedAt:now(),dataAuthority:'Locally created production'},acts:[{id:`act-${ts}-1`,name:firstActName||'Act I',order:1,notes:'Preshow preset',updatedAt:now()}],locations:['Stage Left','Stage Right','Center Stage','Onstage','Backstage'].map((name,i)=>({id:`loc-${ts}-${i+1}`,name,order:i+1,active:true,updatedAt:now()})),people:[],props:[],movements:[],presets:[],changeover:[],images:{act1:[],act2:[],custom:[]},areaPhotos:{},attendance:{},settings:{attendanceStatuses:['waiting','here','late','missing','excused','notcalled']}});
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

function migrateToStarter(local, starter) {
  local=ensureShowStructure(local); starter=ensureShowStructure(starter);
  if(local.production?.id!==starter.production?.id) return local;
  return ensureShowStructure({...starter,production:{...starter.production,...(local.production||{})},acts:overlayById(starter.acts||[],local.acts||[]),locations:overlayById(starter.locations||[],local.locations||[]),people:overlayById(starter.people||[],local.people||[]),props:overlayById(starter.props||[],local.props||[]),movements:overlayById(starter.movements||[],local.movements||[]),presets:overlayById(starter.presets||[],local.presets||[]),images:mergeImageMeta(starter.images||{},local.images||{}),areaPhotos:mergeAreaPhotos(starter.areaPhotos||{},local.areaPhotos||{}),attendance:{...(starter.attendance||{}),...(local.attendance||{})},settings:{...(starter.settings||{}),...(local.settings||{})},appVersion:APP_VERSION});
}

function mergeImageMeta(a = {}, b = {}) {
  return {
    act1: mergeById(a.act1 || [], b.act1 || []),
    act2: mergeById(a.act2 || [], b.act2 || []),
    custom: mergeById(a.custom || [], b.custom || [])
  };
}

async function init() {
  db=await openDB(); const starter=ensureShowStructure(await (await fetch('data/seed-show.json',{cache:'no-store'})).json());
  showData=await getKV(SHOW_KEY); checks=await getKV(CHECK_KEY)||{};
  if(showData && !showData.production?.id && showData.production?.title===starter.production?.title){showData.production.id=starter.production.id;}
  if(!showData){showData=starter;await setKV(SHOW_KEY,showData);} else {showData=ensureShowStructure(showData);if(showData.production?.id===starter.production?.id&&(showData.appVersion!==APP_VERSION||Number(showData.schemaVersion||0)<Number(starter.schemaVersion||0)))showData=migrateToStarter(showData,starter);await setKV(SHOW_KEY,showData);}
  if(checks&&Object.values(checks).some(v=>typeof v==='boolean')){checks={[localDateKey()]:{...checks}};await setKV(CHECK_KEY,checks);}
  presetMode=sortedActs()[0]?.id||''; $('#productionTitle').textContent=showData.production?.title||'Stage Manager'; bindShell(); route('tonight'); registerSW();
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
  currentView = view;
  $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'tonight') renderTonight();
  else if (view === 'presets') renderPresets();
  else if (view === 'run') renderRun();
  else if (view === 'checkin') renderCheckin();
  else if (view === 'manage') renderManage();
  else renderTonight();
  window.scrollTo({top:0, behavior:'auto'});
}

function nightChecks(date = localDateKey()) {
  checks[date] ||= {};
  return checks[date];
}

function isChecked(id, date = localDateKey()) {
  return !!nightChecks(date)[id];
}

async function setChecked(id, value, date = localDateKey()) {
  nightChecks(date)[id] = !!value;
  await setKV(CHECK_KEY, checks);
}

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
  setPageTitle('Tonight'); const date=localDateKey(), attendance=attendanceSummary(date), acts=sortedActs();
  const stats=acts.map(a=>({act:a,stats:checklistStats(showData.presets.filter(x=>x.act===a.id),date)}));
  const needed=attendance.stillNeed.length?attendance.stillNeed.slice(0,4).map(p=>p.name.split(' ')[0]).join(', ')+(attendance.stillNeed.length>4?` +${attendance.stillNeed.length-4}`:''):'Everyone accounted for';
  $('#view').innerHTML=`<div class="eyebrow">${esc(prettyDate(date))}</div><div class="summary-grid"><div class="summary-tile"><strong>${attendance.accounted}/${attendance.total}</strong><span>People accounted for</span></div>${stats.map(({act,stats},i)=>`<div class="summary-tile"><strong>${stats.done}/${stats.total}</strong><span>${esc(act.name)} ${i===0?'preshow':'setup'}</span></div>`).join('')}</div><div class="${attendance.stillNeed.length||attendance.missing.length?'needed':'needed good'}"><strong>${attendance.stillNeed.length?`${attendance.stillNeed.length} still need check-in`:'Cast & crew accounted for'}</strong><div class="smalltext">${esc(needed)}${attendance.missing.length?` · Missing: ${esc(attendance.missing.map(p=>p.name.split(' ')[0]).join(', '))}`:''}</div></div><div class="flow">${flowCard('checkin','Check-in','Cast and stage crew',attendance.stillNeed.length?`${attendance.stillNeed.length} waiting`:'Complete',!attendance.stillNeed.length)}${stats.map(({act,stats},i)=>flowCard('presets',act.name,i===0?'Preshow preset':`Setup before ${act.name}`,stats.total?`${stats.done}/${stats.total}`:'No items',stats.total>0&&stats.done===stats.total,act.id)).join('')}${flowCard('run','Run track','Search prop, person, page, cue or location',`${showData.movements.length} entries`,true)}${flowCard('manage','Manage production','Production, acts, locations, data and photos','Edit',true)}</div>`;
  $$('[data-flow]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.presetMode)presetMode=b.dataset.presetMode;route(b.dataset.flow);}));
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
  const acts=sortedActs(),idx=acts.findIndex(a=>a.id===actId),act=acts[idx]||{name:actId},rows=showData.presets.filter(x=>x.act===actId),stats=checklistStats(rows),groups=groupBy(rows,x=>x.area);
  const intro=idx<=0?'Target state before the show starts.':`Target state before ${act.name}. Complete this during the break/changeover from ${acts[idx-1]?.name||'the previous act'}.`;
  const body=$('#presetBody'); body.innerHTML=`<div class="notice oknotice"><strong>${esc(act.name)} setup</strong><div class="smalltext">${esc(intro)}</div></div><div class="toolbar"><div><div class="eyebrow">${esc(act.name)}</div>${progressHTML(stats.done,stats.total)}</div><span class="spacer"></span><button class="btn secondary compact" id="resetPreset">Reset tonight</button></div>${Object.keys(groups).length?Object.entries(groups).map(([area,items],i)=>renderLocationCard(actId,area,items,i===0)).join(''):'<div class="empty">No preset items yet. Add them under Manage → Presets.</div>'}`; bindPresetBodyEvents(actId,rows); hydrateImages(body);
}

function renderLocationCard(act, area, items, open=false) {
  const done = items.filter(i => isChecked(i.id)).length;
  const refs = getAreaImageRefs(act, area);
  return `<details class="location-card" ${open?'open':''}>
    <summary><span><strong>${esc(area)}</strong><small>${done}/${items.length} checked</small></span><span>${done===items.length?'✓':'›'}</span></summary>
    <div class="location-body">
      ${refs.length ? photoStrip(refs) : '<div class="smalltext muted" style="padding-top:10px">No reference photo assigned.</div>'}
      ${items.map(item => `<label class="checkrow ${isChecked(item.id)?'done':''}">
        <input type="checkbox" data-check="${esc(item.id)}" ${isChecked(item.id)?'checked':''}>
        <span class="check-main"><strong>${esc(item.item)}</strong>${item.notes?`<div class="check-note">${esc(item.notes)}</div>`:''}</span>
        ${item.critical?'<span class="tag critical">critical</span>':''}
      </label>`).join('')}
    </div>
  </details>`;
}

function bindPresetBodyEvents(act, rows) {
  $$('[data-check]').forEach(box => box.addEventListener('change', async () => {
    await setChecked(box.dataset.check, box.checked);
    const row = box.closest('.checkrow');
    row?.classList.toggle('done', box.checked);
    // update visible counters without rebuilding the whole page
    const card = box.closest('.location-card');
    if (card) {
      const all = $$('[data-check]', card);
      const done = all.filter(x => x.checked).length;
      const small = $('summary small', card);
      if (small) small.textContent = `${done}/${all.length} checked`;
    }
  }));
  bindPhotoButtons();
  $('#resetPreset')?.addEventListener('click', async () => {
    if (!confirm(`Reset all Act ${act} preset checks for tonight?`)) return;
    const bucket = nightChecks();
    rows.forEach(x => delete bucket[x.id]);
    await setKV(CHECK_KEY, checks);
    renderPresets();
  });
}



function allImageMeta() {
  return [...(showData.images.act1||[]), ...(showData.images.act2||[]), ...(showData.images.custom||[])];
}

function imageMeta(id) {
  return allImageMeta().find(x => x.id === id) || null;
}

function getAreaImageRefs(act, area) {
  const key = `${act}::${area}`;
  return (showData.areaPhotos?.[key]?.imageRefs || []).filter(id => imageMeta(id));
}

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

function renderMoveCard(m) { const search=[m.propName,actName(m.act),m.scene,m.page,m.person,m.from,m.to,m.cue,m.notes].join(' ').toLowerCase();return `<article class="move-card ${m.review?'review':''}" data-run-row data-act="${esc(m.act||'')}" data-person="${esc((m.person||'').toLowerCase())}" data-search="${esc(search)}"><div class="move-head"><strong>${esc(m.propName||'Unnamed prop')}</strong><span class="move-loc">${m.act?esc(actName(m.act)):''}${m.page?` · p${esc(m.page)}`:''}</span></div>${m.cue?`<div class="move-cue">${esc(m.cue)}</div>`:''}<div class="move-meta">${m.scene?`<span>Scene ${esc(m.scene)}</span>`:''}${m.person?`<span><b>${esc(m.person)}</b></span>`:''}${m.from||m.to?`<span class="move-route">${esc(m.from||'—')} → ${esc(m.to||'—')}</span>`:''}${m.review?'<span class="tag review">review</span>':''}</div></article>`; }

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

function renderManage() {
  setPageTitle('Manage'); const tabs=[['production','Production'],['people','People'],['locations','Locations'],['presets','Presets'],['run','Run'],['props','Props'],['images','Images'],['backup','Backup']];$('#view').innerHTML=`<div class="manage-tabs">${tabs.map(([k,l])=>`<button class="manage-tab ${manageTab===k?'active':''}" data-manage-tab="${k}">${l}</button>`).join('')}</div><div id="manageBody"></div>`;$$('[data-manage-tab]').forEach(b=>b.addEventListener('click',()=>{manageTab=b.dataset.manageTab;renderManage();}));if(manageTab==='production')renderManageProduction();else if(manageTab==='people')renderManagePeople();else if(manageTab==='locations')renderManageLocations();else if(manageTab==='presets')renderManagePresets();else if(manageTab==='run')renderManageRun();else if(manageTab==='props')renderManageProps();else if(manageTab==='images')renderManageImages();else renderBackup();
}

function manageBody(html) { $('#manageBody').innerHTML = html; }


function renderManageProduction() {
  const acts=sortedActs();manageBody(`<section class="manage-section"><div class="manage-section-head"><div><strong>${esc(showData.production.title||'Untitled Production')}</strong><div class="smalltext muted">${esc(showData.production.company||'No company set')}</div></div><button id="editProduction" class="mini-btn">Edit</button></div><div style="padding:14px"><div class="filemeta">One active production is stored locally. Export a backup before starting another show; import it later to restore.</div></div></section><div class="toolbar"><button id="addAct" class="btn primary compact">+ Add act</button></div><section class="manage-section"><div class="manage-section-head"><strong>Acts / sections</strong><span class="muted smalltext">${acts.length}</span></div>${acts.map((a,i)=>`<div class="listrow"><div><div class="listrow-title">${esc(a.name)}</div><div class="listrow-meta">${i===0?'Preshow preset':`Setup/changeover after ${esc(acts[i-1]?.name||'previous act')}`}${a.notes?` · ${esc(a.notes)}`:''}</div></div><div class="row-actions"><button class="mini-btn" data-act-up="${esc(a.id)}" ${i===0?'disabled':''}>↑</button><button class="mini-btn" data-act-down="${esc(a.id)}" ${i===acts.length-1?'disabled':''}>↓</button><button class="mini-btn" data-edit-act="${esc(a.id)}">Edit</button><button class="mini-btn" data-del-act="${esc(a.id)}" ${acts.length===1?'disabled':''}>Delete</button></div></div>`).join('')}</section><section class="manage-section"><div class="manage-section-head"><strong>Another show</strong></div><div style="padding:14px"><p class="filemeta">Create a clean production with its own acts, locations, roster, props, presets and photos. A full backup of this production downloads first.</p><button id="newProduction" class="btn secondary">Start new production</button></div></section>`);
  $('#editProduction').addEventListener('click',openProductionForm);$('#addAct').addEventListener('click',()=>openActForm());$$('[data-edit-act]').forEach(b=>b.addEventListener('click',()=>openActForm(showData.acts.find(x=>x.id===b.dataset.editAct))));$$('[data-act-up]').forEach(b=>b.addEventListener('click',()=>moveAct(b.dataset.actUp,-1)));$$('[data-act-down]').forEach(b=>b.addEventListener('click',()=>moveAct(b.dataset.actDown,1)));$$('[data-del-act]').forEach(b=>b.addEventListener('click',()=>deleteAct(b.dataset.delAct)));$('#newProduction').addEventListener('click',startNewProduction);
}
function openProductionForm(){openForm('Production details',[['title','Production title','text',showData.production.title||''],['company','Company / venue','text',showData.production.company||'']],async vals=>{if(!vals.title.trim())throw new Error('Production title is required.');Object.assign(showData.production,vals,{updatedAt:now()});await saveShow();$('#productionTitle').textContent=showData.production.title;renderManage();});}
function openActForm(act={}){openForm(act.id?'Edit act':'Add act',[['name','Act / section name','text',act.name||`Act ${sortedActs().length+1}`],['notes','Notes','textarea',act.notes||'']],async vals=>{if(!vals.name.trim())throw new Error('Act name is required.');if(act.id)Object.assign(act,vals,{updatedAt:now()});else showData.acts.push({id:`act-${Date.now()}`,name:vals.name,notes:vals.notes,order:sortedActs().length+1,updatedAt:now()});normalizeActOrders();await saveShow();renderManage();});}
function normalizeActOrders(){sortedActs().forEach((a,i)=>a.order=i+1);}
async function moveAct(id,delta){const acts=sortedActs(),i=acts.findIndex(a=>a.id===id),j=i+delta;if(i<0||j<0||j>=acts.length)return;[acts[i].order,acts[j].order]=[acts[j].order,acts[i].order];await saveShow();renderManage();}
async function deleteAct(id){const act=showData.acts.find(x=>x.id===id);if(!act||showData.acts.length<=1)return;const pc=showData.presets.filter(x=>x.act===id).length,mc=showData.movements.filter(x=>x.act===id).length;if(!confirm(`Delete ${act.name}? This also removes ${pc} preset item(s), ${mc} movement(s), and its photo assignments.`))return;showData.acts=showData.acts.filter(x=>x.id!==id);showData.presets=showData.presets.filter(x=>x.act!==id);showData.movements=showData.movements.filter(x=>x.act!==id);for(const k of Object.keys(showData.areaPhotos||{}))if(k.startsWith(`${id}::`))delete showData.areaPhotos[k];showData.images.custom=(showData.images.custom||[]).filter(x=>x.scope!==id);normalizeActOrders();presetMode=sortedActs()[0]?.id||'';await saveShow();renderManage();}
async function startNewProduction(){if(!confirm('Start a new production? A full backup of the current production will download first, then this local workspace will be cleared.'))return;await exportFullBackup(false);openForm('New production',[['title','Production title','text',''],['company','Company / venue','text',showData.production.company||''],['firstAct','First act / section','text','Act I']],async vals=>{if(!vals.title.trim())throw new Error('Production title is required.');showData=blankProduction(vals.title,vals.company,vals.firstAct);checks={};presetMode=sortedActs()[0]?.id||'';runActFilter='ALL';runPersonFilter='ALL';runSearch='';await saveShow();await setKV(CHECK_KEY,checks);$('#productionTitle').textContent=showData.production.title;manageTab='production';renderManage();});}
function renderManageLocations(){const rows=sortedLocations();manageBody(`<div class="toolbar"><button id="addLocation" class="btn primary compact">+ Add location</button></div><div class="notice oknotice"><strong>Locations organize presets and photos.</strong><div class="smalltext">Rename a location here and its preset/photo assignments update automatically.</div></div><section class="manage-section">${rows.map((x,i)=>`<div class="listrow"><div><div class="listrow-title">${esc(x.name)}</div><div class="listrow-meta">${showData.presets.filter(p=>p.area===x.name).length} preset item(s)</div></div><div class="row-actions"><button class="mini-btn" data-loc-up="${x.id}" ${i===0?'disabled':''}>↑</button><button class="mini-btn" data-loc-down="${x.id}" ${i===rows.length-1?'disabled':''}>↓</button><button class="mini-btn" data-edit-location="${x.id}">Edit</button><button class="mini-btn" data-del-location="${x.id}">Delete</button></div></div>`).join('')}</section>`);$('#addLocation').addEventListener('click',()=>openLocationForm());$$('[data-edit-location]').forEach(b=>b.addEventListener('click',()=>openLocationForm(showData.locations.find(x=>x.id===b.dataset.editLocation))));$$('[data-loc-up]').forEach(b=>b.addEventListener('click',()=>moveLocation(b.dataset.locUp,-1)));$$('[data-loc-down]').forEach(b=>b.addEventListener('click',()=>moveLocation(b.dataset.locDown,1)));$$('[data-del-location]').forEach(b=>b.addEventListener('click',()=>deleteLocation(b.dataset.delLocation)));}
function openLocationForm(loc={}){openForm(loc.id?'Edit location':'Add location',[['name','Location / area name','text',loc.name||'']],async vals=>{const name=vals.name.trim();if(!name)throw new Error('Location name is required.');if(showData.locations.some(x=>x.id!==loc.id&&x.name.toLowerCase()===name.toLowerCase()))throw new Error('That location already exists.');if(loc.id){const old=loc.name;loc.name=name;loc.updatedAt=now();showData.presets.filter(x=>x.area===old).forEach(x=>x.area=name);for(const [k,v] of Object.entries({...showData.areaPhotos})){if(v.act&&v.area===old){delete showData.areaPhotos[k];v.area=name;showData.areaPhotos[`${v.act}::${name}`]=v;}}showData.movements.forEach(m=>{if(m.from===old)m.from=name;if(m.to===old)m.to=name;});}else showData.locations.push({id:`loc-${Date.now()}`,name,order:sortedLocations().length+1,active:true,updatedAt:now()});normalizeLocationOrders();await saveShow();renderManage();});}
function normalizeLocationOrders(){sortedLocations().forEach((x,i)=>x.order=i+1);}
async function moveLocation(id,delta){const rows=sortedLocations(),i=rows.findIndex(x=>x.id===id),j=i+delta;if(i<0||j<0||j>=rows.length)return;[rows[i].order,rows[j].order]=[rows[j].order,rows[i].order];await saveShow();renderManage();}
async function deleteLocation(id){const loc=showData.locations.find(x=>x.id===id);if(!loc)return;const used=showData.presets.filter(x=>x.area===loc.name).length;if(used){alert(`${loc.name} is used by ${used} preset item(s). Rename it or move those items before deleting it.`);return;}if(Object.values(showData.areaPhotos||{}).some(v=>v.area===loc.name&&(v.imageRefs||[]).length)){alert(`${loc.name} still has photo assignments. Remove them before deleting it.`);return;}showData.locations=showData.locations.filter(x=>x.id!==id);normalizeLocationOrders();await saveShow();renderManage();}

function renderManagePeople() {
  const active = (showData.people||[]).slice().sort((a,b)=>(a.group||'').localeCompare(b.group||'') || a.name.localeCompare(b.name));
  const groups = groupBy(active,x=>x.group==='cast'?'Cast':'Stage crew');
  manageBody(`<div class="toolbar"><button id="addPerson" class="btn primary compact">+ Add person</button></div>${Object.entries(groups).map(([g,rows])=>`<section class="manage-section"><div class="manage-section-head"><strong>${esc(g)}</strong><span class="muted smalltext">${rows.length}</span></div>${rows.map(p=>`<div class="listrow"><div><div class="listrow-title">${esc(p.name)}</div><div class="listrow-meta">${esc(p.role||'')}${p.active===false?' · inactive':''}</div></div><div class="row-actions"><button class="mini-btn" data-edit-person="${p.id}">Edit</button></div></div>`).join('')}</section>`).join('')}`);
  $('#addPerson').addEventListener('click',()=>openPersonForm());
  $$('[data-edit-person]').forEach(b=>b.addEventListener('click',()=>openPersonForm(showData.people.find(x=>x.id===b.dataset.editPerson))));
}

function openPersonForm(person={}) {
  openForm(person.id?'Edit person':'Add person',[
    ['name','Name','text',person.name||''],
    ['role','Role / assignment','text',person.role||''],
    ['group','Group','select',person.group||'crew',[['cast','Cast'],['crew','Stage crew']]],
    ['notes','Notes','textarea',person.notes||''],
    ['active','Expected / active','checkbox',person.active!==false]
  ], async vals => {
    if (!vals.name.trim()) throw new Error('Name is required.');
    if (person.id) Object.assign(person,vals,{updatedAt:now()});
    else showData.people.push({id:`person-custom-${Date.now()}`,...vals,updatedAt:now()});
    await saveShow();
    renderManage();
  });
}

function renderManagePresets() {
  const acts=sortedActs();manageBody(`<div class="toolbar"><button id="addPreset" class="btn primary compact">+ Add preset item</button><button id="addPresetLocation" class="btn secondary compact">+ Location</button></div>${acts.map((act,i)=>{const rows=showData.presets.filter(x=>x.act===act.id),groups=groupBy(rows,x=>x.area);return `<div class="eyebrow" style="margin:14px 2px 8px">${esc(act.name)} ${i===0?'· preshow':'· setup/changeover'}</div>${Object.keys(groups).length?Object.entries(groups).map(([area,items])=>`<section class="manage-section"><div class="manage-section-head"><div><strong>${esc(area)}</strong><div class="smalltext muted">${getAreaImageRefs(act.id,area).length} reference photo(s)</div></div><button class="mini-btn" data-area-photos="${esc(act.id)}||${esc(area)}">Photos</button></div>${items.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.item)}</div><div class="listrow-meta">${x.critical?'Critical · ':''}${esc(x.notes||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-preset="${x.id}">Edit</button><button class="mini-btn" data-del-preset="${x.id}">Delete</button></div></div>`).join('')}</section>`).join(''):'<div class="empty">No preset items.</div>'}`;}).join('')}`);$('#addPreset').addEventListener('click',()=>openPresetForm());$('#addPresetLocation').addEventListener('click',()=>openLocationForm());$$('[data-edit-preset]').forEach(b=>b.addEventListener('click',()=>openPresetForm(showData.presets.find(x=>x.id===b.dataset.editPreset))));$$('[data-del-preset]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this preset item?'))return;showData.presets=showData.presets.filter(x=>x.id!==b.dataset.delPreset);await saveShow();renderManage();}));$$('[data-area-photos]').forEach(b=>b.addEventListener('click',()=>{const [act,area]=b.dataset.areaPhotos.split('||');openAreaPhotoPicker(act,area);}));
}

function openPresetForm(x={}) { const locs=locationOptions();if(!locs.length){alert('Add a location first under Manage → Locations.');manageTab='locations';renderManage();return;}openForm(x.id?'Edit preset item':'Add preset item',[['act','Act / section','select',x.act||sortedActs()[0]?.id||'',actOptions()],['area','Location / area','select',x.area||locs[0][0],locs],['item','Item / required state','text',x.item||''],['kind','Type','text',x.kind||'Preset'],['notes','Notes','textarea',x.notes||''],['critical','Critical','checkbox',!!x.critical]],async vals=>{if(!vals.item.trim()||!vals.area.trim())throw new Error('Location and item are required.');if(x.id)Object.assign(x,vals,{updatedAt:now()});else showData.presets.push({id:`preset-custom-${Date.now()}`,propId:'',...vals,updatedAt:now()});await saveShow();renderManage();}); }

function renderManageRun() { const rows=(showData.movements||[]).slice().sort(movementSort);manageBody(`<div class="toolbar"><button id="addMove" class="btn primary compact">+ Add movement</button></div><section class="manage-section">${rows.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.propName)}</div><div class="listrow-meta">${esc(actName(x.act))} · Sc ${esc(x.scene||'—')} · p${esc(x.page||'—')} · ${esc(x.person||'unassigned')}</div><div class="smalltext">${esc(x.cue||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-move="${x.id}">Edit</button><button class="mini-btn" data-del-move="${x.id}">Delete</button></div></div>`).join('')}</section>`);$('#addMove').addEventListener('click',()=>openMoveForm());$$('[data-edit-move]').forEach(b=>b.addEventListener('click',()=>openMoveForm(showData.movements.find(x=>x.id===b.dataset.editMove))));$$('[data-del-move]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this movement?'))return;showData.movements=showData.movements.filter(x=>x.id!==b.dataset.delMove);await saveShow();renderManage();})); }

function openMoveForm(x={}) { const names=(showData.props||[]).map(p=>p.name).sort();openForm(x.id?'Edit movement':'Add movement',[['propName','Prop','select',x.propName||names[0]||'',names.map(v=>[v,v])],['act','Act / section','select',x.act||sortedActs()[0]?.id||'',actOptions(true)],['scene','Scene','text',x.scene||''],['page','Page','text',x.page||''],['person','Who','text',x.person||''],['from','From','text',x.from||''],['to','To','text',x.to||''],['cue','Cue / instruction','textarea',x.cue||''],['notes','Notes','textarea',x.notes||''],['review','Needs review','checkbox',!!x.review]],async vals=>{const p=showData.props.find(p=>p.name===vals.propName),data={...vals,propId:p?.id||'',updatedAt:now()};if(x.id)Object.assign(x,data);else showData.movements.push({id:`move-custom-${Date.now()}`,order:99999,...data});await saveShow();renderManage();}); }

function renderManageProps() {
  const rows=(showData.props||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
  manageBody(`<div class="toolbar"><button id="addProp" class="btn primary compact">+ Add prop</button></div><section class="manage-section">${rows.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.name)}</div><div class="listrow-meta">${x.review?'Needs review · ':''}${esc(x.notes||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-prop="${x.id}">Edit</button><button class="mini-btn" data-del-prop="${x.id}">Delete</button></div></div>`).join('')}</section>`);
  $('#addProp').addEventListener('click',()=>openPropForm());
  $$('[data-edit-prop]').forEach(b=>b.addEventListener('click',()=>openPropForm(showData.props.find(x=>x.id===b.dataset.editProp))));
  $$('[data-del-prop]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this prop? Movement records that mention it will remain.'))return;showData.props=showData.props.filter(x=>x.id!==b.dataset.delProp);await saveShow();renderManage();}));
}

function openPropForm(x={}) {
  openForm(x.id?'Edit prop':'Add prop',[
    ['name','Name','text',x.name||''],
    ['notes','Notes','textarea',x.notes||''],
    ['ready','Ready / acquired','checkbox',!!x.ready],
    ['review','Needs review','checkbox',!!x.review]
  ], async vals => {
    if (!vals.name.trim()) throw new Error('Prop name is required.');
    if (x.id) Object.assign(x,vals,{updatedAt:now()});
    else showData.props.push({id:`prop-custom-${Date.now()}`,sourcePage:'',sourceRow:'',...vals,updatedAt:now()});
    await saveShow();
    renderManage();
  });
}

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

async function handleImageFile(e) {
  const file=e.target.files?.[0];
  if(!file || !pendingImageAction)return;
  if(!file.type.startsWith('image/')){alert('Please choose an image file.');return;}
  const action=pendingImageAction;
  let id;
  if(action.type==='replace') {
    id=action.id;
    await putImageBlob(id,file);
  } else {
    id=`img-custom-${Date.now()}`;
    const meta={id,label:file.name.replace(/\.[^.]+$/,''),scope:action.scope,source:'custom',src:'',hidden:false,updatedAt:now()};
    showData.images.custom.push(meta);
    await putImageBlob(id,file);
    await saveShow();
  }
  clearImageCache(id);
  pendingImageAction=null;
  if(action.reopenPicker && pendingPhotoPicker){
    pendingPhotoPicker.selected.add(id);
    openAreaPhotoPicker(pendingPhotoPicker.act,pendingPhotoPicker.area,true);
  } else renderManage();
}

function clearImageCache(id) {
  const url=imageUrlCache.get(id); if(url)URL.revokeObjectURL(url); imageUrlCache.delete(id);
}

function openAreaPhotoPicker(act, area, preserve=false) {
  const key=`${act}::${area}`;
  const existing=showData.areaPhotos[key]?.imageRefs || [];
  if(!preserve || !pendingPhotoPicker || pendingPhotoPicker.act!==act || pendingPhotoPicker.area!==area) pendingPhotoPicker={act,area,selected:new Set(existing)};
  $('#photoPickerTitle').textContent=`${area} reference photos`;
  const library=imageScopeList(act);
  $('#photoPickerGrid').innerHTML=library.map(meta=>`<label class="image-choice ${pendingPhotoPicker.selected.has(meta.id)?'selected':''}"><input type="checkbox" data-pick-img="${meta.id}" ${pendingPhotoPicker.selected.has(meta.id)?'checked':''}><img data-image-id="${meta.id}" ${meta.src?`src="${esc(meta.src)}"`:''} alt="${esc(meta.label||'Reference photo')}"><span>${esc(meta.label||meta.id)}</span></label>`).join('');
  $$('[data-pick-img]', $('#photoPickerGrid')).forEach(box=>box.addEventListener('change',()=>{if(box.checked)pendingPhotoPicker.selected.add(box.dataset.pickImg);else pendingPhotoPicker.selected.delete(box.dataset.pickImg);box.closest('.image-choice').classList.toggle('selected',box.checked);}));
  hydrateImages($('#photoPickerGrid'));
  $('#photoPickerDialog').showModal();
}

async function savePhotoPicker() {
  if(!pendingPhotoPicker)return;
  const {act,area,selected}=pendingPhotoPicker;
  showData.areaPhotos[`${act}::${area}`]={act,area,imageRefs:[...selected],updatedAt:now()};
  await saveShow();
  $('#photoPickerDialog').close();
  pendingPhotoPicker=null;
  renderManage();
}

function openImageAssignment(id) {
  const meta=imageMeta(id); if(!meta)return;
  const act=meta.scope;
  const areas=[...new Set(showData.presets.filter(x=>x.act===act).map(x=>x.area))].sort();
  const used=new Set(Object.entries(showData.areaPhotos||{}).filter(([k,v])=>k.startsWith(`${act}::`) && (v.imageRefs||[]).includes(id)).map(([k])=>k.split('::').slice(1).join('::')));
  $('#formFields').innerHTML=`<div class="eyebrow">${esc(meta.label)}</div><h2>Assign to locations</h2>${areas.map((area,i)=>`<label class="checkrow"><input type="checkbox" name="areaAssign" value="${esc(area)}" ${used.has(area)?'checked':''}><span class="check-main">${esc(area)}</span></label>`).join('')}`;
  $('#formTitle').textContent='Image assignment';
  const dlg=$('#formDialog');dlg.showModal();
  $('#editForm').onsubmit=async ev=>{ev.preventDefault();const chosen=new Set($$('input[name="areaAssign"]:checked',dlg).map(x=>x.value));for(const area of areas){const key=`${act}::${area}`;const rec=showData.areaPhotos[key]||{act,area,imageRefs:[],updatedAt:now()};const set=new Set(rec.imageRefs||[]);if(chosen.has(area))set.add(id);else set.delete(id);rec.imageRefs=[...set];rec.updatedAt=now();showData.areaPhotos[key]=rec;}await saveShow();dlg.close();renderManage();};
}

function normalizeOptions(opts=[]) {
  return opts.map(o => Array.isArray(o) ? {value:o[0],label:o[1]} : {value:o,label:o});
}

function openForm(title, fields, onSave) {
  $('#formTitle').textContent=title;
  $('#formFields').innerHTML=fields.map(([k,label,type,value,opts])=>{
    if(type==='select'){
      const options=normalizeOptions(opts);
      return `<div class="formgroup"><label>${esc(label)}</label><select name="${esc(k)}">${options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>`;
    }
    if(type==='textarea') return `<div class="formgroup"><label>${esc(label)}</label><textarea name="${esc(k)}">${esc(value)}</textarea></div>`;
    if(type==='checkbox') return `<div class="formgroup"><label class="checkboxline"><input type="checkbox" name="${esc(k)}" ${value?'checked':''}> <span>${esc(label)}</span></label></div>`;
    return `<div class="formgroup"><label>${esc(label)}</label><input name="${esc(k)}" value="${esc(value)}"></div>`;
  }).join('');
  const dlg=$('#formDialog'); dlg.showModal();
  $('#editForm').onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(e.target), vals={};
    for(const [k,,type] of fields) vals[k]=type==='checkbox'?e.target.elements[k].checked:String(fd.get(k)??'');
    try{await onSave(vals);dlg.close();}catch(err){alert(err.message||String(err));}
  };
}

function renderBackup() { const last=localStorage.getItem('lastExport')||'Not yet';manageBody(`<section class="manage-section"><div class="manage-section-head"><strong>Backup / share</strong></div><div style="padding:14px"><p class="filemeta">Data export contains this production's editable records. Full backup also includes locally uploaded/replaced reference photos.</p><div class="backup-actions"><button id="exportData" class="btn primary">Export data</button><button id="exportFull" class="btn secondary">Export full backup</button><button id="importMerge" class="btn secondary">Import + merge</button><button id="importReplace" class="btn secondary">Import + replace</button></div><p class="filemeta">Last export: ${esc(last)}</p></div></section><section class="manage-section"><div class="manage-section-head"><strong>Bundled starter</strong></div><div style="padding:14px"><p class="filemeta">Restore the Peter and the Starcatcher starter bundled with this app. This replaces the current production.</p><button id="resetSeed" class="btn danger">Restore Starcatcher starter</button></div></section>`);$('#exportData').addEventListener('click',exportData);$('#exportFull').addEventListener('click',()=>exportFullBackup(true));$('#importMerge').addEventListener('click',()=>chooseImport('merge'));$('#importReplace').addEventListener('click',()=>chooseImport('replace'));$('#resetSeed').addEventListener('click',resetSeed); }

function downloadBlob(blob, filename) {
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);
  localStorage.setItem('lastExport',new Date().toLocaleString());
}

function exportData() { const data={...showData,exportedAt:now()};downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`${slugify(showData.production?.title)}-data-${localDateKey()}.json`);if(currentView==='manage'&&manageTab==='backup')renderBackup(); }

function blobToDataURL(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
}

async function exportFullBackup(render=true) { const stored=await allStoredImages(),allowed=new Set(allImageMeta().map(x=>x.id)),images={};for(const [id,blob] of Object.entries(stored))if(allowed.has(id))images[id]=await blobToDataURL(blob);const payload={type:'stage-manager-full-backup',version:2,exportedAt:now(),show:showData,checks,images};downloadBlob(new Blob([JSON.stringify(payload)],{type:'application/json'}),`${slugify(showData.production?.title)}-full-backup-${localDateKey()}.stage.json`);if(render&&currentView==='manage'&&manageTab==='backup')renderBackup(); }

function chooseImport(mode) {
  const input=$('#importFile');input.dataset.mode=mode;input.value='';input.click();
}

function validateShow(x) { return x&&typeof x==='object'&&Array.isArray(x.props)&&Array.isArray(x.movements)&&Array.isArray(x.presets)&&x.production&&typeof x.production==='object'; }

async function handleImportFile(e) { const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text()),isFull=(parsed?.type==='stage-manager-full-backup'||parsed?.type==='starcatcher-full-backup')&&validateShow(parsed.show),incoming=ensureShowStructure(isFull?parsed.show:parsed);if(!validateShow(incoming))throw new Error('Not a valid stage-manager production file.');const mode=e.target.dataset.mode||'merge';if(mode==='replace'){if(!confirm(`Replace your local production with ${incoming.production?.title||'this production'}?`))return;showData=incoming;if(isFull&&parsed.checks)checks=parsed.checks;}else{if(showData.production?.id!==incoming.production?.id){if(!confirm(`This file is for a different production (${incoming.production?.title||'Untitled'}). Replace the current production instead of merging?`))return;showData=incoming;if(isFull&&parsed.checks)checks=parsed.checks;}else showData=mergeShow(showData,incoming);}if(isFull&&parsed.images){for(const [id,dataUrl] of Object.entries(parsed.images)){await putImageBlob(id,dataURLToBlob(dataUrl));clearImageCache(id);}}showData=ensureShowStructure(showData);presetMode=sortedActs()[0]?.id||'';runActFilter='ALL';await saveShow();await setKV(CHECK_KEY,checks);$('#productionTitle').textContent=showData.production.title;alert(`Import complete${isFull?' including custom photos':''}.`);renderBackup();}catch(err){alert(`Import failed: ${err.message||err}`);} }

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

function mergeShow(a,b) { const areaPhotos={...(a.areaPhotos||{})};for(const [k,v] of Object.entries(b.areaPhotos||{})){const cur=areaPhotos[k];if(!cur||Date.parse(v.updatedAt||0)>=Date.parse(cur.updatedAt||0))areaPhotos[k]=v;}return ensureShowStructure({...a,production:{...(a.production||{}),...(b.production||{})},acts:mergeById(a.acts||[],b.acts||[]),locations:mergeById(a.locations||[],b.locations||[]),people:mergeById(a.people||[],b.people||[]),props:mergeById(a.props||[],b.props||[]),movements:mergeById(a.movements||[],b.movements||[]),presets:mergeById(a.presets||[],b.presets||[]),images:mergeImageMeta(a.images||{},b.images||{}),areaPhotos,attendance:{...(a.attendance||{}),...(b.attendance||{})},settings:{...(a.settings||{}),...(b.settings||{})},appVersion:APP_VERSION}); }

async function resetSeed() { if(!confirm('Restore the bundled Peter and the Starcatcher starter? This replaces the current local production.'))return;showData=ensureShowStructure(await (await fetch('data/seed-show.json',{cache:'no-store'})).json());checks={};presetMode=sortedActs()[0]?.id||'';runActFilter='ALL';await setKV(SHOW_KEY,showData);await setKV(CHECK_KEY,checks);$('#productionTitle').textContent=showData.production.title;renderBackup(); }

async function saveShow() { showData=ensureShowStructure(showData);showData.production.updatedAt=now();showData.appVersion=APP_VERSION;await setKV(SHOW_KEY,showData); }

async function registerSW() {
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js')}catch(err){console.warn('Service worker registration failed',err);}}
}

init().catch(err=>{
  console.error(err);
  $('#view').innerHTML=`<div class="notice"><strong>App startup error</strong><div>${esc(err.message||err)}</div></div>`;
});
