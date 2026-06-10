import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Project-planning module for the Accelo MCP.
//
// Phase 1 (read): get_project_plan, list_tasks, get_task.
// Phase 2 (write): update_task, create_task, update_milestone, delete_task.
//   All writes are confirm:true-guarded and preview a before/after diff first.
//
// Kept deliberately self-contained (its own fetch helpers + MCP result helper)
// so it does not collide with concurrent edits to accelo.js / mcp.js. The only
// touch-point in mcp.js is a single registerProjectTools(server, subject) call.
//
// Accelo model notes (verified live against job 862, 2026-06-03):
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
//     date_completed. All dates are Unix timestamps (seconds).
//   - "Waiting on external party" is a native task_status: 8 = Task for Client,
//     12 = Task for Third Party.

const log = (...a) => console.log(new Date().toISOString(), '[projects]', ...a);

const WAITING_STATUS = { '8': 'Task for Client', '12': 'Task for Third Party' };

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

// Write helper for POST/PUT/DELETE. Body is form-urlencoded (Accelo's format).
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

function tsToISO(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
}

// Accept an ISO date (YYYY-MM-DD) or a raw Unix-seconds string/number and
// return Unix seconds as a string. Returns undefined for empty input.
function toUnixSeconds(input) {
  if (input === undefined || input === null || input === '') return undefined;
  const s = String(input).trim();
  if (/^\d{10}$/.test(s)) return s;                 // already unix seconds
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {              // ISO date -> midnight UTC
    const ms = Date.parse(s + 'T00:00:00Z');
    if (!Number.isNaN(ms)) return String(Math.floor(ms / 1000));
  }
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return String(Math.floor(ms / 1000));
  throw new Error(`Unrecognized date: "${input}". Use YYYY-MM-DD or Unix seconds.`);
}

function byOrdering(a, b) {
  return Number(a.ordering || 0) - Number(b.ordering || 0);
}

