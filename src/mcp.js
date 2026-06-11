import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as accelo from './accelo.js';
import { getValidAcceloToken } from './oauth.js';
import { registerProjectTools } from './projects.js';
import { registerActivityTools } from './activities.js';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Returned when a write tool is called without confirm:true. This is a
// deliberate human-in-the-loop guard: the agent must echo the payload to the
// user and obtain approval, then re-call the tool with confirm:true.
function needsConfirmation(action, payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            status: 'confirmation_required',
            message:
              `This will ${action} in Accelo. Review the payload below with the user, ` +
              'then call this tool again with confirm: true to proceed.',
            pending: payload,
          },
          null,
          2
        ),
      },
    ],
  };
}

// The complete set of client-editable Accelo quote fields, modeled explicitly
// so an agent can never misroute content (e.g. put a client-facing conclusion
// into the internal `notes` field). Keep these descriptions disambiguating.
//
// NOTE: `notes` is INTERNAL and must not be used for client-facing body text.
const editableQuoteFields = {
  title: z.string().optional().describe('Quote title.'),
  affiliation_id: z.string().optional().describe('Affiliation ID (the company/contact affiliation the quote is for).'),
  manager_id: z.string().optional().describe('Manager ID (the Accelo staff member who owns/manages the quote).'),
  date_expiry: z.string().optional().describe('Quote expiry date as a Unix timestamp in seconds.'),
  notes: z.string().optional().describe('INTERNAL notes only. NOT shown to the client. Do NOT put introduction, conclusion, or terms text here.'),
  introduction: z.string().optional().describe('Client-facing INTRODUCTION section shown at the top of the quote.'),
  conclusion: z.string().optional().describe('Client-facing CONCLUSION section shown at the bottom of the quote.'),
  terms_and_conditions: z.string().optional().describe('Client-facing TERMS AND CONDITIONS section of the quote.'),
  client_portal_access: z.string().optional().describe('Client portal access setting for the quote.'),
};

// Pull only the defined editable fields out of an args object, in the canonical
// Accelo key order. Undefined fields are omitted so PUT only changes what was
// provided.
function pickEditableFields(args) {
  const body = {};
  for (const key of Object.keys(editableQuoteFields)) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

// Build a fresh MCP server bound to a specific authenticated subject
// (i.e. one Accelo user). All Accelo calls run as that user, so Accelo's
// own permission model is respected.
export function buildServer(subject) {
  const server = new McpServer({ name: 'accelo-mcp', version: '0.4.0' });

  server.tool(
    'list_quotes',
    'List or search quotes in Accelo. Returns only quotes the authorized user can see.',
    {
      search: z.string().optional().describe('Free-text search across the quote title'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
      page: z.number().int().min(0).optional().describe('Zero-based page number'),
      filters: z.string().optional().describe("Raw Accelo _filters expression, e.g. standing(active)"),
    },
    async ({ search, limit, page, filters }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.listQuotes(token, { search, limit, page, filters }));
    }
  );

  server.tool(
    'get_quote',
    'Get a single Accelo quote by its ID.',
    { id: z.string().describe('The quote ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.getQuote(token, id));
    }
  );

  server.tool(
    'get_deal',
    'Get a single Accelo deal (a.k.a. sale/prospect) by its ID. Use this to resolve the parent deal of a quote: when a quote has against_type == "prospect", its against_id is the deal ID. Returns the full deal record including title, value, standing, and dates such as date_actioned (when the deal was actioned/won).',
    { id: z.string().describe("The deal/prospect ID, e.g. a quote's against_id") },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.getDeal(token, id));
    }
  );

  server.tool(
    'create_quote',
    'Create a new Accelo quote. WRITE OPERATION: requires confirm:true. Call once without confirm to preview the payload, show it to the user for approval, then call again with confirm:true. Each editable field maps 1:1 to an Accelo quote key; pick the field that matches the user intent (e.g. a client-facing closing goes in `conclusion`, NOT `notes`).',
    {
      against_type: z.string().optional().describe("Object type the quote is against, e.g. 'company' or 'prospect'"),
      against_id: z.string().optional().describe('ID of the object the quote is against'),
      ...editableQuoteFields,
      confirm: z.boolean().optional().describe('Must be true to actually create the quote. Omit/false to preview only.'),
    },
    async (args) => {
      const { against_type, against_id, confirm } = args;
      if (args.title === undefined) {
        return ok({ status: 'error', message: 'A `title` is required to create a quote.' });
      }
      const body = {
        ...(against_type ? { against_type } : {}),
        ...(against_id ? { against_id } : {}),
        ...pickEditableFields(args),
      };
      if (confirm !== true) return needsConfirmation('CREATE a new quote', body);
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.createQuote(token, body));
    }
  );

  server.tool(
    'update_quote',
    'Update an existing Accelo quote by ID. WRITE OPERATION: requires confirm:true. Call once without confirm to preview the change, show it to the user for approval, then call again with confirm:true. Only the provided fields are changed. Each editable field maps 1:1 to an Accelo quote key; pick the field that matches the user intent (e.g. a client-facing closing goes in `conclusion`, NOT `notes`).',
    {
      id: z.string().describe('The quote ID to update'),
      ...editableQuoteFields,
      confirm: z.boolean().optional().describe('Must be true to actually update the quote. Omit/false to preview only.'),
    },
    async (args) => {
      const { id, confirm } = args;
      const body = pickEditableFields(args);
      if (Object.keys(body).length === 0) {
        return ok({ status: 'error', message: 'No editable fields provided; nothing to update.' });
      }
      if (confirm !== true) return needsConfirmation(`UPDATE quote ${id}`, { id, ...body });
      const token = await getValidAcceloToken(subject);
      return ok(await accelo.updateQuote(token, id, body));
    }
  );

  // Project-planning tools (read + task/milestone writes).
  registerProjectTools(server, subject);

  // Activity tools (notes/emails/time, threading, provenance).
  registerActivityTools(server, subject);

  return server;
}
