import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Phase 1 of the project-planning module: READ-ONLY tools that give an agent
// visibility into an Accelo project plan (job -> milestones -> tasks).
//
// Kept deliberately self-contained (its own fetch helper + MCP result helper)
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
//     GUI engine (future Playwright phase).
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
    log('ERROR', pathname, res.status, '-', msg);
    throw new Error(`Accelo API GET ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

function tsToISO(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
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

  // Tasks attached directly to the job (no milestone).
  const jobTasks = await fetchTasksAgainst(token, 'job', jobId);

  // Roll up everything the team is waiting on (native status 8 / 12).
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

// Register the read-only project tools onto an existing McpServer instance.
export function registerProjectTools(server, subject) {
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
}
