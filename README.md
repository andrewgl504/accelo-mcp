# accelo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Accelo](https://www.accelo.com). It exposes Accelo **quote** tools to MCP
clients (such as LibreChat agents) and authenticates **per user** via Accelo
OAuth, so every action respects that user's own Accelo permissions.

> Status: early. Tools: `list_quotes`, `get_quote`, `get_deal`, `create_quote`, `update_quote`.

## How auth works

This server is an **OAuth proxy**:

- To the MCP client it acts as an OAuth **Authorization Server** (with
  discovery + dynamic client registration + PKCE).
- To Accelo it acts as an OAuth **client** (authorization-code grant).

The MCP client never sees the Accelo token. When a user authorizes, they are
bounced to Accelo's consent screen; the resulting Accelo access/refresh tokens
are stored locally (SQLite) keyed to an opaque subject, and the MCP client is
handed one of *our* opaque tokens that maps back to it. Accelo tokens are
refreshed automatically.

## Quote fields

`create_quote` and `update_quote` model every client-editable Accelo quote
field explicitly, each mapping 1:1 to an Accelo quote key. Pick the field that
matches the user's intent — **do not** route client-facing body text into
`notes`.

| Field | Client-facing? | Notes |
| --- | --- | --- |
| `title` | — | Quote title. Required on create. |
| `affiliation_id` | — | Company/contact affiliation the quote is for. |
| `manager_id` | — | Accelo staff member who owns/manages the quote. |
| `date_expiry` | — | Expiry date as a Unix timestamp (seconds). |
| `notes` | **No (INTERNAL)** | Internal notes only. **Never** put introduction/conclusion/terms text here. |
| `introduction` | **Yes** | Introduction section shown at the top of the quote. |
| `conclusion` | **Yes** | Conclusion section shown at the bottom of the quote. |
| `terms_and_conditions` | **Yes** | Terms and conditions section. |
| `client_portal_access` | **Yes** | Client portal access setting. |

> History: earlier versions only surfaced `title` and `notes` as named params;
> all other keys were reachable only through an unconstrained freeform `fields`
> map. A request to set the **conclusion** therefore got silently written to
> **`notes`** (Accelo accepts it, so no error was raised). These fields are now
> modeled explicitly and the freeform passthrough was removed. See
> `src/mcp.js` (`editableQuoteFields`).

## Prerequisites

1. An Accelo deployment (e.g. `https://YOURDEPLOY.api.accelo.com`).
2. A registered Accelo **Web Application** (Accelo: Configurations -> API ->
   Register Application). Set its redirect URI to:
   `https://<your-public-host>/oauth/callback`
3. Node 20+ or Docker.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Var | Description |
| --- | --- |
| `ACCELO_CLIENT_ID` / `ACCELO_CLIENT_SECRET` | From your Accelo Web App |
| `ACCELO_BASE_URL` | `https://YOURDEPLOY.api.accelo.com/api/v0` |
| `ACCELO_OAUTH_URL` | `https://YOURDEPLOY.api.accelo.com/oauth2/v0` |
| `PUBLIC_BASE_URL` | Public HTTPS URL of this server |
| `OAUTH_REDIRECT_URI` | `<PUBLIC_BASE_URL>/oauth/callback` (must match Accelo) |
| `OAUTH_SCOPE` | Accelo scopes, e.g. `read(all) write(all)` |
| `TOKEN_DB_PATH` | SQLite path (default `/app/data/tokens.db`) |
| `PORT` | Listen port (default `8787`) |

Never commit `.env` (it is gitignored).

## Run

### Docker (recommended)

```bash
docker compose up -d --build
curl -s http://127.0.0.1:8787/healthz
```

The compose file publishes only on loopback (`127.0.0.1:8787`). Put a TLS
reverse proxy (nginx, Caddy, etc.) in front of it for `PUBLIC_BASE_URL`.

### Node

```bash
npm install
npm start
```

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP streamable-HTTP endpoint (Bearer auth) |
| `GET /.well-known/oauth-authorization-server` | AS metadata |
| `GET /.well-known/oauth-protected-resource` | Resource metadata |
| `POST /register` | Dynamic client registration |
| `GET /authorize` | Start auth (redirects to Accelo) |
| `GET /oauth/callback` | Accelo redirect target |
| `POST /token` | Token + refresh |
| `GET /healthz` | Health check |

## Using with LibreChat

Add an MCP server pointing at `https://<your-public-host>/mcp` with OAuth
enabled. LibreChat will discover the OAuth endpoints, register a client, and
prompt each user to authorize Accelo on first use.

## License

MIT
