import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Project-planning module for the Accelo MCP.
//
// Phase 1 (read): get_project_plan, list_tasks, get_task, list_task_progressions.
// Phase 2 (write): update_task, create_task, update_milestone, progress_task,
//   cancel_task, reschedule_plan (bulk). All writes are confirm:true-guarded
//   and preview first.
//
// Kept deliberately self-contained (its own fetch helpers + MCP result helper)
// so it does not collide with concurrent edits to accelo.js / mcp.js. The only
// touch-point in mcp.js is a single registerProjectTools(server, subject) call.
//
// Accelo model notes (verified live against job 862, 2026-06):
//   - Job (/jobs/{id}) -> Milestones (/jobs/{id}/milestones) -> Tasks (/tasks).
//   - A task is attached via against_type/against_id. Usually against a
//     milestone, but it CAN be against the job directly (not every task has a
//     milestone), so we query both against(milestone(X)) and against(job(X)).
//   - There are NO dependency fields in the REST API. `ordering` is only the
//     display row within a milestone/job and is mostly-but-not-always linear;
//     it is NOT a dependency model. Authoritative cascades require Accelo's
//     GUI engine (future Playwright phase). These write tools are single-object
//     only -- they do NOT cascade downstream tasks.
//   - Planned schedule = date_started / date_due. Actuals = date_commenced /
//     date_completed. All dates are Unix timestamps (seconds). Accelo requires
//     a start date to create a task.
//   - TIMEZONE: Accelo anchors dates to the DEPLOYMENT timezone (US Central /
//     New Orleans => America/Chicago). e.g. raw 1781456400 = 2026-06-15 00:00
//     CDT. Reading that stamp in UTC yields 2026-06-15 05:00 -> slicing gave
//     2026-06-14 (off-by-one). We therefore format reads in ACCELO_TIMEZONE and
//     write a YYYY-MM-DD as NOON in ACCELO_TIMEZONE so it round-trips. Override
//     via env ACCELO_TIMEZONE (default America/Chicago).
//   - STATUS CHANGES REQUIRE PROGRESSIONS. Direct task_status writes via PUT are
//     silently ignored by Accelo. Use list_task_progressions to discover the
//     available progression IDs for a task, then progress_task to run one.
//   - Known status IDs in this deployment: 6 = Cancelled, 8 = Task for Client,
//     12 = Task for Third Party. Cancelling runs PROGRESSION 14 (-> status 6).
//   - CONCURRENCY: firing many parallel write tools overwhelms the container
//     (each update = 3 Accelo calls) and stampedes token refresh. For multi-item
//     changes use reschedule_plan, which processes everything SEQUENTIALLY in a
//     single call.

const log = (...a) => console.log(new Date().toISOString(), '[projects]', ...a);

const TZ = process.env.ACCELO_TIMEZONE || 'America/Chicago';

const WAITING_STATUS = { '8': 'Task for Client', '12': 'Task for Third Party' };
const STATUS_LABELS = { '6': 'Cancelled', '8': 'Task for Client', '12': 'Task for Third Party' };
const CANCELLED_STATUS = '6';
const CANCEL_PROGRESSION_ID = '14';

const JOB_FIELDS = [
  'id', 'title', 'standing', 'job_status', 'manager', 'against', 'against_type',
  'against_id', 'date_started', 'date_due', 'date_commenced', 'date_completed',
  'comments',
].join(',');

const MILESTONE_FIELDS = [
  'id', 'title', 'standing', 'milestone_status', 'ordering', 'date_started',
  'date_due', 'date_commenced', 'date_completed', 'manager', 'description',
].join(',');

const TASK_FIELDS = [
  'id', 'title', 'standing', 'status', 'task_status', 'ordering', 'against_type',
  'against_id', 'milestone', 'job', 'assignee', 'manager', 'date_started',
  'date_due', 'date_commenced', 'date_completed', 'description', 'task_priority',
].join(',');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Human-in-the-loop guard: returned when a write tool is called without
// confirm:true. Includes a before/after diff so the agent can show the user
// exactly what will change before re-calling with confirm:true.
function needsConfirmation(action, diff) {
  return ok({
    status: 'confirmation_required',
    message: `This will ${action} in Accelo. Review the change below with the user, then call this tool again with confirm: true to proceed.`,
    change: diff,
  });
}

