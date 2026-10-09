/* Stage Manager Workspace cloud sync - v0.7.0
   Supabase is the shared source of truth once cloud sync is enabled.
   IndexedDB remains the immediate/offline working copy.
   Image BLOBs are intentionally not uploaded yet; image metadata is synced. */

let cloudSyncTimer = null;
let cloudSyncRunning = false;
let cloudLastMessage = '';

function cloudClient(){ return window.supabaseClient || null; }
function cloudMeta(){
  workspaceData.syncMeta ||= {enabled:false,lastSyncedAt:'',lastSyncError:'',remoteWorkspaceId:'',callIds:{},attendanceIds:{}};
  workspaceData.syncMeta.callIds ||= {};
  workspaceData.syncMeta.attendanceIds ||= {};
  return workspaceData.syncMeta;
}
function cloudIso(value){ return value || new Date().toISOString(); }
function nullable(value){ return value === '' || value === undefined ? null : value; }
function validUuidOrNull(value){ return typeof isUUID==='function' && isUUID(value) ? value : null; }
function cloudArray(v){ return Array.isArray(v) ? v : []; }
function cloudErr(error){ return error?.message || String(error || 'Unknown cloud error'); }

async function cloudSession(){
  const client=cloudClient(); if(!client)return null;
  const {data,error}=await client.auth.getSession(); if(error)throw error;
  return data?.session || null;
}

async function cloudConnectionStatus(){
  const client=cloudClient();
  if(!client)return {ok:false,message:'Supabase client is not available.'};
  try{
    const {data,error}=await client.from('app_health').select('message,created_at').limit(1);
    if(error)throw error;
    const session=await cloudSession();
    return {ok:true,message:data?.[0]?.message||'Supabase connected.',signedIn:!!session,email:session?.user?.email||'',syncEnabled:!!workspaceData?.syncMeta?.enabled,lastSyncedAt:workspaceData?.syncMeta?.lastSyncedAt||'',lastSyncError:workspaceData?.syncMeta?.lastSyncError||''};
  }catch(err){ return {ok:false,message:cloudErr(err)}; }
}

async function cloudSignIn(email,password){
  const client=cloudClient(); if(!client)throw new Error('Supabase is not configured.');
  const {data,error}=await client.auth.signInWithPassword({email:email.trim(),password});
  if(error)throw error;
  return data;
}
async function cloudSignUp(email,password){
  const client=cloudClient(); if(!client)throw new Error('Supabase is not configured.');
  const {data,error}=await client.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:location.href.split('#')[0]}});
  if(error)throw error;
  return data;
}
async function cloudSignOut(){ const client=cloudClient(); if(client)await client.auth.signOut(); }

function cloudStableId(bucket, keyA, keyB=''){
  const meta=cloudMeta(); meta[bucket] ||= {}; meta[bucket][keyA] ||= {};
  if(keyB){ meta[bucket][keyA][keyB] ||= newUUID(); return meta[bucket][keyA][keyB]; }
  if(typeof meta[bucket][keyA] !== 'string') meta[bucket][keyA]=newUUID();
  return meta[bucket][keyA];
}
function cloudCallId(productionId,date){ return cloudStableId('callIds',productionId,date); }
function cloudAttendanceId(productionId,date,assignmentId){
  const meta=cloudMeta(); meta.attendanceIds[productionId] ||= {}; meta.attendanceIds[productionId][date] ||= {};
  return meta.attendanceIds[productionId][date][assignmentId] ||= newUUID();
}

function cloudPersonIdForMovement(prod,m){
  const label=String(m.person||'').trim().toLowerCase(); if(!label)return null;
  const assignment=(prod.people||[]).find(p=>String(p.name||'').trim().toLowerCase()===label || String(p.role||'').trim().toLowerCase()===label);
  return assignment?.personId || null;
}

