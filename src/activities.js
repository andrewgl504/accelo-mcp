import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Activities module for the Accelo MCP: push notes / emails / time entries into
// Accelo and read interaction history, with threading + provenance tagging.
//
// Self-contained (own fetch + result helpers) so it does not collide with
// concurrent edits to accelo.js / projects.js / mcp.js. The only touch-point in
// mcp.js is a single registerActivityTools(server, subject) call.
//
// Accelo model notes (verified live against job 653, 2026-06):
//   - Activities are Accelo's universal interaction record (note, email,
//     meeting, call) and attach to a parent via against_type/against_id.
//   - medium distinguishes the kind: note | email | meeting | call. A NOTE is
//     internal; an EMAIL can be sent to external affiliations (recipients).
//   - Content: subject (required) + body (plaintext) or html_body (HTML).
//   - TIME is recorded in SECONDS via `billable` / `nonbillable` (not a flag).
//     We accept time_minutes and convert (minutes*60) into the chosen bucket.
//   - Threading: parent_id links a reply to its parent (top-level = 0);
//     thread_id groups the whole thread.
//   - visibility: we default to "all". confidential is a separate 0/1 flag.
//   - class: provenance/category. THIS DEPLOYMENT: class 13 = "Pushed from
//     LibreChat" -- used as the default so agent-created activities are
//     identifiable. (Other classes: 1 Client Work, 2 Sales, 3 Internal, ...)
//   - owner is the authenticated staff member (per-user OAuth) -- not settable.
//   - Dates are Unix seconds, anchored to the deployment TZ (America/Chicago).

const log = (...a) => console.log(new Date().toISOString(), '[activities]', ...a);

const TZ = process.env.ACCELO_TIMEZONE || 'America/Chicago';
const LIBRECHAT_CLASS_ID = process.env.ACCELO_LIBRECHAT_CLASS_ID || '13';

// Friendly parent names -> Accelo API against_type values. Accelo calls deals
// "prospects" and quotes are "quotes"; the rest map 1:1.
const AGAINST_TYPE_MAP = {
  task: 'task',
  job: 'job',
  project: 'job',
  milestone: 'milestone',
  issue: 'issue',
  ticket: 'issue',
  deal: 'prospect',
  prospect: 'prospect',
  sale: 'prospect',
  quote: 'quote',
  company: 'company',
  contact: 'affiliation',
  affiliation: 'affiliation',
};

const ACTIVITY_FIELDS = [
  'id', 'subject', 'body', 'html_body', 'preview_body', 'medium', 'class',
  'visibility', 'confidential', 'against', 'against_type', 'against_id',
  'owner', 'owner_id', 'parent_id', 'thread_id', 'standing',
  'billable', 'nonbillable', 'date_created', 'date_started', 'date_ended',
  'date_logged',
].join(',');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function needsConfirmation(action, payload) {
  return ok({
    status: 'confirmation_required',
    message: `This will ${action} in Accelo. Review the details below with the user, then call this tool again with confirm: true to proceed.`,
    pending: payload,
  });
}

function mapAgainstType(t) {
  const key = String(t || '').toLowerCase();
  return AGAINST_TYPE_MAP[key] || key;
}

