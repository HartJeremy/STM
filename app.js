const APP_VERSION = '0.3.0';
const DB_NAME = 'starcatcher-sm';
const DB_VERSION = 2;
const SHOW_KEY = 'show';
const CHECK_KEY = 'checks';

let db;
let showData;
let checks = {};
let currentView = 'tonight';
let presetMode = 'I';
let manageTab = 'people';
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
  return {
    ...starter,
    production: {...starter.production, ...(local.production || {})},
    people: overlayById(starter.people || [], local.people || []),
    props: overlayById(starter.props || [], local.props || []),
    movements: overlayById(starter.movements || [], local.movements || []),
    presets: overlayById(starter.presets || [], local.presets || []),
    changeover: overlayById(starter.changeover || [], local.changeover || []),
    images: mergeImageMeta(starter.images || {}, local.images || {}),
    areaPhotos: mergeAreaPhotos(starter.areaPhotos || {}, local.areaPhotos || {}),
    attendance: {...(starter.attendance || {}), ...(local.attendance || {})},
    settings: {...(starter.settings || {}), ...(local.settings || {})},
    appVersion: APP_VERSION
  };
}

function mergeImageMeta(a = {}, b = {}) {
  return {
    act1: mergeById(a.act1 || [], b.act1 || []),
    act2: mergeById(a.act2 || [], b.act2 || []),
    custom: mergeById(a.custom || [], b.custom || [])
  };
}

async function init() {
  db = await openDB();
  const starter = await (await fetch('data/seed-show.json', {cache:'no-store'})).json();
  showData = await getKV(SHOW_KEY);
  checks = await getKV(CHECK_KEY) || {};

  if (!showData) {
    showData = starter;
    await setKV(SHOW_KEY, showData);
  } else if (showData.appVersion !== APP_VERSION || Number(showData.schemaVersion || 0) < Number(starter.schemaVersion || 0)) {
    showData = migrateToStarter(showData, starter);
    await setKV(SHOW_KEY, showData);
  }

  // v0.2 used a flat check object. Move any existing checks into today's bucket.
  if (checks && Object.values(checks).some(v => typeof v === 'boolean')) {
    checks = {[localDateKey()]: {...checks}};
    await setKV(CHECK_KEY, checks);
  }

  showData.attendance ||= {};
  showData.areaPhotos ||= {};
  showData.images ||= {act1:[],act2:[],custom:[]};
  showData.settings ||= {};
  if (!Array.isArray(showData.settings.attendanceStatuses) || !showData.settings.attendanceStatuses.includes('missing')) {
    showData.settings.attendanceStatuses = ['waiting','here','late','missing','excused','notcalled'];
  }

  $('#productionTitle').textContent = showData.production?.title || 'Stage Manager';
  bindShell();
  route('tonight');
  registerSW();
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
  setPageTitle('Tonight');
  const date = localDateKey();
  const a = attendanceSummary(date);
  const p1 = checklistStats(showData.presets.filter(x => x.act === 'I'), date);
  const ch = checklistStats(showData.changeover || [], date);
  const p2 = checklistStats(showData.presets.filter(x => x.act === 'II'), date);
  const neededText = a.stillNeed.length ? a.stillNeed.slice(0,4).map(p => p.name.split(' ')[0]).join(', ') + (a.stillNeed.length > 4 ? ` +${a.stillNeed.length-4}` : '') : 'Everyone accounted for';

  $('#view').innerHTML = `
    <div class="eyebrow">${esc(prettyDate(date))}</div>
    <div class="summary-grid">
      <div class="summary-tile"><strong>${a.accounted}/${a.total}</strong><span>People accounted for</span></div>
      <div class="summary-tile"><strong>${p1.done}/${p1.total}</strong><span>Act I preset</span></div>
      <div class="summary-tile"><strong>${ch.done}/${ch.total}</strong><span>Intermission</span></div>
      <div class="summary-tile"><strong>${p2.done}/${p2.total}</strong><span>Act II preset</span></div>
    </div>
    <div class="${a.stillNeed.length || a.missing.length ? 'needed' : 'needed good'}">
      <strong>${a.stillNeed.length ? `${a.stillNeed.length} still need check-in` : 'Cast & crew accounted for'}</strong>
      <div class="smalltext">${esc(neededText)}${a.missing.length ? ` · Missing: ${a.missing.map(p=>p.name.split(' ')[0]).join(', ')}` : ''}</div>
    </div>
    <div class="flow">
      ${flowCard('checkin','Check-in','Cast and stage crew',a.stillNeed.length ? `${a.stillNeed.length} waiting` : 'Complete',!a.stillNeed.length)}
      ${flowCard('presets','Act I preset','Written preset + backstage props',`${p1.done}/${p1.total}`,p1.done===p1.total,'I')}
      ${flowCard('presets','Intermission','Act I → Act II changeover',`${ch.done}/${ch.total}`,ch.done===ch.total,'change')}
      ${flowCard('presets','Act II preset','Act II setup + backstage additions',`${p2.done}/${p2.total}`,p2.done===p2.total,'II')}
      ${flowCard('run','Run track','Search by prop, person, page or cue',`${showData.movements.length} entries`,true)}
      ${flowCard('manage','Manage show','Edit data, images and backups','Edit',true)}
    </div>`;

  $$('[data-flow]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.presetMode) presetMode = b.dataset.presetMode;
    route(b.dataset.flow);
  }));
}