function cloudSnapshot(){
  const wid=workspaceData.workspaceId;
  const productions=[],people=[],production_people=[],acts=[],production_locations=[],assets=[],production_assets=[],prop_usages=[],presets=[],asset_reservations=[],calls=[],attendance=[],production_images=[],preset_area_photos=[],preset_checks=[];
  for(const p of workspaceData.people||[]) people.push({id:p.id,workspace_id:wid,name:p.name,notes:p.notes||'',active:p.active!==false,updated_at:cloudIso(p.updatedAt)});
  for(const a of workspaceData.inventory||[]) assets.push({id:a.id,workspace_id:wid,asset_number:a.assetNumber||null,name:a.name,aliases:cloudArray(a.aliases),category:a.category||'prop',tracking_mode:a.trackingMode||'unique',quantity:Math.max(1,Number(a.quantity||1)),storage_location_id:validUuidOrNull(a.storageLocationId),notes:a.notes||'',active:a.active!==false,updated_at:cloudIso(a.updatedAt)});
  for(const prod of workspaceData.productions||[]){
    const pid=prod.production.id;
    productions.push({id:pid,workspace_id:wid,title:prod.production.title,company:prod.production.company||'',start_date:nullable(prod.production.startDate),end_date:nullable(prod.production.endDate),status:prod.production.status||'active',data_authority:prod.production.dataAuthority||'',updated_at:cloudIso(prod.production.updatedAt)});
    for(const pp of prod.people||[]) production_people.push({id:pp.id,production_id:pid,person_id:validUuidOrNull(pp.personId),name_snapshot:pp.name||'',role:pp.role||'',group_name:pp.group||'',active:pp.active!==false,notes:pp.notes||'',updated_at:cloudIso(pp.updatedAt)});
    for(const a of prod.acts||[]) acts.push({id:a.id,production_id:pid,name:a.name,sort_order:Number(a.order||1),notes:a.notes||'',updated_at:cloudIso(a.updatedAt)});
    for(const l of prod.locations||[]) production_locations.push({id:l.id,production_id:pid,name:l.name,sort_order:Number(l.order||1),active:l.active!==false,updated_at:cloudIso(l.updatedAt)});
    for(const x of prod.props||[]) production_assets.push({id:x.id,production_id:pid,asset_id:validUuidOrNull(x.assetId),display_name:x.name||'Unnamed prop',notes:x.notes||'',ready:!!x.ready,needs_review:!!x.review,source_page:String(x.sourcePage||''),source_row:String(x.sourceRow||''),updated_at:cloudIso(x.updatedAt)});
    for(const m of prod.movements||[]) prop_usages.push({id:m.id,production_id:pid,production_asset_id:validUuidOrNull(m.propId),act_id:validUuidOrNull(m.act),scene:String(m.scene||''),page:String(m.page||''),person_id:cloudPersonIdForMovement(prod,m),person_label:m.person||'',from_location_id:validUuidOrNull(m.fromLocationId),to_location_id:validUuidOrNull(m.toLocationId),from_label:m.from||'',to_label:m.to||'',cue:m.cue||'',action:m.action||'',notes:m.notes||'',sort_order:Number(m.order||1),needs_review:!!m.review,updated_at:cloudIso(m.updatedAt)});
    for(const pr of prod.presets||[]) presets.push({id:pr.id,production_id:pid,act_id:validUuidOrNull(pr.act),location_id:validUuidOrNull(pr.locationId),production_asset_id:validUuidOrNull(pr.propId),item:pr.item||'',critical:!!pr.critical,notes:pr.notes||'',kind:pr.kind||'',source:pr.source||'',updated_at:cloudIso(pr.updatedAt)});
    for(const im of [...(prod.images?.act1||[]),...(prod.images?.act2||[]),...(prod.images?.custom||[])]) production_images.push({id:im.id,production_id:pid,act_id:validUuidOrNull(im.scope),label:im.label||'',source:im.source||'',storage_path:im.src||'',hidden:!!im.hidden,updated_at:cloudIso(im.updatedAt)});
    for(const rec of Object.values(prod.areaPhotos||{})) preset_area_photos.push({id:rec.id||newUUID(),production_id:pid,act_id:validUuidOrNull(rec.actId||rec.act),location_id:validUuidOrNull(rec.locationId),image_ids:(rec.imageRefs||[]).filter(isUUID),updated_at:cloudIso(rec.updatedAt)});
    const dates=new Set([...Object.keys(prod.attendance||{}),...Object.keys(prod.checks||{})]);
    for(const date of dates){
      if((prod.attendance||{})[date]){
        const callId=cloudCallId(pid,date);
        calls.push({id:callId,production_id:pid,call_date:date,call_time:null,call_type:'call',title:'Nightly check-in',notes:'',updated_at:workspaceData.updatedAt||now()});
        for(const [assignmentId,status] of Object.entries(prod.attendance[date]||{})) attendance.push({id:cloudAttendanceId(pid,date,assignmentId),call_id:callId,production_person_id:assignmentId,status:status||'waiting',updated_at:workspaceData.updatedAt||now()});
      }
      for(const [presetId,checked] of Object.entries((prod.checks||{})[date]||{})) preset_checks.push({id:cloudStableId('presetCheckIds',`${pid}:${date}`,presetId),production_id:pid,preset_id:presetId,check_date:date,checked:!!checked,updated_at:workspaceData.updatedAt||now()});
    }
  }
  for(const r of workspaceData.reservations||[]) asset_reservations.push({id:r.id,workspace_id:wid,asset_id:r.assetId,production_id:r.productionId,production_asset_id:validUuidOrNull(r.productionPropId),quantity:Math.max(1,Number(r.quantity||1)),start_date:nullable(r.startDate),end_date:nullable(r.endDate),notes:r.notes||'',updated_at:cloudIso(r.updatedAt)});
  return {productions,people,production_people,acts,production_locations,assets,production_assets,prop_usages,presets,asset_reservations,calls,attendance,production_images,preset_area_photos,preset_checks};
}