function decorateTask(t) {
  return {
    id: t.id,
    title: t.title,
    ordering: t.ordering,
    standing: t.standing,
    task_status: t.task_status,
    waiting_on: WAITING_STATUS[String(t.task_status)] || null,
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
// Phase 2 write helpers
// ---------------------------------------------------------------------------

// Build a {field: {from, to}} diff for the fields being changed on a task,
// translating planned date timestamps to ISO for human review.
function buildTaskDiff(current, body) {
  const diff = {};
  const isoFields = { date_started: 'planned_start', date_due: 'planned_due' };
  for (const [k, to] of Object.entries(body)) {
    if (isoFields[k]) {
      diff[isoFields[k]] = { from: tsToISO(current[k]), to: tsToISO(to) };
    } else if (k === 'task_status') {
      diff.task_status = {
        from: `${current.task_status}${WAITING_STATUS[String(current.task_status)] ? ' (' + WAITING_STATUS[String(current.task_status)] + ')' : ''}`,
        to: `${to}${WAITING_STATUS[String(to)] ? ' (' + WAITING_STATUS[String(to)] + ')' : ''}`,
      };
    } else {
      diff[k] = { from: current[k], to };
    }
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

// Register all project tools (read + write) onto an existing McpServer.
export function registerProjectTools(server, subject) {
  // -------- Phase 1 reads --------
  server.tool(
    'get_project_plan',
    'Get the full project plan for an Accelo job: the job, its milestones (ordered), the tasks under each milestone (ordered), any tasks attached directly to the job, and a waiting_summary of tasks currently waiting on a client or third party (native task_status 8/12). Dates are shown as ISO (YYYY-MM-DD) planned vs actual. Read-only.',
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
    'Get a single Accelo task by ID, with ISO planned/actual dates and a waiting_on flag (set when the task is waiting on a client or third party via native task_status 8/12). Read-only.',
    { id: z.string().describe('The task ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/tasks/${encodeURIComponent(id)}`, { _fields: TASK_FIELDS });
      return ok(json.response ? decorateTask(json.response) : { status: 'error', message: 'Task not found' });
    }
  );

  // -------- Phase 2 writes (confirm:true-guarded; single-object, no cascade) --------

  server.tool(
    'update_task',
    'Update a single Accelo task. WRITE OPERATION: requires confirm:true. First call (no confirm) returns a before/after diff to review with the user; call again with confirm:true to apply. Only the provided fields change. NOTE: this is a single-task edit and does NOT cascade/shift any other tasks. To mark a task as waiting on an external party use task_status 8 (Task for Client) or 12 (Task for Third Party).',
    {
      id: z.string().describe('The task ID to update'),
      title: z.string().optional().describe('New task title'),
      planned_start: z.string().optional().describe('New planned start date as YYYY-MM-DD (or Unix seconds)'),
      planned_due: z.string().optional().describe('New planned due date as YYYY-MM-DD (or Unix seconds)'),
      task_status: z.string().optional().describe('New task_status ID. 8 = Task for Client (waiting), 12 = Task for Third Party (waiting).'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the diff only.'),
    },
    async ({ id, title, planned_start, planned_due, task_status, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const body = {};
      if (title !== undefined) body.title = title;
      if (planned_start !== undefined) body.date_started = toUnixSeconds(planned_start);
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (task_status !== undefined) body.task_status = task_status;
      if (Object.keys(body).length === 0) {
        return ok({ status: 'error', message: 'No updatable fields provided.' });
      }
      const current = (await acceloGet(token, `/tasks/${encodeURIComponent(id)}`, { _fields: TASK_FIELDS })).response;
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      const diff = buildTaskDiff(current, body);
      if (confirm !== true) return needsConfirmation(`UPDATE task ${id} ("${current.title}")`, diff);
      const res = await acceloWrite(token, 'PUT', `/tasks/${encodeURIComponent(id)}`, body);
      return ok({ status: 'updated', task: res.response ? decorateTask(res.response) : res.response, applied: diff });
    }
  );

  server.tool(
    'create_task',
    'Create a new Accelo task against a milestone OR a job. WRITE OPERATION: requires confirm:true. First call (no confirm) previews the payload; call again with confirm:true to create. Exactly one of milestone_id or job_id is required. Accelo may require planned dates and/or an assignee depending on deployment; if creation fails, the Accelo error is returned.',
    {
      title: z.string().describe('Task title'),
      milestone_id: z.string().optional().describe('Milestone ID to attach the task to'),
      job_id: z.string().optional().describe('Job ID to attach the task directly to (when not under a milestone)'),
      planned_start: z.string().optional().describe('Planned start date as YYYY-MM-DD (or Unix seconds)'),
      planned_due: z.string().optional().describe('Planned due date as YYYY-MM-DD (or Unix seconds)'),
      assignee_id: z.string().optional().describe('Staff ID to assign the task to'),
      task_status: z.string().optional().describe('Initial task_status ID (e.g. 8 = Task for Client, 12 = Task for Third Party)'),
      confirm: z.boolean().optional().describe('Must be true to create. Omit/false to preview only.'),
    },
    async ({ title, milestone_id, job_id, planned_start, planned_due, assignee_id, task_status, confirm }) => {
      if (!milestone_id && !job_id) return ok({ status: 'error', message: 'Provide either milestone_id or job_id.' });
      if (milestone_id && job_id) return ok({ status: 'error', message: 'Provide only one of milestone_id or job_id.' });
      const token = await getValidAcceloToken(subject);
      const body = {
        title,
        against_type: milestone_id ? 'milestone' : 'job',
        against_id: milestone_id || job_id,
      };
      if (planned_start !== undefined) body.date_started = toUnixSeconds(planned_start);
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (assignee_id !== undefined) body.assignee = assignee_id;
      if (task_status !== undefined) body.task_status = task_status;
      const preview = {
        title,
        against: `${body.against_type}(${body.against_id})`,
        planned_start: planned_start ? tsToISO(body.date_started) : undefined,
        planned_due: planned_due ? tsToISO(body.date_due) : undefined,
        assignee_id, task_status,
      };
      if (confirm !== true) return needsConfirmation('CREATE a new task', preview);
      const res = await acceloWrite(token, 'POST', '/tasks', body);
      return ok({ status: 'created', task: res.response ? decorateTask(res.response) : res.response });
    }
  );

  server.tool(
    'update_milestone',
    'Update a single Accelo milestone. WRITE OPERATION: requires confirm:true. First call (no confirm) returns a before/after diff; call again with confirm:true to apply. Only the provided fields change. Single-object edit -- does NOT cascade to the milestone\'s tasks.',
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
      const res = await acceloWrite(token, 'PUT', `/milestones/${encodeURIComponent(id)}`, body);
      return ok({ status: 'updated', milestone: res.response ? decorateMilestone(res.response) : res.response, applied: diff });
    }
  );

  server.tool(
    'delete_task',
    'Delete an Accelo task by ID. WRITE OPERATION: requires confirm:true. First call (no confirm) shows what will be deleted; call again with confirm:true to delete. NOTE: the Accelo REST API may not support task deletion; if it returns an error, delete the task in the Accelo GUI or mark it cancelled/complete instead.',
    {
      id: z.string().describe('The task ID to delete'),
      confirm: z.boolean().optional().describe('Must be true to delete. Omit/false to preview only.'),
    },
    async ({ id, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const current = (await acceloGet(token, `/tasks/${encodeURIComponent(id)}`, { _fields: TASK_FIELDS })).response;
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      if (confirm !== true) {
        return needsConfirmation(`DELETE task ${id} ("${current.title}")`, { delete: { id, title: current.title } });
      }
      const res = await acceloWrite(token, 'DELETE', `/tasks/${encodeURIComponent(id)}`);
      return ok({ status: 'deleted', id, response: res.meta || res });
    }
  );
}
