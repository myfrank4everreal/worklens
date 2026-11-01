let state, currentProjectId=null, timelineDate=new Date().toISOString().slice(0,10), timelineData=null, askHistory=[];
// Project-detail "Milestones and tasks" UI state. Kept module-level (not derived from the DOM)
// so a filter, a fold, or a search stays put across the 15s auto-reload and after any mutation
// re-renders the section, instead of resetting every time state.projects changes underneath it.
let projectDetailFilterText='', projectDetailHideDone=false;
const collapsedMilestones=new Set(), seenMilestoneIds=new Set();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const duration = seconds => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds/60)}m` : `${(seconds/3600).toFixed(1)}h`;
const time = value => new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
function timeAgo(iso){
  const mins=Math.round((Date.now()-new Date(iso).getTime())/60000);
  if(mins<1)return 'just now'; if(mins<60)return `${mins}m ago`;
  const hours=Math.round(mins/60); if(hours<24)return `${hours}h ago`;
  return `${Math.round(hours/24)}d ago`;
}
// Heuristic resume brief — no model call: what you last touched on this project, and the most
// likely next action, derived from what's already open and un-done. Cheapest of the coaching
// features because it needs no new infrastructure and costs nothing to run on every page view.
function resumeBriefHtml(p){
  if(!p.last_activity_at&&!p.next_task_title)return '';
  const last=p.last_activity_at?`You last worked on this ${timeAgo(p.last_activity_at)}${p.last_activity_title?`, in <strong>${esc(p.last_activity_title)}</strong>`:''}.`:"You haven't recorded activity on this yet.";
  const next=p.next_task_title?`Next up: <strong>${esc(p.next_task_title)}</strong>.`:'No open tasks — add one, or review the repository for fresh ones.';
  return `<div class="resume-brief"><h4>Resume brief</h4><p>${last} ${next}</p></div>`;
}
async function request(url, options={}) { const res=await fetch(url,{headers:{'Content-Type':'application/json'},...options}); const data=await res.json(); if(!res.ok) throw new Error(data.error||'Request failed'); return data; }
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2400)}
function closeNav(){ $('#sidebar').classList.remove('open'); $('#navBackdrop').classList.remove('open'); $('#menuButton').setAttribute('aria-expanded','false') }
function setFolder(folderName){
  const clean=String(folderName||'').replace(/[\\/]$/,'').split(/[\\/]/).pop(); if(!clean)return;
  const name=$('#modalFields [name="name"]'), root=$('#modalFields [name="rootPath"]'), keywords=$('#modalFields [name="keywords"]');
  if(name&&!name.value)name.value=clean; if(root)root.value=clean; if(keywords&&!keywords.value)keywords.value=clean;
  const label=$('#selectedFolder'); if(label)label.innerHTML=`<strong>${esc(clean)}</strong>Selected project folder`;
}
async function pickNativeFolder(expectedName=''){
  toast(expectedName?`Confirm the full path for ${expectedName} in File Explorer.`:'Choose the project folder in File Explorer.');
  const result=await request('/api/select-folder',{method:'POST',body:'{}'});if(result.cancelled)return false;
  const name=$('#modalFields [name="name"]'), root=$('#modalFields [name="rootPath"]'), keywords=$('#modalFields [name="keywords"]');
  if(name&&!name.value)name.value=result.name;if(root)root.value=result.path;if(keywords&&!keywords.value)keywords.value=result.name;
  const label=$('#selectedFolder');if(label)label.innerHTML=`<strong>${esc(result.name)}</strong>${esc(result.path)}`;return true;
}
async function load(){state=await request('/api/dashboard');render()}
function render(){
  const productive=state.activities.filter(x=>x.source!=='idle');
  const total=state.totals.reduce((n,x)=>n+x.seconds,0), assigned=productive.filter(x=>x.project_id).length;
  $('#recordBtn').textContent=state.recording?'● Recording':'○ Start recording'; $('#recordBtn').classList.toggle('on',state.recording);
  $('#monitorStatus').classList.toggle('on',state.recording); $('#monitorStatus span').textContent=state.recording?'Monitoring on':'Monitoring off';
  $('#extensionKey').textContent=state.extension.key; $('#extensionStatus').textContent=state.extension.lastSyncAt?`Last synced ${new Date(state.extension.lastSyncAt).toLocaleString()} · ${state.extension.lastSyncCount} new visits`:'Not connected yet · install the extension and paste this key.';
  $('#focusTime').textContent=`${duration(total)} tracked`; $('#focusSummary').textContent=state.totals[0]?`Most time went to ${state.totals[0].name}.${state.idleSeconds?` ${duration(state.idleSeconds)} idle.`:''}`:'Start recording to build your work memory.';
  $('#dateLabel').textContent=new Date(`${state.date}T12:00:00`).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'}).toUpperCase();
  $('#stats').innerHTML=[['Projects',state.projects.length],['Open tasks',state.tasks.filter(x=>x.status!=='done').length],['Activities',productive.length],['Assigned',productive.length?`${Math.round(assigned/productive.length*100)}%`:'0%']].map(([a,b])=>`<div class="stat"><strong>${b}</strong><span>${a}</span></div>`).join('');
  const activityRows=productive.slice(0,6).map(a=>row(`<span class="dot" style="background:${a.project_color||'#9a9d96'}"></span>`,`<strong>${esc(a.window_title)}</strong><small>${esc(a.project_name||'Unassigned')} · ${esc(a.app_name)}</small>`,time(a.captured_at))).join('');
  $('#recent').innerHTML=activityRows||empty('No activity captured yet.');
  renderTimeline();
  const open=state.tasks.filter(x=>x.status!=='done'); $('#openTasks').innerHTML=open.slice(0,6).map(taskRow).join('')||empty('Nothing waiting. Add your next action.'); $('#taskList').innerHTML=state.tasks.map(taskRow).join('')||empty('No tasks yet.');
  $('#projectGrid').innerHTML=state.projects.map(p=>`<article class="card project-card"><div class="project-top"><span class="dot" style="background:${p.color}"></span><div><button class="project-action" data-edit-project="${p.id}">Edit</button><button class="project-action danger" data-delete-project="${p.id}">Remove</button></div></div><h3>${esc(p.name)}</h3><p class="description">${esc(p.description||p.progress_note||'No description yet. Analyze the repository to build its plan.')}</p><div class="progress-meta"><strong>${p.progress}% complete</strong><span>${p.done_tasks}/${p.total_tasks} tasks</span></div><div class="progress"><i style="width:${p.progress}%;background:${p.color}"></i></div><div class="card-footer"><span class="pill">${p.open_tasks} open</span><button class="view-project" data-view-project="${p.id}">View project</button></div></article>`).join('')||empty('Create a project and add identifying keywords.');
  const focusSelect=$('#focusProject');
  if(focusSelect&&document.activeElement!==focusSelect){focusSelect.innerHTML=`<option value="">Not set</option>${state.projects.map(p=>`<option value="${p.id}" ${state.focusProjectId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}`}
  const driftSelect=$('#driftMode'); if(driftSelect&&document.activeElement!==driftSelect)driftSelect.value=state.driftMode||'gentle';
  const termsField=$('#sensitiveTerms'); if(termsField&&document.activeElement!==termsField)termsField.value=state.sensitiveTerms||'';
  $('#driftBanner').innerHTML=state.drift?`<div class="drift-banner"><span>You've been in <strong>${esc(state.drift.currentProjectName)}</strong> for ${state.drift.minutes}+ minutes — focus is set to <strong>${esc(state.drift.focusProjectName)}</strong>.</span><button id="clearFocus">Clear focus</button></div>`:'';
  const focusedProject=state.focusProjectId?state.projects.find(p=>p.id===state.focusProjectId):null;
  $('#resumeBrief').innerHTML=focusedProject?resumeBriefHtml(focusedProject):'';
  renderReminders();
  renderModels(); if(currentProjectId)renderProjectDetail(currentProjectId);
}
function confidenceBadge(a){
  if(a.source==='idle'||a.confidence===undefined||a.confidence===null)return '';
  if(String(a.source).endsWith('-corrected'))return '';
  if(a.confidence>=0.7)return '';
  const cls=a.confidence>0?'confidence-mid':'confidence-low';
  return `<span class="confidence-badge ${cls}">${a.confidence>0?'Low confidence':'Unclassified'}</span>`;
}
function reassignSelect(a){
  const options=`<option value="">Unassigned</option>${state.projects.map(p=>`<option value="${p.id}" ${a.project_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}`;
  return `<select class="reassign" data-reassign="${a.id}" title="Correct the project this was classified as">${options}</select>`;
}
function activityRow(a){
  const idle=a.source==='idle';
  const lead=`<span class="dot" style="background:${idle?'#c7cabf':(a.project_color||'#9a9d96')}"></span>`;
  const main=`<strong>${esc(a.window_title)}</strong><small>${idle?'Idle':esc(a.project_name||'Unassigned')}${idle?'':` · ${esc(a.app_name)}`} · ${duration(a.duration_seconds)} ${confidenceBadge(a)}</small>`;
  const tail=idle?time(a.captured_at):`${reassignSelect(a)}<span class="time">${time(a.captured_at)}</span>`;
  return `<div class="row${idle?' idle-row':''}">${lead}<div class="row-main">${main}</div>${idle?`<span class="time">${tail}</span>`:tail}</div>`;
}
async function renderTimeline(){
  const isToday=timelineDate===state.date;
  const data=isToday?state:(timelineData&&timelineData.date===timelineDate?timelineData:await request(`/api/dashboard?date=${timelineDate}`));
  if(!isToday)timelineData=data;
  $('#timelineDate').value=timelineDate;
  $('#timelineNext').disabled=timelineDate>=new Date().toISOString().slice(0,10);
  $('#timelineList').innerHTML=data.activities.length?data.activities.map(activityRow).join(''):empty('No evidence recorded for this day.');
}
function renderReminders(){
  const now=Date.now();
  $('#reminderList').innerHTML=state.reminders.length?state.reminders.map(r=>{
    const due=new Date(r.remind_at).getTime(), soon=due-now<3600000;
    return `<div class="reminder-row${soon?' due-soon':''}"><div class="row-main"><strong>${esc(r.text)}</strong><small>${esc(r.project_name||'No project')} · ${new Date(r.remind_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></div><button class="dismiss" data-dismiss-reminder="${r.id}">Dismiss</button></div>`;
  }).join(''):empty('No reminders set.');
}
function renderModels(){const totals=state.aiTotals||{};$('#modelStats').innerHTML=[['Requests',totals.requests||0],['Tokens',Number(totals.tokens||0).toLocaleString()],['Estimated spend',`$${Number(totals.cost||0).toFixed(4)}`],['ZDR protected',`${totals.requests?Math.round((totals.secure_requests||0)/totals.requests*100):100}%`]].map(([a,b])=>`<div class="stat"><strong>${b}</strong><span>${a}</span></div>`).join('');$('#modelActivity').innerHTML=state.aiUsage.map(u=>row(`<span class="dot ${u.secure?'model-secure':'model-retained'}">●</span>`,`<strong>${esc(u.operation)} · ${esc(u.model)}</strong><small>${Number(u.prompt_tokens+u.completion_tokens).toLocaleString()} tokens · $${Number(u.cost).toFixed(5)} · ${u.secure?'Zero Data Retention':'Retention allowed by consent'}</small>`,new Date(u.created_at+'Z').toLocaleString())).join('')||empty('No model calls recorded yet.')}
// A task row scoped to the project-detail milestone/backlog lists: it wraps the shared
// `taskRow` markup in a filterable container and adds a per-task milestone-reassignment
// select, so moving a task off a milestone (or out of the backlog) never requires a modal.
function detailTaskRow(t,milestoneOptions){
  const options=[{id:'',label:'Backlog'},...milestoneOptions].map(o=>`<option value="${o.id}" ${String(t.milestone_id||'')===String(o.id)?'selected':''}>${esc(o.label)}</option>`).join('');
  const control=`<select class="task-milestone-select" data-task-milestone="${t.id}" title="Move to a different milestone">${options}</select>`;
  const main=`<strong class="${t.status==='done'?'done':''}" title="${esc(t.title)}">${esc(t.title)} ${t.manual_intervention?'<em class="manual-badge">Manual intervention</em>':''}</strong><small>${t.evidence?esc(t.evidence):'No evidence recorded'}</small>`;
  return `<div class="detail-task-row${t.status==='done'?' is-done':''}" data-search-text="${esc(t.title.toLowerCase())}">${row(`<input class="check" type="checkbox" data-task="${t.id}" ${t.status==='done'?'checked':''}>`,main,control)}</div>`;
}
// Text-and-status filter over the already-rendered milestone/backlog DOM (toggling a class,
// never touching innerHTML) so typing in the filter box doesn't rebuild the input out from
// under the user's own cursor.
function applyDetailFilter(){
  const root=$('#projectDetail'); if(!root)return;
  const q=projectDetailFilterText.trim().toLowerCase();
  root.querySelectorAll('.detail-task-row').forEach(rowEl=>{
    const show=(!q||rowEl.dataset.searchText.includes(q))&&!(projectDetailHideDone&&rowEl.classList.contains('is-done'));
    rowEl.classList.toggle('filtered-out',!show);
  });
  root.querySelectorAll('.detail-milestone').forEach(block=>{
    const ownMatches=!q||block.dataset.searchText.includes(q);
    const hiddenByDone=projectDetailHideDone&&block.classList.contains('is-done');
    const visibleChildren=block.querySelectorAll('.detail-task-row:not(.filtered-out)').length;
    block.classList.toggle('filtered-out',hiddenByDone||!(ownMatches||visibleChildren>0));
  });
  const backlog=root.querySelector('.backlog-section');
  if(backlog){
    const ownMatches=!q||backlog.dataset.searchText.includes(q);
    const visibleChildren=backlog.querySelectorAll('.detail-task-row:not(.filtered-out)').length;
    backlog.classList.toggle('filtered-out',!(ownMatches||visibleChildren>0));
  }
}
function renderProjectDetail(id){
  const p=state.projects.find(x=>x.id===Number(id));if(!p)return;
  const milestones=state.milestones.filter(m=>m.project_id===p.id);
  const tasks=state.tasks.filter(t=>t.project_id===p.id);
  const manual=tasks.filter(t=>t.manual_intervention&&t.status!=='done');
  const milestoneOptions=state.milestones.filter(m=>m.project_id===p.id).map(m=>({id:m.id,label:m.title}));

  // Preserve the filter box's live value/focus/cursor and the hide-completed toggle across a
  // rebuild — both are read from the outgoing DOM (if present) before it's replaced.
  const outgoingFilter=$('#milestoneFilter');
  const filterWasFocused=document.activeElement===outgoingFilter;
  const filterSelection=filterWasFocused?[outgoingFilter.selectionStart,outgoingFilter.selectionEnd]:null;
  if(outgoingFilter)projectDetailFilterText=outgoingFilter.value;
  const outgoingHideDone=$('#hideCompletedTasks');
  if(outgoingHideDone)projectDetailHideDone=outgoingHideDone.checked;

  // A milestone gets a one-time default fold state the first time it's ever rendered (open if
  // still in progress, collapsed if already done) and keeps whatever the user sets after that.
  milestones.forEach(m=>{ if(!seenMilestoneIds.has(m.id)){ seenMilestoneIds.add(m.id); if(m.status==='done')collapsedMilestones.add(m.id); } });

  const milestoneBlocks=milestones.map(m=>{
    const linked=tasks.filter(t=>t.milestone_id===m.id);
    const doneCount=linked.filter(t=>t.status==='done').length;
    const collapsed=collapsedMilestones.has(m.id);
    const searchText=esc([m.title,m.evidence,...linked.map(t=>t.title)].join(' ').toLowerCase());
    return `<div class="detail-milestone${m.status==='done'?' is-done':''}${collapsed?' collapsed':''}" data-search-text="${searchText}">
      <header>
        <button type="button" class="milestone-toggle" data-toggle-milestone="${m.id}" aria-label="${collapsed?'Expand':'Collapse'} milestone">${collapsed?'▸':'▾'}</button>
        <input type="checkbox" data-milestone="${m.id}" ${m.status==='done'?'checked':''}>
        <div class="milestone-heading"><strong class="${m.status==='done'?'done':''}">${esc(m.title)}</strong><small>${esc(m.evidence||'Awaiting evidence')}</small></div>
        <span class="milestone-count">${doneCount}/${linked.length}</span>
        <button type="button" class="milestone-add-task" data-add-task="${p.id}" data-milestone-id="${m.id}" title="Add a task to this milestone">+ Task</button>
      </header>
      <div class="detail-tasks">${linked.map(t=>detailTaskRow(t,milestoneOptions)).join('')||empty('No tasks assigned to this milestone.')}</div>
    </div>`;
  }).join('');

  const backlogTasks=tasks.filter(t=>!t.milestone_id);
  const backlogSearch=esc(['backlog',...backlogTasks.map(t=>t.title)].join(' ').toLowerCase());
  const backlogHtml=`<div class="backlog-section" data-search-text="${backlogSearch}">
    <header class="backlog-header"><div><strong>Backlog</strong><small>Not yet assigned to a milestone</small></div><button type="button" class="milestone-add-task" data-add-task="${p.id}" title="Add a task to the backlog">+ Task</button></header>
    <div class="detail-tasks">${backlogTasks.map(t=>detailTaskRow(t,milestoneOptions)).join('')||empty('Nothing in the backlog.')}</div>
  </div>`;

  $('#projectDetail').innerHTML=`${resumeBriefHtml(p)}<div class="card detail-hero"><span class="eyebrow">PROJECT</span><h2>${esc(p.name)}</h2><p>${esc(p.description||p.progress_note||'No project description.')}</p><div class="progress-meta"><strong>${p.progress}% complete</strong><span>${p.done_tasks}/${p.total_tasks} tasks · ${p.done_milestone_weight}/${p.milestone_weight} milestone weight</span></div><div class="progress"><i style="width:${p.progress}%;background:${p.color}"></i></div><div class="card-footer"><small class="root-path" title="${esc(p.root_path||'')}">${esc(p.root_path||'No repository path configured')}</small><div><a class="project-action" href="/api/projects/${p.id}/brief.pdf" target="_blank" rel="noopener" title="A milestones/tasks brief formatted for a coding agent to implement from">Export as PDF</a><button class="project-action" data-save-brief="${p.id}" title="Writes WORKLENS-BRIEF.md into this project's own repository folder, overwriting any previous version">Save brief to repository</button><button class="project-action" data-edit-project="${p.id}">Edit project</button><button class="analyze-project" data-analyze-project="${p.id}">Review repository</button></div></div></div><div class="detail-layout"><div class="card"><div class="section-title"><h3>Milestones and tasks</h3><span>${milestones.filter(m=>m.status==='done').length}/${milestones.length} milestones complete</span></div><div class="detail-toolbar"><div class="detail-filter-bar"><input type="search" id="milestoneFilter" placeholder="Filter milestones and tasks…" value="${esc(projectDetailFilterText)}"><label class="hide-done-toggle"><input type="checkbox" id="hideCompletedTasks" ${projectDetailHideDone?'checked':''}> Hide completed</label></div><button type="button" class="milestone-add-task" data-import-plan="${p.id}" title="Turn a pasted runbook or step-by-step guide into milestones and tasks">Import plan</button><button type="button" class="milestone-add-task" data-add-milestone="${p.id}">+ Milestone</button></div>${milestoneBlocks||empty('Run repository review, or add a milestone, to start organizing tasks.')}${backlogHtml}</div><div><div class="card manual-panel"><div class="section-title"><h3>Manual intervention</h3><span>${manual.length}</span></div>${manual.map(t=>taskRow(t)).join('')||empty('No manual intervention currently required.')}</div><div class="card review"><h3>Latest project assessment</h3><p>${esc(p.progress_note||'No assessment yet.')}</p>${p.last_analysis_at?`<small>Last reviewed ${new Date(p.last_analysis_at+'Z').toLocaleString()}</small>`:''}</div></div></div>`;

  const filterInput=$('#milestoneFilter');
  if(filterInput){
    if(filterWasFocused){ filterInput.focus(); if(filterSelection)filterInput.setSelectionRange(...filterSelection); }
    filterInput.oninput=()=>{ projectDetailFilterText=filterInput.value; applyDetailFilter(); };
  }
  const hideDoneInput=$('#hideCompletedTasks');
  if(hideDoneInput)hideDoneInput.onchange=()=>{ projectDetailHideDone=hideDoneInput.checked; applyDetailFilter(); };
  applyDetailFilter();
}
function row(lead,main,end){return `<div class="row">${lead}<div class="row-main">${main}</div><span class="time">${end}</span></div>`}
function taskRow(t){return row(`<input class="check" type="checkbox" data-task="${t.id}" ${t.status==='done'?'checked':''}>`,`<strong class="${t.status==='done'?'done':''}" title="${esc(t.title)}">${esc(t.title)} ${t.manual_intervention?'<em class="manual-badge">Manual intervention</em>':''}</strong><small>${esc(t.project_name||'No project')}${t.evidence?` · ${esc(t.evidence)}`:''}</small>`,'')}
function empty(text){return `<div class="empty">${text}</div>`}
function show(view){document.querySelectorAll('.view,.nav').forEach(x=>x.classList.remove('active'));$(`#${view}`).classList.add('active');document.querySelector(`.nav[data-view="${view}"]`)?.classList.add('active');$('#title').textContent={today:'Your work, in focus.',projects:'Every workstream, visible.','project-detail':'Project intelligence',tasks:'Turn intent into action.',timeline:'The evidence behind your day.',ask:'Your work, recalled.',models:'Know what your AI is doing.',settings:'Privacy and integrations.',brands:'Every brand, every account.',studio:'Cut, layer, export.',voice:'One voice per character.'}[view]||'Workstation'}
function askBubble(role,html){return `<div class="ask-msg ${role}">${html}</div>`}
function renderAsk(){$('#askThread').innerHTML=askHistory.length?askHistory.map(m=>askBubble(m.role,m.html)).join(''):empty('Ask about your own history — "what was I working on yesterday", "what\'s blocked on Project Atlas", "when did I last touch the auth bug".');$('#askThread').scrollTop=$('#askThread').scrollHeight}
function modal(type, project=null, context={}){
  const projectOptions=`<option value="">No project</option>${state.projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}`;
  $('#modalTitle').textContent=type==='project'?(project?'Edit project':'Create project'):type==='milestone'?'Add verified milestone':type==='reminder'?'Add reminder':type==='import-plan'?'Import a plan':'Add task';
  $('#modalFields').innerHTML=type==='project'?`<label>Project folder</label><div class="folder-picker"><input name="rootPath" placeholder="Choose or drop a folder"><button type="button" id="chooseFolder">Browse…</button></div><div id="selectedFolder" class="folder-drop"><strong>Drop project folder here</strong>or choose it with File Explorer</div><label>Project name</label><input name="name" required autofocus placeholder="Filled from folder name"><label>Description</label><textarea name="description"></textarea><label>Classification keywords <small>comma separated</small></label><input name="keywords" placeholder="folder name, repository, client, domain"><label>Color</label><input name="color" type="color" value="#7c5cff">`:type==='milestone'?`<label>Project</label><select name="projectId" required>${projectOptions}</select><label>Milestone</label><input name="title" required autofocus placeholder="Authentication tests passing"><label>Weight</label><input name="weight" type="number" min="1" max="20" value="1"><label>Completion evidence</label><input name="evidence" placeholder="Test, commit, file, or acceptance criterion">`:type==='reminder'?`<label>Reminder</label><input name="text" required autofocus placeholder="Follow up on the client proposal"><label>Project</label><select name="projectId">${projectOptions}</select><label>Remind at</label><input name="remindAt" type="datetime-local" required>`:type==='import-plan'?`<label>Paste an operational plan, runbook, or step-by-step guide</label><textarea name="text" rows="16" required placeholder="Phase 1: ...&#10;1. First step&#10;2. Second step&#10;&#10;Phase 2: ..."></textarea>`:`<label>Task</label><input name="title" required autofocus><label>Project</label><select name="projectId">${projectOptions}</select><label>Milestone</label><select name="milestoneId"><option value="">Backlog (no milestone)</option></select><label>Due date</label><input name="dueAt" type="datetime-local">`;
  $('#modalForm').dataset.type=type; $('#modalForm').dataset.projectId=project?.id||''; $('#modal').showModal();
  if(type==='project'){setupFolderDrop();if(project){$('#modalFields [name="rootPath"]').value=project.root_path||'';$('#modalFields [name="name"]').value=project.name;$('#modalFields [name="description"]').value=project.description||'';$('#modalFields [name="keywords"]').value=project.keywords||'';$('#modalFields [name="color"]').value=project.color||'#7c5cff';if(project.root_path)$('#selectedFolder').innerHTML=`<strong>${esc(project.name)}</strong>${esc(project.root_path)}`}}
  if(type==='milestone'&&context.projectId)$('#modalFields [name="projectId"]').value=context.projectId;
  if(type==='import-plan'&&context.projectId)$('#modalForm').dataset.projectId=context.projectId;
  if(type==='task'){
    // Opened from a project's own "Milestones and tasks" section, the project (and often the
    // milestone) is already known — pre-fill both instead of making the person pick again, and
    // keep the milestone list in sync if they change the project from here.
    const projectSelect=$('#modalFields [name="projectId"]');
    if(context.projectId)projectSelect.value=context.projectId;
    const syncMilestoneOptions=()=>{
      const pid=Number(projectSelect.value)||null;
      const options=pid?state.milestones.filter(m=>m.project_id===pid):[];
      $('#modalFields [name="milestoneId"]').innerHTML=`<option value="">Backlog (no milestone)</option>${options.map(m=>`<option value="${m.id}">${esc(m.title)}</option>`).join('')}`;
      if(context.milestoneId)$('#modalFields [name="milestoneId"]').value=context.milestoneId;
    };
    projectSelect.addEventListener('change',syncMilestoneOptions);
    syncMilestoneOptions();
  }
}
function setupFolderDrop(){const zone=$('#selectedFolder');['dragenter','dragover'].forEach(name=>zone.addEventListener(name,e=>{e.preventDefault();zone.classList.add('dragging')}));['dragleave','drop'].forEach(name=>zone.addEventListener(name,e=>{e.preventDefault();zone.classList.remove('dragging')}));zone.addEventListener('drop',async e=>{const item=[...e.dataTransfer.items].find(x=>x.kind==='file');const entry=item?.webkitGetAsEntry?.();if(entry?.isDirectory){setFolder(entry.name);await pickNativeFolder(entry.name)}else toast('Drop a folder, not an individual file.')})}
document.addEventListener('click',async e=>{try{
  const menuTrigger=e.target.closest?.('#menuButton'); if(menuTrigger){const open=$('#sidebar').classList.toggle('open');$('#navBackdrop').classList.toggle('open',open);menuTrigger.setAttribute('aria-expanded',String(open))} if(e.target.id==='navBackdrop')closeNav();
  if(e.target.matches('.nav')){show(e.target.dataset.view);closeNav()} if(e.target.dataset.goto)show(e.target.dataset.goto);
  if(e.target.id==='recordBtn'){await request('/api/recording',{method:'POST',body:JSON.stringify({enabled:!state.recording})});await load()}
  if(['newProject'].includes(e.target.id))modal('project'); if(['newTask','quickTask'].includes(e.target.id))modal('task'); if(e.target.id==='newMilestone')modal('milestone'); if(e.target.id==='newReminder')modal('reminder');
  if(e.target.id==='aiReview'){e.target.disabled=true;e.target.textContent='Reviewing…';const data=await request('/api/ai-review',{method:'POST',body:JSON.stringify({date:state.date})});$('#reviewTitle').textContent='AI work review';$('#reviewText').textContent=data.review;$('#reviewCard').classList.remove('hidden');if(data.projectReviewsQueued)toast(`${data.projectReviewsQueued} project review${data.projectReviewsQueued===1?'':'s'} queued to refresh milestones and tasks`);e.target.disabled=false;e.target.textContent='AI review'}
  if(e.target.id==='weeklyReview'){e.target.disabled=true;e.target.textContent='Reviewing…';try{const data=await request('/api/weekly-review',{method:'POST',body:'{}'});$('#reviewTitle').textContent='Weekly review';$('#reviewText').textContent=data.review;$('#reviewCard').classList.remove('hidden')}finally{e.target.disabled=false;e.target.textContent='Weekly review'}}
  if(e.target.id==='closeReview')$('#reviewCard').classList.add('hidden');
  if(e.target.id==='clearFocus'){await request('/api/settings',{method:'POST',body:JSON.stringify({focusProjectId:''})});await load()}
  if(e.target.id==='saveSensitiveTerms'){await request('/api/settings',{method:'POST',body:JSON.stringify({sensitiveTerms:$('#sensitiveTerms').value})});toast('Redacted terms saved')}
  if(e.target.dataset.dismissReminder){await request(`/api/reminders/${e.target.dataset.dismissReminder}`,{method:'PATCH',body:'{}'});await load()}
  if(e.target.id==='timelinePrev'){const d=new Date(`${timelineDate}T12:00:00`);d.setDate(d.getDate()-1);timelineDate=d.toISOString().slice(0,10);await renderTimeline()}
  if(e.target.id==='timelineNext'&&!e.target.disabled){const d=new Date(`${timelineDate}T12:00:00`);d.setDate(d.getDate()+1);timelineDate=d.toISOString().slice(0,10);await renderTimeline()}
  if(e.target.id==='timelineToday'){timelineDate=state.date;await renderTimeline()}
  if(e.target.id==='copyExtensionKey'){await navigator.clipboard.writeText(state.extension.key);toast('Extension key copied')}
  if(e.target.id==='chooseFolder')await pickNativeFolder();
  if(e.target.id==='analyzeUrlOnly'){
    const url=$('#urlOnlyInput').value.trim(), consent=$('#urlOnlyConsent').checked;
    if(!consent)throw new Error('Consent is required for this URL-only request.');
    e.target.disabled=true;e.target.textContent='Analyzing…';
    const result=await request('/api/url-only-analysis',{method:'POST',body:JSON.stringify({url,consent})});
    $('#urlOnlyResult').textContent=`Model: ${result.model}\n\n${result.analysis}`;$('#urlOnlyResult').classList.remove('hidden');
    $('#urlOnlyConsent').checked=false;e.target.disabled=false;e.target.textContent='Analyze URL with free model';
  }
  if(e.target.dataset.analyzeProject){
    const button=e.target;button.disabled=true;button.textContent='Analyzing…';toast('Reading safe project files and Git evidence…');
    const result=await request(`/api/projects/${button.dataset.analyzeProject}/analyze`,{method:'POST',body:'{}'});
    toast(`Plan updated: ${result.milestones} milestones, ${result.tasks} tasks`);await load();
  }
  if(e.target.dataset.viewProject){currentProjectId=Number(e.target.dataset.viewProject);renderProjectDetail(currentProjectId);show('project-detail')}
  if(e.target.dataset.addMilestone)modal('milestone',null,{projectId:Number(e.target.dataset.addMilestone)});
  if(e.target.dataset.importPlan)modal('import-plan',null,{projectId:Number(e.target.dataset.importPlan)});
  if(e.target.dataset.addTask)modal('task',null,{projectId:Number(e.target.dataset.addTask),milestoneId:e.target.dataset.milestoneId||''});
  if(e.target.dataset.toggleMilestone){const mid=Number(e.target.dataset.toggleMilestone);if(collapsedMilestones.has(mid))collapsedMilestones.delete(mid);else collapsedMilestones.add(mid);renderProjectDetail(currentProjectId)}
  if(e.target.id==='backProjects'){currentProjectId=null;show('projects')}
  if(e.target.dataset.saveBrief){
    const button=e.target,original=button.textContent;button.disabled=true;button.textContent='Saving…';
    try{const result=await request(`/api/projects/${button.dataset.saveBrief}/save-brief`,{method:'POST',body:'{}'});toast(`Saved WORKLENS-BRIEF.md to ${result.path}`)}
    finally{button.disabled=false;button.textContent=original}
  }
  if(e.target.dataset.editProject){const project=state.projects.find(p=>p.id===Number(e.target.dataset.editProject));modal('project',project)}
  if(e.target.dataset.deleteProject){const project=state.projects.find(p=>p.id===Number(e.target.dataset.deleteProject));if(confirm(`Remove ${project.name}? Its WorkLens tasks, milestones, and tracked activity associations will also be removed. The project folder itself will not be deleted.`)){await request(`/api/projects/${project.id}`,{method:'DELETE'});toast('Project removed from WorkLens');await load()}}
  if(e.target.matches('[data-close-modal]'))$('#modal').close();
}catch(err){toast(err.message);$('#aiReview').disabled=false;$('#aiReview').textContent='AI review';$('#weeklyReview').disabled=false;$('#weeklyReview').textContent='Weekly review';const urlButton=$('#analyzeUrlOnly');if(urlButton){urlButton.disabled=false;urlButton.textContent='Analyze URL with free model'}document.querySelectorAll('.analyze-project:disabled').forEach(button=>{button.disabled=false;button.textContent='Analyze repository'})}});
document.addEventListener('change',async e=>{
  if(e.target.dataset.task){await request(`/api/tasks/${e.target.dataset.task}`,{method:'PATCH',body:JSON.stringify({status:e.target.checked?'done':'todo'})});await load()}
  if(e.target.dataset.milestone){await request(`/api/milestones/${e.target.dataset.milestone}`,{method:'PATCH',body:JSON.stringify({status:e.target.checked?'done':'todo'})});await load()}
  if(e.target.dataset.taskMilestone){await request(`/api/tasks/${e.target.dataset.taskMilestone}`,{method:'PATCH',body:JSON.stringify({milestoneId:e.target.value?Number(e.target.value):null})});toast('Task moved');await load()}
  if(e.target.dataset.reassign){await request(`/api/activities/${e.target.dataset.reassign}`,{method:'PATCH',body:JSON.stringify({projectId:e.target.value?Number(e.target.value):null})});toast('Correction saved');await load()}
  if(e.target.id==='focusProject'){await request('/api/settings',{method:'POST',body:JSON.stringify({focusProjectId:e.target.value?Number(e.target.value):''})});await load()}
  if(e.target.id==='driftMode'){await request('/api/settings',{method:'POST',body:JSON.stringify({driftMode:e.target.value})});toast('Drift setting saved')}
  if(e.target.id==='timelineDate'){timelineDate=e.target.value;await renderTimeline()}
});
$('#modalForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const values=Object.fromEntries(new FormData(e.target));
  const type=e.target.dataset.type,projectId=e.target.dataset.projectId;
  if(type==='import-plan'){
    const saveButton=$('#modalSave');saveButton.disabled=true;saveButton.textContent='Importing…';
    try{
      const result=await request(`/api/projects/${projectId}/import-plan`,{method:'POST',body:JSON.stringify({text:values.text})});
      $('#modal').close();
      toast(`Imported ${result.milestones} milestone${result.milestones===1?'':'s'}, ${result.tasks} task${result.tasks===1?'':'s'}${result.unmatched?` (${result.unmatched} left in the backlog — no matching milestone)`:''}${result.usedAi?'':' — parsed without AI (OpenRouter not configured)'}`);
      await load();
    } finally { saveButton.disabled=false; saveButton.textContent='Save'; }
    return;
  }
  const endpoint=type==='project'?(projectId?`/api/projects/${projectId}`:'/api/projects'):type==='milestone'?'/api/milestones':type==='reminder'?'/api/reminders':'/api/tasks';
  await request(endpoint,{method:type==='project'&&projectId?'PATCH':'POST',body:JSON.stringify(values)});
  $('#modal').close();
  toast(type==='project'?(projectId?'Project updated':'Project created'):type==='milestone'?'Milestone added':type==='reminder'?'Reminder added':'Task added');
  await load();
});
$('#askForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const input=$('#askInput'), question=input.value.trim(); if(!question)return;
  askHistory.push({role:'user',html:esc(question)}); renderAsk(); input.value=''; input.disabled=true;
  try{
    const data=await request('/api/ask',{method:'POST',body:JSON.stringify({question})});
    const evidenceHtml=data.evidence?.length?`<div class="evidence">${data.evidence.map(ev=>`<div>${esc(ev)}</div>`).join('')}</div>`:'';
    askHistory.push({role:'assistant',html:esc(data.answer).replaceAll('\n','<br>')+evidenceHtml});
  }catch(err){askHistory.push({role:'assistant',html:esc(err.message)})}
  input.disabled=false; renderAsk(); input.focus();
});
load();setInterval(load,15000);