async function cloudCheck(result){ if(result?.error)throw result.error; return result?.data; }
async function cloudSyncScoped(table,rows,scopeCol,scopeVal){
  const client=cloudClient();
  const existing=await cloudCheck(await client.from(table).select('id').eq(scopeCol,scopeVal));
  const keep=new Set(rows.map(r=>r.id));
  const stale=(existing||[]).map(r=>r.id).filter(id=>!keep.has(id));
  if(stale.length)await cloudCheck(await client.from(table).delete().in('id',stale));
  if(rows.length)await cloudCheck(await client.from(table).upsert(rows,{onConflict:'id'}));
}

async function cloudEnsureWorkspace(user){
  const client=cloudClient(),wid=workspaceData.workspaceId;
  const {data,error}=await client.from('workspaces').select('id,owner_id').eq('id',wid).maybeSingle();
  if(error)throw error;
  if(!data){
    await cloudCheck(await client.from('workspaces').insert({id:wid,name:workspaceData.organization?.name||'Community Theatre',owner_id:user.id,updated_at:workspaceData.updatedAt||now()}));
  } else if(data.owner_id!==user.id){
    const {data:member,error:memberError}=await client.from('workspace_members').select('role').eq('workspace_id',wid).eq('user_id',user.id).maybeSingle();
    if(memberError)throw memberError;
    if(!member)throw new Error('This signed-in user does not have access to the local workspace UUID.');
  }
  cloudMeta().remoteWorkspaceId=wid;
}

async function cloudPushWorkspace({initial=false}={}){
  const client=cloudClient(); if(!client)throw new Error('Supabase is not configured.');
  const session=await cloudSession(); if(!session)throw new Error('Sign in before syncing data.');
  if(cloudSyncRunning) return false;
  cloudSyncRunning=true;
  try{
    await cloudEnsureWorkspace(session.user);
    const wid=workspaceData.workspaceId,snap=cloudSnapshot();
    await cloudSyncScoped('productions',snap.productions,'workspace_id',wid);
    await cloudSyncScoped('people',snap.people,'workspace_id',wid);
    await cloudSyncScoped('assets',snap.assets,'workspace_id',wid);
    for(const prod of workspaceData.productions||[]){
      const pid=prod.production.id;
      for(const table of ['production_people','acts','production_locations','production_assets','prop_usages','presets','calls','production_images','preset_area_photos','preset_checks']){
        await cloudSyncScoped(table,snap[table].filter(r=>r.production_id===pid),'production_id',pid);
      }
    }
    await cloudSyncScoped('asset_reservations',snap.asset_reservations,'workspace_id',wid);
    // Attendance scopes through calls, so synchronize each call independently.
    for(const call of snap.calls) await cloudSyncScoped('attendance',snap.attendance.filter(r=>r.call_id===call.id),'call_id',call.id);
    const stamp=now();
    await cloudCheck(await client.from('workspaces').update({name:workspaceData.organization?.name||'Community Theatre',updated_at:stamp}).eq('id',wid));
    const meta=cloudMeta(); meta.enabled=true; meta.lastSyncedAt=stamp; meta.lastSyncError=''; meta.remoteWorkspaceId=wid;
    workspaceData.updatedAt=stamp;
    await setKV(WORKSPACE_KEY,workspaceData);
    cloudLastMessage=initial?'Local workspace uploaded to Supabase.':'Cloud sync complete.';
    return true;
  }catch(err){
    const meta=cloudMeta(); meta.lastSyncError=cloudErr(err); await setKV(WORKSPACE_KEY,workspaceData); cloudLastMessage=meta.lastSyncError; throw err;
  }finally{ cloudSyncRunning=false; }
}