function flowCard(view,title,sub,badge,good,preset='') {
  return `<button class="flow-card ${good?'good':'warn'}" data-flow="${view}" ${preset?`data-preset-mode="${preset}"`:''}><span><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="flow-badge">${esc(badge)} ›</span></button>`;
}

function renderPresets() {
  setPageTitle('Presets');
  $('#view').innerHTML = `
    <div class="segmented">
      <button class="segment-btn ${presetMode==='I'?'active':''}" data-preset-tab="I">Act I</button>
      <button class="segment-btn ${presetMode==='change'?'active':''}" data-preset-tab="change">Intermission</button>
      <button class="segment-btn ${presetMode==='II'?'active':''}" data-preset-tab="II">Act II</button>
    </div>
    <div id="presetBody"></div>`;
  $$('[data-preset-tab]').forEach(b => b.addEventListener('click', () => { presetMode = b.dataset.presetTab; renderPresets(); }));
  if (presetMode === 'change') renderChangeoverBody();
  else renderPresetBody(presetMode);
}

function renderPresetBody(act) {
  const rows = showData.presets.filter(x => x.act === act);
  const stats = checklistStats(rows);
  const groups = groupBy(rows, x => x.area);
  const body = $('#presetBody');
  body.innerHTML = `
    <div class="toolbar">
      <div><div class="eyebrow">Act ${act}</div>${progressHTML(stats.done,stats.total)}</div>
      <span class="spacer"></span>
      <button class="btn secondary compact" id="resetPreset">Reset tonight</button>
    </div>
    ${Object.entries(groups).map(([area,items],idx) => renderLocationCard(act,area,items,idx===0)).join('')}`;
  bindPresetBodyEvents(act, rows);
  hydrateImages(body);
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

function renderChangeoverBody() {
  const rows = showData.changeover || [];
  const stats = checklistStats(rows);
  const groups = groupBy(rows, x => x.area);
  $('#presetBody').innerHTML = `
    <div class="notice">Use this during intermission, then verify the Act II preset before places.</div>
    <div class="toolbar"><div>${progressHTML(stats.done,stats.total)}</div><span class="spacer"></span><button class="btn secondary compact" id="resetChange">Reset tonight</button></div>
    ${Object.entries(groups).map(([area,items],idx) => `<details class="location-card" ${idx===0?'open':''}><summary><span><strong>${esc(area)}</strong><small>${items.filter(i=>isChecked(i.id)).length}/${items.length} checked</small></span><span>›</span></summary><div class="location-body">${items.map(item=>`<label class="checkrow ${isChecked(item.id)?'done':''}"><input type="checkbox" data-change-check="${esc(item.id)}" ${isChecked(item.id)?'checked':''}><span class="check-main"><strong>${esc(item.item)}</strong>${item.notes?`<div class="check-note">${esc(item.notes)}</div>`:''}</span></label>`).join('')}</div></details>`).join('')}`;
  $$('[data-change-check]').forEach(box => box.addEventListener('change', async () => {
    await setChecked(box.dataset.changeCheck, box.checked);
    box.closest('.checkrow')?.classList.toggle('done',box.checked);
  }));
  $('#resetChange').addEventListener('click', async () => {
    if (!confirm('Reset the intermission checklist for tonight?')) return;
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

function movementSort(a,b) {
  const act = {'I':1,'II':2,'':9};
  const aa = act[a.act] || 9, bb = act[b.act] || 9;
  if (aa !== bb) return aa - bb;
  const pa = Number(String(a.page||'').match(/\d+/)?.[0] || 9999);
  const pb = Number(String(b.page||'').match(/\d+/)?.[0] || 9999);
  if (pa !== pb) return pa - pb;
  return Number(a.order||0)-Number(b.order||0);
}

function renderRun() {
  setPageTitle('Run Track');
  const people = [...new Set((showData.movements||[]).flatMap(x => (x.person||'').split(/,|\//).map(s=>s.trim()).filter(Boolean)))].sort();
  const rows = (showData.movements || []).slice().sort(movementSort);
  $('#view').innerHTML = `
    <div class="run-controls">
      <div class="search-wrap"><input id="runSearch" class="searchbar" autocomplete="off" inputmode="search" placeholder="Search prop, person, page, cue…" value="${esc(runSearch)}"><button id="clearSearch" class="btn secondary compact" ${runSearch?'':'hidden'}>Clear</button></div>
      <div class="filterrow">
        <button class="chip ${runActFilter==='ALL'?'active':''}" data-run-act="ALL">All</button>
        <button class="chip ${runActFilter==='I'?'active':''}" data-run-act="I">Act I</button>
        <button class="chip ${runActFilter==='II'?'active':''}" data-run-act="II">Act II</button>
        <select id="runPerson" class="select-compact"><option value="ALL">All people</option>${people.map(p=>`<option value="${esc(p)}" ${runPersonFilter===p?'selected':''}>${esc(p)}</option>`).join('')}</select>
      </div>
      <div id="resultsCount" class="results-count"></div>
    </div>
    <div id="runResults">${rows.map(renderMoveCard).join('')}</div>`;

  const input = $('#runSearch');
  input.addEventListener('input', () => {
    runSearch = input.value;
    $('#clearSearch').hidden = !runSearch;
    applyRunFilter(); // DOM filtering only: keyboard/focus stays open on iPad/Chrome
  });
  $('#clearSearch').addEventListener('click', () => {
    runSearch = '';
    input.value = '';
    $('#clearSearch').hidden = true;
    input.focus();
    applyRunFilter();
  });
  $$('[data-run-act]').forEach(btn => btn.addEventListener('click', () => {
    runActFilter = btn.dataset.runAct;
    $$('[data-run-act]').forEach(x=>x.classList.toggle('active',x===btn));
    applyRunFilter();
  }));
  $('#runPerson').addEventListener('change', e => {runPersonFilter=e.target.value;applyRunFilter();});
  applyRunFilter();
}

function renderMoveCard(m) {
  const search = [m.propName,m.act,m.scene,m.page,m.person,m.from,m.to,m.cue,m.notes].join(' ').toLowerCase();
  return `<article class="move-card ${m.review?'review':''}" data-run-row data-act="${esc(m.act||'')}" data-person="${esc((m.person||'').toLowerCase())}" data-search="${esc(search)}">
    <div class="move-head"><strong>${esc(m.propName||'Unnamed prop')}</strong><span class="move-loc">${m.act?`Act ${esc(m.act)}`:''}${m.page?` · p${esc(m.page)}`:''}</span></div>
    ${m.cue?`<div class="move-cue">${esc(m.cue)}</div>`:''}
    <div class="move-meta">${m.scene?`<span>Scene ${esc(m.scene)}</span>`:''}${m.person?`<span><b>${esc(m.person)}</b></span>`:''}${m.from||m.to?`<span class="move-route">${esc(m.from||'—')} → ${esc(m.to||'—')}</span>`:''}${m.review?'<span class="tag review">review</span>':''}</div>
  </article>`;
}

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
  setPageTitle('Manage');
  const tabs = [['people','People'],['presets','Presets'],['run','Run'],['props','Props'],['images','Images'],['backup','Backup']];
  $('#view').innerHTML = `<div class="manage-tabs">${tabs.map(([k,l])=>`<button class="manage-tab ${manageTab===k?'active':''}" data-manage-tab="${k}">${l}</button>`).join('')}</div><div id="manageBody"></div>`;
  $$('[data-manage-tab]').forEach(b=>b.addEventListener('click',()=>{manageTab=b.dataset.manageTab;renderManage();}));
  if (manageTab==='people') renderManagePeople();
  else if (manageTab==='presets') renderManagePresets();
  else if (manageTab==='run') renderManageRun();
  else if (manageTab==='props') renderManageProps();
  else if (manageTab==='images') renderManageImages();
  else renderBackup();
}

function manageBody(html) { $('#manageBody').innerHTML = html; }

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
  const acts = ['I','II'];
  manageBody(`<div class="toolbar"><button id="addPreset" class="btn primary compact">+ Add preset item</button></div>${acts.map(act=>{
    const rows=showData.presets.filter(x=>x.act===act); const groups=groupBy(rows,x=>x.area);
    return `<div class="eyebrow" style="margin:14px 2px 8px">Act ${act}</div>${Object.entries(groups).map(([area,items])=>`<section class="manage-section"><div class="manage-section-head"><div><strong>${esc(area)}</strong><div class="smalltext muted">${getAreaImageRefs(act,area).length} reference photo(s)</div></div><button class="mini-btn" data-area-photos="${esc(act)}||${esc(area)}">Photos</button></div>${items.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.item)}</div><div class="listrow-meta">${x.critical?'Critical · ':''}${esc(x.notes||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-preset="${x.id}">Edit</button><button class="mini-btn" data-del-preset="${x.id}">Delete</button></div></div>`).join('')}</section>`).join('')}`;
  }).join('')}`);
  $('#addPreset').addEventListener('click',()=>openPresetForm());
  $$('[data-edit-preset]').forEach(b=>b.addEventListener('click',()=>openPresetForm(showData.presets.find(x=>x.id===b.dataset.editPreset))));
  $$('[data-del-preset]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this preset item?'))return;showData.presets=showData.presets.filter(x=>x.id!==b.dataset.delPreset);await saveShow();renderManage();}));
  $$('[data-area-photos]').forEach(b=>b.addEventListener('click',()=>{const [act,area]=b.dataset.areaPhotos.split('||');openAreaPhotoPicker(act,area);}));
}

function openPresetForm(x={}) {
  openForm(x.id?'Edit preset item':'Add preset item',[
    ['act','Act','select',x.act||'I',[['I','Act I'],['II','Act II']]],
    ['area','Area / location','text',x.area||''],
    ['item','Item','text',x.item||''],
    ['kind','Type','text',x.kind||'Preset'],
    ['notes','Notes','textarea',x.notes||''],
    ['critical','Critical','checkbox',!!x.critical]
  ], async vals => {
    if (!vals.item.trim() || !vals.area.trim()) throw new Error('Area and item are required.');
    if (x.id) Object.assign(x,vals,{updatedAt:now()});
    else showData.presets.push({id:`preset-custom-${Date.now()}`,propId:'',...vals,updatedAt:now()});
    await saveShow();
    renderManage();
  });
}

function renderManageRun() {
  const rows=(showData.movements||[]).slice().sort(movementSort);
  manageBody(`<div class="toolbar"><button id="addMove" class="btn primary compact">+ Add movement</button></div><section class="manage-section">${rows.map(x=>`<div class="listrow"><div><div class="listrow-title">${esc(x.propName)}</div><div class="listrow-meta">Act ${esc(x.act||'—')} · Sc ${esc(x.scene||'—')} · p${esc(x.page||'—')} · ${esc(x.person||'unassigned')}</div><div class="smalltext">${esc(x.cue||'')}</div></div><div class="row-actions"><button class="mini-btn" data-edit-move="${x.id}">Edit</button><button class="mini-btn" data-del-move="${x.id}">Delete</button></div></div>`).join('')}</section>`);
  $('#addMove').addEventListener('click',()=>openMoveForm());
  $$('[data-edit-move]').forEach(b=>b.addEventListener('click',()=>openMoveForm(showData.movements.find(x=>x.id===b.dataset.editMove))));
  $$('[data-del-move]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Delete this movement?'))return;showData.movements=showData.movements.filter(x=>x.id!==b.dataset.delMove);await saveShow();renderManage();}));
}

function openMoveForm(x={}) {
  const names=(showData.props||[]).map(p=>p.name).sort();
  openForm(x.id?'Edit movement':'Add movement',[
    ['propName','Prop','select',x.propName||names[0]||'',names.map(v=>[v,v])],
    ['act','Act','select',x.act||'I',[['I','Act I'],['II','Act II'],['','Unspecified']]],
    ['scene','Scene','text',x.scene||''],
    ['page','Page','text',x.page||''],
    ['person','Who','text',x.person||''],
    ['from','From','text',x.from||''],
    ['to','To','text',x.to||''],
    ['cue','Cue / instruction','textarea',x.cue||''],
    ['notes','Notes','textarea',x.notes||''],
    ['review','Needs review','checkbox',!!x.review]
  ], async vals => {
    const p=showData.props.find(p=>p.name===vals.propName);
    const data={...vals,propId:p?.id||'',updatedAt:now()};
    if (x.id) Object.assign(x,data);
    else showData.movements.push({id:`move-custom-${Date.now()}`,order:99999,...data});
    await saveShow();
    renderManage();
  });
}

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

function renderManageImages() {
  const act1=imageScopeList('I'), act2=imageScopeList('II');
  manageBody(`<div class="toolbar"><button id="addAct1Photo" class="btn primary compact">+ Act I photo</button><button id="addAct2Photo" class="btn primary compact">+ Act II photo</button></div>
    <div class="eyebrow" style="margin:12px 2px 8px">Act I image library</div><div class="image-grid">${act1.map(imageCardHTML).join('')}</div>
    <div class="eyebrow" style="margin:18px 2px 8px">Act II image library</div><div class="image-grid">${act2.map(imageCardHTML).join('')}</div>`);
  $('#addAct1Photo').addEventListener('click',()=>{pendingImageAction={type:'add',scope:'I'};chooseImageFile();});
  $('#addAct2Photo').addEventListener('click',()=>{pendingImageAction={type:'add',scope:'II'};chooseImageFile();});
  bindImageCardActions();
  hydrateImages($('#manageBody'));
}

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

function renderBackup() {
  const last=localStorage.getItem('lastExport')||'Not yet';
  manageBody(`<section class="manage-section"><div class="manage-section-head"><strong>Backup / share</strong></div><div style="padding:14px"><p class="filemeta">Data-only export is small. Full backup also carries uploaded/replaced reference photos so another device can reproduce your exact setup.</p><div class="backup-actions"><button id="exportData" class="btn primary">Export data</button><button id="exportFull" class="btn secondary">Export full backup</button><button id="importMerge" class="btn secondary">Import + merge</button><button id="importReplace" class="btn secondary">Import + replace</button></div><p class="filemeta">Last export: ${esc(last)}</p></div></section><section class="manage-section"><div class="manage-section-head"><strong>Recovery</strong></div><div style="padding:14px"><p class="filemeta">Reset editable show data to the version bundled with this app. Uploaded image overrides remain until restored/deleted from Images.</p><button id="resetSeed" class="btn danger">Reset show data</button></div></section>`);
  $('#exportData').addEventListener('click',exportData);
  $('#exportFull').addEventListener('click',exportFullBackup);
  $('#importMerge').addEventListener('click',()=>chooseImport('merge'));
  $('#importReplace').addEventListener('click',()=>chooseImport('replace'));
  $('#resetSeed').addEventListener('click',resetSeed);
}

function downloadBlob(blob, filename) {
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);
  localStorage.setItem('lastExport',new Date().toLocaleString());
}

function exportData() {
  const data={...showData,exportedAt:now()};
  downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`Starcatcher-data-${localDateKey()}.json`);
  renderBackup();
}

function blobToDataURL(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
}

async function exportFullBackup() {
  const stored=await allStoredImages();
  const images={};
  for(const [id,blob] of Object.entries(stored))images[id]=await blobToDataURL(blob);
  const payload={type:'starcatcher-full-backup',version:1,exportedAt:now(),show:showData,checks,images};
  downloadBlob(new Blob([JSON.stringify(payload)],{type:'application/json'}),`Starcatcher-full-backup-${localDateKey()}.stage.json`);
  renderBackup();
}

function chooseImport(mode) {
  const input=$('#importFile');input.dataset.mode=mode;input.value='';input.click();
}

function validateShow(x) {
  return x && typeof x==='object' && Array.isArray(x.props) && Array.isArray(x.movements) && Array.isArray(x.presets);
}

async function handleImportFile(e) {
  const file=e.target.files?.[0];if(!file)return;
  try{
    const parsed=JSON.parse(await file.text());
    const isFull=parsed?.type==='starcatcher-full-backup' && validateShow(parsed.show);
    const incoming=isFull?parsed.show:parsed;
    if(!validateShow(incoming))throw new Error('Not a valid Starcatcher show-data file.');
    const mode=e.target.dataset.mode||'merge';
    if(mode==='replace'){
      if(!confirm('Replace your local show data with this file?'))return;
      showData=incoming;
      if(isFull && parsed.checks)checks=parsed.checks;
    } else showData=mergeShow(showData,incoming);
    if(isFull && parsed.images){for(const [id,dataUrl] of Object.entries(parsed.images)){await putImageBlob(id,dataURLToBlob(dataUrl));clearImageCache(id);}}
    await saveShow();await setKV(CHECK_KEY,checks);
    alert(`Import complete (${mode})${isFull?' including custom photos':''}.`);
    renderBackup();
  }catch(err){alert(`Import failed: ${err.message||err}`);}
}

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

function mergeShow(a,b) {
  const areaPhotos={...(a.areaPhotos||{})};
  for(const [k,v] of Object.entries(b.areaPhotos||{})){
    const cur=areaPhotos[k];
    if(!cur || Date.parse(v.updatedAt||0)>=Date.parse(cur.updatedAt||0))areaPhotos[k]=v;
  }
  return {
    ...a,
    production:{...(a.production||{}),...(b.production||{})},
    people:mergeById(a.people||[],b.people||[]),
    props:mergeById(a.props||[],b.props||[]),
    movements:mergeById(a.movements||[],b.movements||[]),
    presets:mergeById(a.presets||[],b.presets||[]),
    changeover:mergeById(a.changeover||[],b.changeover||[]),
    images:mergeImageMeta(a.images||{},b.images||{}),
    areaPhotos,
    attendance:{...(a.attendance||{}),...(b.attendance||{})},
    settings:{...(a.settings||{}),...(b.settings||{})},
    appVersion:APP_VERSION
  };
}

async function resetSeed() {
  if(!confirm('Reset all editable show data to the bundled starter copy?'))return;
  showData=await (await fetch('data/seed-show.json',{cache:'no-store'})).json();
  checks={};
  await setKV(SHOW_KEY,showData);await setKV(CHECK_KEY,checks);
  renderBackup();
}

async function saveShow() {
  showData.production ||= {};
  showData.production.updatedAt=now();
  showData.appVersion=APP_VERSION;
  await setKV(SHOW_KEY,showData);
}

async function registerSW() {
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js')}catch(err){console.warn('Service worker registration failed',err);}}
}

init().catch(err=>{
  console.error(err);
  $('#view').innerHTML=`<div class="notice"><strong>App startup error</strong><div>${esc(err.message||err)}</div></div>`;
});