async function acceloGet(token, pathname, query) {
  const url = new URL(config.acceloBaseUrl + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    log('ERROR GET', pathname, res.status, '-', msg);
    throw new Error(`Accelo API GET ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

// Write helper for POST/PUT. Body is form-urlencoded (Accelo's format).
async function acceloWrite(token, method, pathname, body) {
  const url = new URL(config.acceloBaseUrl + pathname);
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (body && Object.keys(body).length) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    log('ERROR', method, pathname, res.status, '-', msg);
    throw new Error(`Accelo API ${method} ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

// Non-throwing POST used for progression attempts (we try multiple shapes).
async function acceloTryPost(token, pathname, body) {
  const url = new URL(config.acceloBaseUrl + pathname);
  const opts = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (body && Object.keys(body).length) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json, message: (json && json.meta && json.meta.message) || text };
}

// Run a task progression. Accelo deployments differ on the exact endpoint
// shape, so we try the plain progression endpoint then the /auto variant and
// return whichever succeeds (or a combined error if both fail).
async function runProgression(token, taskId, progressionId) {
  const candidates = [
    `/tasks/${encodeURIComponent(taskId)}/progressions/${encodeURIComponent(progressionId)}`,
    `/tasks/${encodeURIComponent(taskId)}/progressions/${encodeURIComponent(progressionId)}/auto`,
  ];
  const errors = [];
  for (const p of candidates) {
    const r = await acceloTryPost(token, p, {});
    if (r.ok) return { path: p, response: r.json };
    errors.push(`${p} -> ${r.status} ${r.message}`);
  }
  throw new Error(`Progression ${progressionId} on task ${taskId} failed. Tried: ${errors.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Timezone-aware date helpers (deployment TZ = ACCELO_TIMEZONE)
// ---------------------------------------------------------------------------

// Offset (ms) of TZ at a given UTC instant. Positive = ahead of UTC.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = map.hour === '24' ? '00' : map.hour;
  const asUTC = Date.UTC(map.year, Number(map.month) - 1, map.day, hour, map.minute, map.second);
  return asUTC - utcMs;
}

// Format a Unix-seconds timestamp as a YYYY-MM-DD calendar date IN the
// deployment timezone (so Accelo's TZ-anchored dates read back correctly).
function tsToISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(n * 1000));
}

// Convert a YYYY-MM-DD to Unix seconds at NOON in the deployment timezone. Noon
// (not midnight) keeps the calendar date stable against any DST/boundary edge.
// Also accepts raw 10-digit Unix seconds unchanged.
function toUnixSeconds(input) {
  if (input === undefined || input === null || input === '') return undefined;
  const s = String(input).trim();
  if (/^\d{10}$/.test(s)) return s; // already unix seconds
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    // Guess noon UTC, then correct by the TZ offset at that instant so the
    // wall-clock time is noon in TZ.
    const noonUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d), 12, 0, 0);
    const offset = tzOffsetMs(noonUTC, TZ);
    return String(Math.floor((noonUTC - offset) / 1000));
  }
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return String(Math.floor(ms / 1000));
  throw new Error(`Unrecognized date: "${input}". Use YYYY-MM-DD or Unix seconds.`);
}

function byOrdering(a, b) {
  return Number(a.ordering || 0) - Number(b.ordering || 0);
}

function statusLabel(s) {
  return STATUS_LABELS[String(s)] ? `${s} (${STATUS_LABELS[String(s)]})` : String(s);
}

function decorateTask(t) {
  return {
    id: t.id,
    title: t.title,
    ordering: t.ordering,
    standing: t.standing,
    task_status: t.task_status,
    waiting_on: WAITING_STATUS[String(t.task_status)] || null,
    cancelled: String(t.task_status) === CANCELLED_STATUS,
    against_type: t.against_type,
    against_id: t.against_id,
    milestone: t.milestone,
    assignee: t.assignee,
    planned_start: tsToISO(t.date_started),
    planned_due: tsToISO(t.date_due),
    actual_commenced: tsToISO(t.date_commenced),
    actual_completed: tsToISO(t.date_completed),
    task_priority: t.task_priority,
    // Raw timestamps retained so write tools (later phases) can compute offsets.
    _raw: {
      date_started: t.date_started,
      date_due: t.date_due,
      date_commenced: t.date_commenced,
      date_completed: t.date_completed,
    },
  };
}

function decorateMilestone(m) {
  return {
    id: m.id,
    title: m.title,
    ordering: m.ordering,
    standing: m.standing,
    planned_start: tsToISO(m.date_started),
    planned_due: tsToISO(m.date_due),
    actual_commenced: tsToISO(m.date_commenced),
    actual_completed: tsToISO(m.date_completed),
  };
}

async function getTask(token, id) {
  const json = await acceloGet(token, `/tasks/${encodeURIComponent(id)}`, { _fields: TASK_FIELDS });
  return json.response || null;
}

async function fetchTasksAgainst(token, type, id) {
  const json = await acceloGet(token, '/tasks', {
    _filters: `against(${type}(${id}))`,
    _fields: TASK_FIELDS,
    _limit: 100,
  });
  const list = Array.isArray(json.response) ? json.response : [];
  return list.sort(byOrdering).map(decorateTask);
}

async function getProjectPlan(token, jobId) {
  const job = (await acceloGet(token, `/jobs/${encodeURIComponent(jobId)}`, { _fields: JOB_FIELDS })).response;
  const msResp = await acceloGet(token, `/jobs/${encodeURIComponent(jobId)}/milestones`, {
    _fields: MILESTONE_FIELDS,
    _limit: 100,
  });
  const milestones = (Array.isArray(msResp.response) ? msResp.response : []).sort(byOrdering);

  const milestoneNodes = [];
  for (const m of milestones) {
    const tasks = await fetchTasksAgainst(token, 'milestone', m.id);
    milestoneNodes.push({ ...decorateMilestone(m), tasks });
  }

  const jobTasks = await fetchTasksAgainst(token, 'job', jobId);

  const waiting = [];
  for (const mn of milestoneNodes) {
    for (const t of mn.tasks) {
      if (t.waiting_on) waiting.push({ task_id: t.id, title: t.title, waiting_on: t.waiting_on, milestone: mn.title, planned_due: t.planned_due });
    }
  }
  for (const t of jobTasks) {
    if (t.waiting_on) waiting.push({ task_id: t.id, title: t.title, waiting_on: t.waiting_on, milestone: null, planned_due: t.planned_due });
  }

  return {
    job: job ? {
      id: job.id,
      title: job.title,
      standing: job.standing,
      manager: job.manager,
      planned_start: tsToISO(job.date_started),
      planned_due: tsToISO(job.date_due),
    } : { id: jobId, note: 'job record not returned' },
    milestones: milestoneNodes,
    job_level_tasks: jobTasks,
    waiting_summary: waiting,
  };
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function buildTaskDiff(current, body) {
  const diff = {};
  const isoFields = { date_started: 'planned_start', date_due: 'planned_due' };
  for (const [k, to] of Object.entries(body)) {
    if (isoFields[k]) diff[isoFields[k]] = { from: tsToISO(current[k]), to: tsToISO(to) };
    else diff[k] = { from: current[k], to };
  }
  return diff;
}

function buildMilestoneDiff(current, body) {
  const diff = {};
  const isoFields = { date_started: 'planned_start', date_due: 'planned_due' };
  for (const [k, to] of Object.entries(body)) {
    if (isoFields[k]) diff[isoFields[k]] = { from: tsToISO(current[k]), to: tsToISO(to) };
    else diff[k] = { from: current[k], to };
  }
  return diff;
}

// Build the {date_started?, date_due?, title?} write body from a plan item.
function planItemBody(item) {
  const body = {};
  if (item.title !== undefined) body.title = item.title;
  if (item.planned_start !== undefined) body.date_started = toUnixSeconds(item.planned_start);
  if (item.planned_due !== undefined) body.date_due = toUnixSeconds(item.planned_due);
  return body;
}

// Register all project tools (read + write) onto an existing McpServer.
export function registerProjectTools(server, subject) {
  // -------- Reads --------
  server.tool(
    'get_project_plan',
    'Get the full project plan for an Accelo job: the job, its milestones (ordered), the tasks under each milestone (ordered), any tasks attached directly to the job, and a waiting_summary of tasks currently waiting on a client or third party (native task_status 8/12). Dates are shown as ISO (YYYY-MM-DD) planned vs actual, in the deployment timezone. Read-only.',
    { job_id: z.string().describe('The Accelo job (project) ID, e.g. "862"') },
    async ({ job_id }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await getProjectPlan(token, job_id));
    }
  );

  server.tool(
    'list_tasks',
    'List tasks in Accelo, ordered by their plan row. Provide milestone_id to get the tasks under a milestone, or job_id to get tasks attached directly to a job. Exactly one of milestone_id or job_id is required. Read-only.',
    {
      milestone_id: z.string().optional().describe('Milestone ID to list tasks for'),
      job_id: z.string().optional().describe('Job ID to list tasks attached directly to the job'),
    },
    async ({ milestone_id, job_id }) => {
      if (!milestone_id && !job_id) {
        return ok({ status: 'error', message: 'Provide either milestone_id or job_id.' });
      }
      const token = await getValidAcceloToken(subject);
      const type = milestone_id ? 'milestone' : 'job';
      const id = milestone_id || job_id;
      return ok(await fetchTasksAgainst(token, type, id));
    }
  );

  server.tool(
    'get_task',
    'Get a single Accelo task by ID, with ISO planned/actual dates (deployment timezone) and a waiting_on flag (task_status 8/12) and a cancelled flag (task_status 6). Read-only.',
    { id: z.string().describe('The task ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      const t = await getTask(token, id);
      return ok(t ? decorateTask(t) : { status: 'error', message: 'Task not found' });
    }
  );

  server.tool(
    'list_task_progressions',
    'List the progressions available for a task. In Accelo, a task\'s status cannot be set directly via update -- you must run a PROGRESSION, which transitions the task to a new status. Use this to discover the available progression IDs and the status each leads to, then call progress_task. Read-only.',
    { task_id: z.string().describe('The task ID to list progressions for') },
    async ({ task_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/tasks/${encodeURIComponent(task_id)}/progressions`, { _fields: '_ALL', _limit: 100 });
      return ok(json.response || []);
    }
  );

  // -------- Writes (confirm:true-guarded; single-object, no cascade) --------

  server.tool(
    'update_task',
    'Update a single Accelo task\'s title and/or planned dates. WRITE OPERATION: requires confirm:true. First call (no confirm) returns a before/after diff; call again with confirm:true to apply. Only the provided fields change. Dates accept YYYY-MM-DD (interpreted in the deployment timezone). NOTE: this does NOT change task STATUS -- Accelo ignores direct status writes; use progress_task (or cancel_task) for status transitions. Single-task edit -- does NOT cascade. To change MANY tasks at once, use reschedule_plan (do NOT fire many update_task calls in parallel -- that overwhelms the server).',
    {
      id: z.string().describe('The task ID to update'),
      title: z.string().optional().describe('New task title'),
      planned_start: z.string().optional().describe('New planned start date as YYYY-MM-DD (or Unix seconds)'),
      planned_due: z.string().optional().describe('New planned due date as YYYY-MM-DD (or Unix seconds)'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the diff only.'),
    },
    async ({ id, title, planned_start, planned_due, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const body = {};
      if (title !== undefined) body.title = title;
      if (planned_start !== undefined) body.date_started = toUnixSeconds(planned_start);
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (Object.keys(body).length === 0) {
        return ok({ status: 'error', message: 'No updatable fields provided (title, planned_start, planned_due).' });
      }
      const current = await getTask(token, id);
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      const diff = buildTaskDiff(current, body);
      if (confirm !== true) return needsConfirmation(`UPDATE task ${id} ("${current.title}")`, diff);
      await acceloWrite(token, 'PUT', `/tasks/${encodeURIComponent(id)}`, body);
      // Re-GET so the response reflects the true stored dates (the write
      // response can omit/return null for date fields).
      const after = await getTask(token, id);
      return ok({ status: 'updated', task: after ? decorateTask(after) : null, applied: diff });
    }
  );

  server.tool(
    'create_task',
    'Create a new Accelo task against a milestone OR a job. WRITE OPERATION: requires confirm:true. First call (no confirm) previews the payload; call again with confirm:true to create. Exactly one of milestone_id or job_id is required. Accelo REQUIRES a start date -- provide planned_start (YYYY-MM-DD, deployment timezone). After creation the task is re-fetched so the response shows the true stored dates.',
    {
      title: z.string().describe('Task title'),
      milestone_id: z.string().optional().describe('Milestone ID to attach the task to'),
      job_id: z.string().optional().describe('Job ID to attach the task directly to (when not under a milestone)'),
      planned_start: z.string().describe('Planned start date as YYYY-MM-DD (REQUIRED by Accelo)'),
      planned_due: z.string().optional().describe('Planned due date as YYYY-MM-DD (or Unix seconds)'),
      assignee_id: z.string().optional().describe('Staff ID to assign the task to'),
      confirm: z.boolean().optional().describe('Must be true to create. Omit/false to preview only.'),
    },
    async ({ title, milestone_id, job_id, planned_start, planned_due, assignee_id, confirm }) => {
      if (!milestone_id && !job_id) return ok({ status: 'error', message: 'Provide either milestone_id or job_id.' });
      if (milestone_id && job_id) return ok({ status: 'error', message: 'Provide only one of milestone_id or job_id.' });
      const token = await getValidAcceloToken(subject);
      const body = {
        title,
        against_type: milestone_id ? 'milestone' : 'job',
        against_id: milestone_id || job_id,
        date_started: toUnixSeconds(planned_start),
      };
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (assignee_id !== undefined) body.assignee = assignee_id;
      const preview = {
        title,
        against: `${body.against_type}(${body.against_id})`,
        planned_start: tsToISO(body.date_started),
        planned_due: planned_due ? tsToISO(body.date_due) : undefined,
        assignee_id,
      };
      if (confirm !== true) return needsConfirmation('CREATE a new task', preview);
      const res = await acceloWrite(token, 'POST', '/tasks', body);
      const newId = res.response && res.response.id;
      const after = newId ? await getTask(token, newId) : res.response;
      return ok({ status: 'created', task: after ? decorateTask(after) : res.response });
    }
  );

  server.tool(
    'update_milestone',
    'Update a single Accelo milestone\'s title and/or planned dates. WRITE OPERATION: requires confirm:true. First call (no confirm) returns a before/after diff; call again with confirm:true to apply. Only the provided fields change. Dates are interpreted in the deployment timezone. Single-object edit -- does NOT cascade to the milestone\'s tasks. To change many milestones/tasks at once, use reschedule_plan.',
    {
      id: z.string().describe('The milestone ID to update'),
      title: z.string().optional().describe('New milestone title'),
      planned_start: z.string().optional().describe('New planned start date as YYYY-MM-DD (or Unix seconds)'),
      planned_due: z.string().optional().describe('New planned due date as YYYY-MM-DD (or Unix seconds)'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the diff only.'),
    },
    async ({ id, title, planned_start, planned_due, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const body = {};
      if (title !== undefined) body.title = title;
      if (planned_start !== undefined) body.date_started = toUnixSeconds(planned_start);
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (Object.keys(body).length === 0) return ok({ status: 'error', message: 'No updatable fields provided.' });
      const current = (await acceloGet(token, `/milestones/${encodeURIComponent(id)}`, { _fields: MILESTONE_FIELDS })).response;
      if (!current) return ok({ status: 'error', message: `Milestone ${id} not found.` });
      const diff = buildMilestoneDiff(current, body);
      if (confirm !== true) return needsConfirmation(`UPDATE milestone ${id} ("${current.title}")`, diff);
      await acceloWrite(token, 'PUT', `/milestones/${encodeURIComponent(id)}`, body);
      const after = (await acceloGet(token, `/milestones/${encodeURIComponent(id)}`, { _fields: MILESTONE_FIELDS })).response;
      return ok({ status: 'updated', milestone: after ? decorateMilestone(after) : null, applied: diff });
    }
  );

  server.tool(
    'reschedule_plan',
    'Bulk-update many tasks and/or milestones (titles and/or planned dates) in ONE call. WRITE OPERATION: requires confirm:true. The server processes every item SEQUENTIALLY (one Accelo write at a time), so this is the correct way to reschedule a project plan -- do NOT fire many parallel update_task/update_milestone calls (that overwhelms the server). First call (no confirm) returns a combined before/after diff for every item; second call with confirm:true applies them in order and returns a per-item result summary (one failure does not abort the rest). Dates are YYYY-MM-DD in the deployment timezone. Does NOT cascade dependencies -- you supply the exact target dates for each item.',
    {
      tasks: z.array(z.object({
        id: z.string().describe('Task ID'),
        title: z.string().optional().describe('New title'),
        planned_start: z.string().optional().describe('New planned start YYYY-MM-DD'),
        planned_due: z.string().optional().describe('New planned due YYYY-MM-DD'),
      })).optional().describe('Tasks to update'),
      milestones: z.array(z.object({
        id: z.string().describe('Milestone ID'),
        title: z.string().optional().describe('New title'),
        planned_start: z.string().optional().describe('New planned start YYYY-MM-DD'),
        planned_due: z.string().optional().describe('New planned due YYYY-MM-DD'),
      })).optional().describe('Milestones to update'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the combined diff only.'),
    },
    async ({ tasks, milestones, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const taskItems = Array.isArray(tasks) ? tasks : [];
      const msItems = Array.isArray(milestones) ? milestones : [];
      if (!taskItems.length && !msItems.length) {
        return ok({ status: 'error', message: 'Provide a tasks and/or milestones array.' });
      }

      // ----- Preview: sequential GETs to build a combined diff -----
      if (confirm !== true) {
        const taskDiffs = [];
        for (const it of taskItems) {
          try {
            const body = planItemBody(it);
            if (!Object.keys(body).length) { taskDiffs.push({ id: it.id, error: 'no fields to update' }); continue; }
            const cur = await getTask(token, it.id);
            if (!cur) { taskDiffs.push({ id: it.id, error: 'not found' }); continue; }
            taskDiffs.push({ id: it.id, title: cur.title, change: buildTaskDiff(cur, body) });
          } catch (e) { taskDiffs.push({ id: it.id, error: e.message }); }
        }
        const msDiffs = [];
        for (const it of msItems) {
          try {
            const body = planItemBody(it);
            if (!Object.keys(body).length) { msDiffs.push({ id: it.id, error: 'no fields to update' }); continue; }
            const cur = (await acceloGet(token, `/milestones/${encodeURIComponent(it.id)}`, { _fields: MILESTONE_FIELDS })).response;
            if (!cur) { msDiffs.push({ id: it.id, error: 'not found' }); continue; }
            msDiffs.push({ id: it.id, title: cur.title, change: buildMilestoneDiff(cur, body) });
          } catch (e) { msDiffs.push({ id: it.id, error: e.message }); }
        }
        return ok({
          status: 'confirmation_required',
          message: `This will update ${taskItems.length} task(s) and ${msItems.length} milestone(s) in Accelo, sequentially. Review the combined diff with the user, then call again with confirm: true.`,
          tasks: taskDiffs,
          milestones: msDiffs,
        });
      }

      // ----- Apply: sequential writes, per-item try/catch -----
      const results = [];
      let applied = 0, failed = 0;
      for (const it of taskItems) {
        try {
          const body = planItemBody(it);
          if (!Object.keys(body).length) { results.push({ type: 'task', id: it.id, ok: false, error: 'no fields to update' }); failed++; continue; }
          await acceloWrite(token, 'PUT', `/tasks/${encodeURIComponent(it.id)}`, body);
          results.push({ type: 'task', id: it.id, ok: true });
          applied++;
        } catch (e) {
          results.push({ type: 'task', id: it.id, ok: false, error: e.message });
          failed++;
        }
      }
      for (const it of msItems) {
        try {
          const body = planItemBody(it);
          if (!Object.keys(body).length) { results.push({ type: 'milestone', id: it.id, ok: false, error: 'no fields to update' }); failed++; continue; }
          await acceloWrite(token, 'PUT', `/milestones/${encodeURIComponent(it.id)}`, body);
          results.push({ type: 'milestone', id: it.id, ok: true });
          applied++;
        } catch (e) {
          results.push({ type: 'milestone', id: it.id, ok: false, error: e.message });
          failed++;
        }
      }
      return ok({ status: 'completed', applied, failed, results });
    }
  );

  server.tool(
    'progress_task',
    'Run a task PROGRESSION to transition its status. WRITE OPERATION: requires confirm:true. In Accelo, task status is changed via progressions, not direct writes. Use list_task_progressions to find the progression_id that leads to the status you want, then run it here. Tries the standard and /auto endpoint shapes automatically.',
    {
      task_id: z.string().describe('The task ID to progress'),
      progression_id: z.string().describe('The progression ID to run (from list_task_progressions)'),
      confirm: z.boolean().optional().describe('Must be true to run. Omit/false to preview only.'),
    },
    async ({ task_id, progression_id, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const current = await getTask(token, task_id);
      if (!current) return ok({ status: 'error', message: `Task ${task_id} not found.` });
      if (confirm !== true) {
        return needsConfirmation(`RUN progression ${progression_id} on task ${task_id} ("${current.title}")`, {
          task: `${task_id} ("${current.title}")`,
          current_status: statusLabel(current.task_status),
          progression_id,
        });
      }
      const result = await runProgression(token, task_id, progression_id);
      const after = await getTask(token, task_id);
      return ok({ status: 'progressed', via: result.path, task: after ? decorateTask(after) : null });
    }
  );

  server.tool(
    'cancel_task',
    'Cancel an Accelo task by running the cancel progression (progression 14 -> status 6 Cancelled). WRITE OPERATION: requires confirm:true. Accelo does not support deleting tasks; cancelling is a reversible status transition visible in the GUI. Optionally prepends "[CANCELLED] " to the title (via a separate update) so it is obvious in the GUI. First call (no confirm) previews; call again with confirm:true to apply.',
    {
      id: z.string().describe('The task ID to cancel'),
      mark_title: z.boolean().optional().describe('If true, prepend "[CANCELLED] " to the task title. Default false.'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async ({ id, mark_title, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const current = await getTask(token, id);
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      const alreadyMarked = String(current.title || '').startsWith('[CANCELLED] ');
      const newTitle = mark_title && !alreadyMarked ? `[CANCELLED] ${current.title}` : undefined;
      if (confirm !== true) {
        return needsConfirmation(`CANCEL task ${id} ("${current.title}")`, {
          task: `${id} ("${current.title}")`,
          action: `Run progression ${CANCEL_PROGRESSION_ID} -> status ${CANCELLED_STATUS} (Cancelled)`,
          current_status: statusLabel(current.task_status),
          title_change: newTitle ? { from: current.title, to: newTitle } : undefined,
        });
      }
      if (newTitle) await acceloWrite(token, 'PUT', `/tasks/${encodeURIComponent(id)}`, { title: newTitle });
      const result = await runProgression(token, id, CANCEL_PROGRESSION_ID);
      const after = await getTask(token, id);
      return ok({ status: 'cancelled', via: result.path, task: after ? decorateTask(after) : null });
    }
  );
}