async function cloudFetchAll(table,filterCol,values){
  const client=cloudClient(); if(!values?.length)return [];
  const {data,error}=await client.from(table).select('*').in(filterCol,values); if(error)throw error; return data||[];
}

async function cloudResolveRemoteWorkspace(){
  const client=cloudClient(),session=await cloudSession(); if(!session)throw new Error('Sign in first.');
  const preferred=workspaceData?.syncMeta?.remoteWorkspaceId || workspaceData?.workspaceId;
  if(preferred){ const {data,error}=await client.from('workspaces').select('*').eq('id',preferred).maybeSingle(); if(error)throw error; if(data)return data; }
  const {data,error}=await client.from('workspaces').select('*').order('updated_at',{ascending:false}).limit(1); if(error)throw error; return data?.[0]||null;
}

async function cloudPullWorkspace(){
  const client=cloudClient(); if(!client)throw new Error('Supabase is not configured.');
  const session=await cloudSession(); if(!session)throw new Error('Sign in before loading cloud data.');
  if(cloudSyncRunning)return false; cloudSyncRunning=true;
  try{
    const w=await cloudResolveRemoteWorkspace(); if(!w)throw new Error('No cloud workspace exists for this account yet. Upload this device first.');
    const wid=w.id;
    const [prods,people,assets,reservations]=await Promise.all([
      cloudCheck(await client.from('productions').select('*').eq('workspace_id',wid)),
      cloudCheck(await client.from('people').select('*').eq('workspace_id',wid)),
      cloudCheck(await client.from('assets').select('*').eq('workspace_id',wid)),
      cloudCheck(await client.from('asset_reservations').select('*').eq('workspace_id',wid))
    ]);
    const pids=(prods||[]).map(p=>p.id);
    const [pp,acts,locs,passets,usages,presets,imgs,areaPhotos,calls,presetChecks]=await Promise.all([
      cloudFetchAll('production_people','production_id',pids),cloudFetchAll('acts','production_id',pids),cloudFetchAll('production_locations','production_id',pids),cloudFetchAll('production_assets','production_id',pids),cloudFetchAll('prop_usages','production_id',pids),cloudFetchAll('presets','production_id',pids),cloudFetchAll('production_images','production_id',pids),cloudFetchAll('preset_area_photos','production_id',pids),cloudFetchAll('calls','production_id',pids),cloudFetchAll('preset_checks','production_id',pids)
    ]);
    const callIds=calls.map(c=>c.id);
    const attendanceRows=await cloudFetchAll('attendance','call_id',callIds);
    const previousMeta=clone(workspaceData?.syncMeta||{}), previousActive=workspaceData?.activeProductionId;
    const newWs={schemaVersion:5,appVersion:APP_VERSION,workspaceId:wid,organization:{id:workspaceData?.organization?.id||newUUID(),name:w.name||'Community Theatre',updatedAt:w.updated_at},activeProductionId:'',productions:[],people:(people||[]).map(x=>({id:x.id,name:x.name,notes:x.notes||'',active:x.active!==false,updatedAt:x.updated_at})),inventory:(assets||[]).map(x=>({id:x.id,assetNumber:x.asset_number||'',name:x.name,aliases:x.aliases||[],category:x.category,trackingMode:x.tracking_mode,quantity:x.quantity,storageLocationId:x.storage_location_id||'',notes:x.notes||'',active:x.active!==false,updatedAt:x.updated_at})),reservations:(reservations||[]).map(x=>({id:x.id,assetId:x.asset_id,productionId:x.production_id,productionPropId:x.production_asset_id||'',quantity:x.quantity,startDate:x.start_date||'',endDate:x.end_date||'',notes:x.notes||'',updatedAt:x.updated_at})),updatedAt:w.updated_at,syncMeta:{...previousMeta,enabled:true,lastSyncedAt:now(),lastSyncError:'',remoteWorkspaceId:wid}};
    for(const pr of prods||[]){
      const pid=pr.id,pa=acts.filter(x=>x.production_id===pid).sort((a,b)=>a.sort_order-b.sort_order),pl=locs.filter(x=>x.production_id===pid).sort((a,b)=>a.sort_order-b.sort_order),ppl=pp.filter(x=>x.production_id===pid),props=passets.filter(x=>x.production_id===pid),movs=usages.filter(x=>x.production_id===pid),pre=presets.filter(x=>x.production_id===pid),pi=imgs.filter(x=>x.production_id===pid),ap=areaPhotos.filter(x=>x.production_id===pid),pc=calls.filter(x=>x.production_id===pid),pchecks=presetChecks.filter(x=>x.production_id===pid);
      const prod={schemaVersion:5,appVersion:APP_VERSION,imageBundleVersion:'cloud',production:{id:pid,title:pr.title,company:pr.company||'',startDate:pr.start_date||'',endDate:pr.end_date||'',status:pr.status||'active',dataAuthority:pr.data_authority||'',updatedAt:pr.updated_at},acts:pa.map(x=>({id:x.id,name:x.name,order:x.sort_order,notes:x.notes||'',updatedAt:x.updated_at})),locations:pl.map(x=>({id:x.id,name:x.name,order:x.sort_order,active:x.active!==false,updatedAt:x.updated_at})),people:ppl.map(x=>({id:x.id,personId:x.person_id||'',name:x.name_snapshot,role:x.role||'',group:x.group_name||'',active:x.active!==false,notes:x.notes||'',updatedAt:x.updated_at})),props:props.map(x=>({id:x.id,name:x.display_name,assetId:x.asset_id||null,notes:x.notes||'',ready:!!x.ready,review:!!x.needs_review,sourcePage:x.source_page||'',sourceRow:x.source_row||'',updatedAt:x.updated_at})),movements:movs.map(x=>({id:x.id,propId:x.production_asset_id||'',propName:props.find(p=>p.id===x.production_asset_id)?.display_name||'',act:x.act_id||'',scene:x.scene||'',page:x.page||'',person:x.person_label||'',from:x.from_label||'',to:x.to_label||'',cue:x.cue||'',action:x.action||'',notes:x.notes||'',order:x.sort_order,review:!!x.needs_review,fromLocationId:x.from_location_id||'',toLocationId:x.to_location_id||'',updatedAt:x.updated_at})),presets:pre.map(x=>({id:x.id,act:x.act_id||'',locationId:x.location_id||'',area:pl.find(l=>l.id===x.location_id)?.name||'',propId:x.production_asset_id||'',item:x.item,critical:!!x.critical,notes:x.notes||'',kind:x.kind||'',source:x.source||'',updatedAt:x.updated_at})),images:{act1:[],act2:[],custom:[]},areaPhotos:{},attendance:{},checks:{},settings:{attendanceStatuses:['waiting','here','late','missing','excused','notcalled']}};
      const firstAct=prod.acts[0]?.id,secondAct=prod.acts[1]?.id;
      for(const im of pi){ const meta={id:im.id,label:im.label||'',scope:im.act_id||'',source:im.source||'',src:im.storage_path||'',hidden:!!im.hidden,updatedAt:im.updated_at}; if(im.source==='custom')prod.images.custom.push(meta); else if(im.act_id===secondAct)prod.images.act2.push(meta); else prod.images.act1.push(meta); }
      for(const rec of ap){ const key=`${rec.act_id||''}::${rec.location_id||''}`; prod.areaPhotos[key]={id:rec.id,act:rec.act_id||'',actId:rec.act_id||'',locationId:rec.location_id||'',area:pl.find(l=>l.id===rec.location_id)?.name||'',imageRefs:rec.image_ids||[],updatedAt:rec.updated_at}; }
      for(const call of pc){ const bucket={}; for(const ar of attendanceRows.filter(a=>a.call_id===call.id)) bucket[ar.production_person_id]=ar.status; prod.attendance[call.call_date]=bucket; previousMeta.callIds ||= {}; previousMeta.callIds[pid] ||= {}; previousMeta.callIds[pid][call.call_date]=call.id; }
      for(const ck of pchecks){ prod.checks[ck.check_date] ||= {}; prod.checks[ck.check_date][ck.preset_id]=!!ck.checked; }
      newWs.productions.push(ensureShowStructure(prod));
    }
    newWs.activeProductionId=newWs.productions.some(p=>p.production.id===previousActive)?previousActive:(newWs.productions[0]?.production.id||'');
    workspaceData=ensureWorkspaceStructure(newWs); workspaceData.syncMeta={...workspaceData.syncMeta,...previousMeta,enabled:true,lastSyncedAt:now(),lastSyncError:'',remoteWorkspaceId:wid};
    setActiveRefs(); await setKV(WORKSPACE_KEY,workspaceData); cloudLastMessage='Loaded latest workspace from Supabase.'; return true;
  }catch(err){ cloudMeta().lastSyncError=cloudErr(err); await setKV(WORKSPACE_KEY,workspaceData); cloudLastMessage=cloudErr(err); throw err; }
  finally{ cloudSyncRunning=false; }
}