async function acceloGet(token, pathname, query) {
  const url = new URL(config.acceloBaseUrl + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
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

async function acceloPost(token, pathname, body) {
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
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    log('ERROR POST', pathname, res.status, '-', msg);
    throw new Error(`Accelo API POST ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

function tsToISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(n * 1000));
}

function secondsToMinutes(s) {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : 0;
}

function decorateActivity(a) {
  if (!a || typeof a !== 'object') return a;
  return {
    id: a.id,
    subject: a.subject,
    medium: a.medium,
    body: a.body,
    visibility: a.visibility,
    class: a.class,
    against_type: a.against_type,
    against_id: a.against_id,
    owner_id: a.owner_id,
    parent_id: a.parent_id,
    thread_id: a.thread_id,
    billable_minutes: secondsToMinutes(a.billable),
    nonbillable_minutes: secondsToMinutes(a.nonbillable),
    date_created: tsToISO(a.date_created),
    date_logged: tsToISO(a.date_logged),
    date_started: tsToISO(a.date_started),
    date_ended: tsToISO(a.date_ended),
    _raw: { billable: a.billable, nonbillable: a.nonbillable, date_created: a.date_created },
  };
}

async function fetchActivities(token, againstType, againstId, limit = 50) {
  const type = mapAgainstType(againstType);
  const json = await acceloGet(token, '/activities', {
    _filters: `against(${type}(${againstId}))`,
    _fields: ACTIVITY_FIELDS,
    _limit: limit,
  });
  const list = Array.isArray(json.response) ? json.response : [];
  return list.map(decorateActivity);
}

// Core create. Returns the created activity (decorated) after a re-GET so the
// response reflects stored values.
async function createActivity(token, fields) {
  const res = await acceloPost(token, '/activities', fields);
  const created = res.response;
  if (created && created.id) {
    const after = await acceloGet(token, `/activities/${encodeURIComponent(created.id)}`, { _fields: ACTIVITY_FIELDS });
    return after.response ? decorateActivity(after.response) : decorateActivity(created);
  }
  return decorateActivity(created);
}

// Assemble the POST body shared by note/email/create_activity.
function buildActivityBody({
  against_type, against_id, subject, body, html_body, medium,
  visibility, class_id, confidential, parent_id, time_minutes, billable,
  date_started, date_ended,
}) {
  const out = {
    against_type: mapAgainstType(against_type),
    against_id,
    subject,
    medium: medium || 'note',
    visibility: visibility || 'all',
    class: class_id || LIBRECHAT_CLASS_ID,
  };
  if (html_body !== undefined) out.html_body = html_body;
  if (body !== undefined) out.body = body;
  if (confidential !== undefined) out.confidential = confidential ? '1' : '0';
  if (parent_id !== undefined && parent_id !== null && parent_id !== '') out.parent_id = String(parent_id);
  if (date_started !== undefined) out.date_started = date_started;
  if (date_ended !== undefined) out.date_ended = date_ended;
  if (time_minutes !== undefined && time_minutes !== null) {
    const secs = String(Math.round(Number(time_minutes) * 60));
    if (billable === false) out.nonbillable = secs; else out.billable = secs;
  }
  return out;
}

// Build a preview object for the confirm step (human-readable).
function previewOf(b) {
  return {
    against: `${b.against_type}(${b.against_id})`,
    medium: b.medium,
    subject: b.subject,
    body: b.html_body !== undefined ? '(html)' : b.body,
    visibility: b.visibility,
    class: b.class,
    reply_to_parent_id: b.parent_id || null,
    billable_minutes: b.billable ? Math.round(Number(b.billable) / 60) : undefined,
    nonbillable_minutes: b.nonbillable ? Math.round(Number(b.nonbillable) / 60) : undefined,
  };
}

export function registerActivityTools(server, subject) {
  // -------- Reads --------
  server.tool(
    'list_activities',
    'List the activity history (notes, emails, meetings, calls) logged against an Accelo object. Provide against_type (task, job, milestone, issue, deal, quote, company, contact) and against_id. Times are shown in minutes; dates in the deployment timezone. Read-only.',
    {
      against_type: z.string().describe('Parent type: task, job, milestone, issue, deal, quote, company, or contact'),
      against_id: z.string().describe('ID of the parent object'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
    },
    async ({ against_type, against_id, limit }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await fetchActivities(token, against_type, against_id, limit || 50));
    }
  );

  server.tool(
    'get_activity',
    'Get a single Accelo activity by ID, with body, medium, visibility, class, thread/parent linkage, and logged time (minutes). Read-only.',
    { id: z.string().describe('The activity ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/activities/${encodeURIComponent(id)}`, { _fields: ACTIVITY_FIELDS });
      return ok(json.response ? decorateActivity(json.response) : { status: 'error', message: 'Activity not found' });
    }
  );

  server.tool(
    'get_activity_thread',
    'Get all activities in the same thread as the given activity (the conversation/reply chain). Read-only.',
    { id: z.string().describe('Any activity ID within the thread') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      const one = (await acceloGet(token, `/activities/${encodeURIComponent(id)}`, { _fields: 'id,thread_id' })).response;
      if (!one) return ok({ status: 'error', message: 'Activity not found' });
      const threadId = one.thread_id || id;
      const json = await acceloGet(token, '/activities', { _filters: `thread(${threadId})`, _fields: ACTIVITY_FIELDS, _limit: 100 });
      const list = Array.isArray(json.response) ? json.response : [];
      return ok({ thread_id: threadId, activities: list.map(decorateActivity) });
    }
  );

  // -------- Writes (confirm:true-guarded) --------
  server.tool(
    'create_activity',
    'Create (push) an activity into Accelo against an object. WRITE OPERATION: requires confirm:true; first call previews, second call with confirm:true applies. medium = note (internal) or email (can target external affiliations). Optional time_minutes logs time (billable by default). Optional parent_id threads this as a reply. Defaults: visibility "all", class 13 (Pushed from LibreChat). Owner is the authenticated user.',
    {
      against_type: z.string().describe('Parent type: task, job, milestone, issue, deal, quote, company, or contact'),
      against_id: z.string().describe('ID of the parent object'),
      subject: z.string().describe('Activity subject (required by Accelo)'),
      body: z.string().optional().describe('Plaintext body (use html_body for rich email)'),
      html_body: z.string().optional().describe('HTML body (for emails)'),
      medium: z.enum(['note', 'email']).optional().describe('note (internal) or email (external-capable). Default note.'),
      visibility: z.string().optional().describe('Visibility. Default "all".'),
      class_id: z.string().optional().describe('Activity class ID. Default 13 (Pushed from LibreChat).'),
      confidential: z.boolean().optional().describe('Mark confidential. Default false.'),
      parent_id: z.string().optional().describe('Parent activity ID to thread this as a reply'),
      time_minutes: z.number().optional().describe('Time to log, in minutes (converted to seconds)'),
      billable: z.boolean().optional().describe('If time_minutes set: true=billable (default), false=nonbillable'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async (args) => {
      if (!args.subject) return ok({ status: 'error', message: 'subject is required.' });
      if (args.body === undefined && args.html_body === undefined) {
        return ok({ status: 'error', message: 'Provide body or html_body.' });
      }
      const b = buildActivityBody(args);
      if (args.confirm !== true) return needsConfirmation('CREATE an activity', previewOf(b));
      const token = await getValidAcceloToken(subject);
      return ok({ status: 'created', activity: await createActivity(token, b) });
    }
  );

  server.tool(
    'log_note',
    'Convenience tool: log an internal NOTE against an Accelo object. WRITE OPERATION: requires confirm:true (preview first). Notes are internal and never sent externally. Optional time_minutes logs time. Defaults: visibility "all", class 13 (Pushed from LibreChat).',
    {
      against_type: z.string().describe('Parent type: task, job, milestone, issue, deal, quote, company, or contact'),
      against_id: z.string().describe('ID of the parent object'),
      subject: z.string().describe('Note subject'),
      body: z.string().describe('Note body (plaintext)'),
      time_minutes: z.number().optional().describe('Time to log, in minutes'),
      billable: z.boolean().optional().describe('true=billable (default), false=nonbillable'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async (args) => {
      const b = buildActivityBody({ ...args, medium: 'note' });
      if (args.confirm !== true) return needsConfirmation('LOG a note', previewOf(b));
      const token = await getValidAcceloToken(subject);
      return ok({ status: 'created', activity: await createActivity(token, b) });
    }
  );

  server.tool(
    'log_email',
    'Convenience tool: log an EMAIL activity against an Accelo object. WRITE OPERATION: requires confirm:true (preview first). Unlike a note, an email medium can be associated with external affiliations. Provide html_body for rich content. Defaults: visibility "all", class 13 (Pushed from LibreChat). NOTE: actual outbound send behavior depends on the Accelo deployment; verify recipients before confirming.',
    {
      against_type: z.string().describe('Parent type: task, job, milestone, issue, deal, quote, company, or contact'),
      against_id: z.string().describe('ID of the parent object'),
      subject: z.string().describe('Email subject'),
      html_body: z.string().optional().describe('HTML email body'),
      body: z.string().optional().describe('Plaintext email body (if not using html_body)'),
      time_minutes: z.number().optional().describe('Time to log, in minutes'),
      billable: z.boolean().optional().describe('true=billable (default), false=nonbillable'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async (args) => {
      if (args.body === undefined && args.html_body === undefined) {
        return ok({ status: 'error', message: 'Provide body or html_body.' });
      }
      const b = buildActivityBody({ ...args, medium: 'email' });
      if (args.confirm !== true) return needsConfirmation('LOG an email', previewOf(b));
      const token = await getValidAcceloToken(subject);
      return ok({ status: 'created', activity: await createActivity(token, b) });
    }
  );

  server.tool(
    'reply_to_activity',
    'Reply to an existing Accelo activity, threading the reply under it. WRITE OPERATION: requires confirm:true (preview first). Inherits the parent activity\'s against object. medium defaults to note. Defaults: visibility "all", class 13 (Pushed from LibreChat).',
    {
      parent_id: z.string().describe('The activity ID to reply to'),
      subject: z.string().describe('Reply subject'),
      body: z.string().describe('Reply body (plaintext)'),
      medium: z.enum(['note', 'email']).optional().describe('note (default) or email'),
      time_minutes: z.number().optional().describe('Time to log, in minutes'),
      billable: z.boolean().optional().describe('true=billable (default), false=nonbillable'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async (args) => {
      const token = await getValidAcceloToken(subject);
      const parent = (await acceloGet(token, `/activities/${encodeURIComponent(args.parent_id)}`, { _fields: 'id,against_type,against_id' })).response;
      if (!parent) return ok({ status: 'error', message: `Parent activity ${args.parent_id} not found.` });
      const b = buildActivityBody({
        ...args,
        against_type: parent.against_type,
        against_id: parent.against_id,
        medium: args.medium || 'note',
      });
      if (args.confirm !== true) return needsConfirmation(`REPLY to activity ${args.parent_id}`, previewOf(b));
      return ok({ status: 'created', activity: await createActivity(token, b) });
    }
  );

  server.tool(
    'log_time',
    'Log a time entry against an Accelo object as a note activity. WRITE OPERATION: requires confirm:true (preview first). Use this to record how long work (e.g. a LibreChat session) took: pass time_minutes. The AGENT should compute time_minutes from the conversation (first to last message timestamps) and tell the user the math before confirming. Defaults: billable, visibility "all", class 13 (Pushed from LibreChat).',
    {
      against_type: z.string().describe('Parent type: task, job, milestone, issue, deal, quote, company, or contact'),
      against_id: z.string().describe('ID of the parent object'),
      subject: z.string().describe('What the time was for'),
      time_minutes: z.number().describe('Minutes of time to log'),
      body: z.string().optional().describe('Optional detail of the work done'),
      billable: z.boolean().optional().describe('true=billable (default), false=nonbillable'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async (args) => {
      const b = buildActivityBody({
        ...args,
        body: args.body !== undefined ? args.body : args.subject,
        medium: 'note',
      });
      if (args.confirm !== true) return needsConfirmation(`LOG ${args.time_minutes} minutes`, previewOf(b));
      const token = await getValidAcceloToken(subject);
      return ok({ status: 'created', activity: await createActivity(token, b) });
    }
  );
}
