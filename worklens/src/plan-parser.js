// Deterministic fallback for turning a pasted operational plan/runbook into the same
// {summary, milestones, tasks} shape openrouter.js's extractPlanFromText produces — used only
// when OpenRouter isn't configured, or the AI extraction call fails, so an import never simply
// dead-ends. This is regex/heading driven, not a real parser: it reads headings and "Phase N"
// lines as milestones, numbered/bulleted lines as tasks, and folds anything else (including
// fenced code blocks) into the current task's evidence. Known limitation, accepted because this
// is explicitly the fallback path: it can't tell an outer numbered list from a nested numbered
// sub-list once indentation is lost in flat-pasted plain text, so it will over-fragment such
// input into more/smaller tasks than the AI path would. Documented in docs/PROGRESS.md.

function slug(text, fallback) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || fallback;
}

export function parsePlainTextPlan(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const milestones = [];
  const tasks = [];
  let currentMilestoneKey = null;
  let currentTask = null;
  let inFence = false;
  let milestoneIndex = 0;
  let taskIndex = 0;

  function openMilestone(title) {
    milestoneIndex += 1;
    const key = `m${milestoneIndex}-${slug(title, `phase-${milestoneIndex}`)}`;
    milestones.push({ key, title: title.trim().slice(0, 300), weight: 1, status: 'todo', evidence: '' });
    currentMilestoneKey = key;
    currentTask = null;
  }
  function openTask(title) {
    if (!currentMilestoneKey) openMilestone('Plan');
    taskIndex += 1;
    const key = `t${taskIndex}-${slug(title, `step-${taskIndex}`)}`;
    currentTask = { key, milestoneKey: currentMilestoneKey, title: title.trim().slice(0, 300), status: 'todo', manualIntervention: false, evidenceParts: [] };
    tasks.push(currentTask);
  }
  function addEvidence(line) {
    if (currentTask && line.trim()) currentTask.evidenceParts.push(line.trim());
  }

  const headingRe = /^#{1,6}\s+(.+)$/;
  const phaseRe = /^(phase|step|part|stage)\s+(\d+)\s*[:.\-—–]\s*(.+)$/i;
  const numberedRe = /^\s*\d+[.)]\s+(.+)$/;
  const bulletRe = /^\s*[-*•]\s+(.+)$/;
  const fenceRe = /^\s*```/;
  const manualHintRe = /\b(sign up|sign-up|create an account|purchase|buy a|business decision|legal|approval|approve|apply for|submit for review|app review|register a|verify your|human|manually)\b/i;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (fenceRe.test(line)) { inFence = !inFence; continue; }
    if (inFence) { addEvidence(line); continue; }
    if (!line.trim()) continue;

    const heading = line.match(headingRe);
    if (heading) { openMilestone(heading[1]); continue; }
    const phase = line.match(phaseRe);
    if (phase) { openMilestone(`${phase[1][0].toUpperCase()}${phase[1].slice(1).toLowerCase()} ${phase[2]} — ${phase[3]}`); continue; }
    const numbered = line.match(numberedRe);
    if (numbered) { openTask(numbered[1]); if (manualHintRe.test(numbered[1])) currentTask.manualIntervention = true; continue; }
    const bullet = line.match(bulletRe);
    if (bullet && !currentTask) { openTask(bullet[1]); if (manualHintRe.test(bullet[1])) currentTask.manualIntervention = true; continue; }
    addEvidence(bullet ? bullet[1] : line);
  }
  if (!milestones.length) openMilestone('Imported plan');
  if (!tasks.length) tasks.push({ key: `${milestones[0].key}-review`, milestoneKey: milestones[0].key, title: 'Review this phase', status: 'todo', manualIntervention: false, evidenceParts: [] });

  return {
    summary: 'Imported from a pasted plan (parsed heuristically — no OpenRouter key configured for AI-assisted parsing).',
    milestones,
    tasks: tasks.map(t => ({ key: t.key, milestoneKey: t.milestoneKey, title: t.title, status: t.status, manualIntervention: t.manualIntervention, evidence: t.evidenceParts.join(' ').slice(0, 300) }))
  };
}