function scheduleCloudSync(reason='change'){
  if(!workspaceData?.syncMeta?.enabled || !navigator.onLine)return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer=setTimeout(async()=>{ try{ if(await cloudSession())await cloudPushWorkspace(); }catch(err){ console.warn('Cloud sync failed',reason,err); } },900);
}

async function cloudStartup(){
  const client=cloudClient(); if(!client)return;
  client.auth.onAuthStateChange((event,session)=>{ if(session && workspaceData?.syncMeta?.enabled) scheduleCloudSync(`auth:${event}`); });
  const session=await cloudSession(); if(!session || !workspaceData?.syncMeta?.enabled)return;
  try{
    const remote=await cloudResolveRemoteWorkspace();
    if(!remote)return;
    const localTime=Date.parse(workspaceData.updatedAt||0)||0,remoteTime=Date.parse(remote.updated_at||0)||0;
    if(remoteTime>localTime) await cloudPullWorkspace(); else if(localTime>remoteTime) await cloudPushWorkspace();
  }catch(err){ cloudMeta().lastSyncError=cloudErr(err); await setKV(WORKSPACE_KEY,workspaceData); }
}

async function cloudUiAction(fn){
  const status=$('#cloudActionStatus');
  try{ if(status){status.className='notice';status.innerHTML='<strong>Working…</strong>';} await fn(); if(status){status.className='notice oknotice';status.innerHTML=`<strong>${esc(cloudLastMessage||'Done.')}</strong>`;} setTimeout(()=>{ if(currentView==='manage'&&manageTab==='database')renderManageDatabase(); },500); }
  catch(err){ if(status){status.className='notice';status.innerHTML=`<strong>Cloud operation failed.</strong><div class="smalltext">${esc(cloudErr(err))}</div>`;} }
}

async function renderCloudDatabasePanel(){
  const cfg=window.STM_SUPABASE||{},st=await cloudConnectionStatus(),session=await cloudSession().catch(()=>null),meta=cloudMeta();
  const authHtml=session?`<div class="notice oknotice"><strong>Signed in</strong><div class="smalltext">${esc(session.user.email||'Authenticated user')}</div></div><div class="toolbar"><button id="cloudSignOut" class="btn secondary compact">Sign out</button></div>`:`<div class="notice"><strong>Sign in to enable shared data.</strong><div class="smalltext">Use a Supabase Auth account. If this is the first account, create it here.</div></div><div class="formgrid"><label>Email<input id="cloudEmail" type="email" autocomplete="email"></label><label>Password<input id="cloudPassword" type="password" autocomplete="current-password"></label></div><div class="toolbar"><button id="cloudSignIn" class="btn primary compact">Sign in</button><button id="cloudSignUp" class="btn secondary compact">Create account</button></div>`;
  const syncHtml=session?`<section class="manage-section" style="margin-top:12px"><div class="manage-section-head"><strong>Workspace sync</strong><span class="tag ${meta.enabled?'critical':'review'}">${meta.enabled?'enabled':'not enabled'}</span></div><div style="padding:14px"><div class="smalltext">${meta.enabled?'Supabase is the shared source of truth. IndexedDB remains the offline working copy.':'Your existing local workspace has not been migrated yet.'}</div><div class="toolbar" style="margin-top:12px">${meta.enabled?`<button id="cloudSyncNow" class="btn primary compact">Sync now</button><button id="cloudPull" class="btn secondary compact">Reload from Supabase</button>`:`<button id="cloudMigrate" class="btn primary compact">Upload this workspace to Supabase</button><button id="cloudPull" class="btn secondary compact">Load existing cloud workspace</button>`}</div>${meta.lastSyncedAt?`<div class="filemeta">Last synced: ${esc(new Date(meta.lastSyncedAt).toLocaleString())}</div>`:''}${meta.lastSyncError?`<div class="notice"><strong>Last sync error</strong><div class="smalltext">${esc(meta.lastSyncError)}</div></div>`:''}<div id="cloudActionStatus"></div><div class="smalltext muted" style="margin-top:12px">Structured production data, inventory, presets, movements, reservations, attendance and nightly preset checks sync in v0.7. Custom image files remain local for now; their metadata is synced.</div></div></section>`:'';
  manageBody(`<section class="manage-section"><div class="manage-section-head"><strong>Supabase database</strong><span class="tag ${st.ok?'critical':'review'}">${st.ok?'connected':'error'}</span></div><div style="padding:14px"><div class="filemeta"><strong>Project</strong><br>${esc(cfg.url||'Not configured')}</div><div class="notice ${st.ok?'oknotice':''}" style="margin-top:12px"><strong>${st.ok?'Database connection successful.':'Database not ready.'}</strong><div class="smalltext">${esc(st.message||'')}</div></div>${authHtml}</div></section>${syncHtml}`);
  $('#cloudSignIn')?.addEventListener('click',()=>cloudUiAction(async()=>{const e=$('#cloudEmail').value,p=$('#cloudPassword').value;if(!e||!p)throw new Error('Enter email and password.');await cloudSignIn(e,p);cloudLastMessage='Signed in.';}));
  $('#cloudSignUp')?.addEventListener('click',()=>cloudUiAction(async()=>{const e=$('#cloudEmail').value,p=$('#cloudPassword').value;if(!e||!p)throw new Error('Enter email and password.');if(p.length<6)throw new Error('Use a password with at least 6 characters.');const data=await cloudSignUp(e,p);cloudLastMessage=data.session?'Account created and signed in.':'Account created. Check your email if Supabase requires confirmation, then sign in.';}));
  $('#cloudSignOut')?.addEventListener('click',()=>cloudUiAction(async()=>{await cloudSignOut();cloudLastMessage='Signed out. Local offline data remains on this device.';}));
  $('#cloudMigrate')?.addEventListener('click',()=>{if(!confirm('Upload this device\'s current workspace to Supabase and enable cloud sync? Existing UUIDs will be preserved.'))return;cloudUiAction(()=>cloudPushWorkspace({initial:true}));});
  $('#cloudSyncNow')?.addEventListener('click',()=>cloudUiAction(()=>cloudPushWorkspace()));
  $('#cloudPull')?.addEventListener('click',()=>{if(meta.enabled&&!confirm('Reload from Supabase? Unsynced local changes could be replaced.'))return;cloudUiAction(async()=>{await cloudPullWorkspace();$('#productionTitle').textContent=showData?.production?.title||'Stage Manager';});});
}
