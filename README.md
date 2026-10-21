# Super Productivity MCP

**Give your AI assistant real access to your tasks — without giving up local-first.**

An [MCP](https://modelcontextprotocol.io) server that reads and writes your
[Super Productivity](https://super-productivity.com) tasks through the sync file
already sitting in your Nextcloud. No plugin, no fork, no second app to keep in
step.

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Super          │  sync   │    Nextcloud     │  sync   │  This MCP       │
│  Productivity   │ ──────► │  sync-data.json  │ ◄────── │  server         │
│  desktop/mobile │ ◄────── │                  │ ──────► │                 │
└─────────────────┘         └──────────────────┘         └────────┬────────┘
                                                                  │ MCP
                                                         ┌────────▼────────┐
                                                         │  OpenClaw,      │
                                                         │  Claude, …      │
                                                         └─────────────────┘
```

---

## Why this exists

Super Productivity is deliberately local-first. There is no remote API, no
outgoing webhook, and the desktop app's local REST API binds to `127.0.0.1` —
unreachable from anywhere else by design. The CalDAV plugin exports only tasks
that already have a date, and exports them as calendar _events_, not tasks.

The sync file is different. It holds **everything**: every project, every tag,
the whole undated backlog, subtasks, estimates, time tracking. It is already on
your server. It is the complete picture, and nothing else is.

So this server talks to that.

## What makes it safe

The naive version of this idea — download the JSON, edit it, upload it — will
eventually destroy your task history. Super Productivity is not a file with
tasks in it; it is an **operation log with vector clocks**, and your devices
merge changes by replaying operations, not by comparing files.

This server participates in that protocol properly. It behaves as one more
device on your account:

|                                   | Naive file editor                      | This server                                   |
| --------------------------------- | -------------------------------------- | --------------------------------------------- |
| **Concurrent edit on your phone** | Silently overwritten                   | Detected, re-applied on top                   |
| **Other devices see the change**  | As a mysterious whole-file replacement | As a normal operation, like any device        |
| **Identity in the sync protocol** | None — masquerades as your desktop     | Its own client id, its own vector clock entry |
| **A field it doesn't understand** | Dropped                                | Preserved byte-for-byte                       |
| **Interrupted write**             | Corrupt file                           | Previous version still in `.bak`              |
| **Sync file format changed**      | Breaks                                 | Detected and handled                          |

Concretely, every write:

1. **Reads with a strong ETag.** Nextcloud's `OC-ETag`, which survives reverse
   proxies rewriting the plain `ETag`.
2. **Applies the change through a faithful port of Super Productivity's own
   reducers** — so `TODAY` stays a virtual tag, `dueDay` and `dueWithTime` stay
   mutually exclusive, and completing a task never invents a due date.
3. **Emits the matching operation** with this server's client id and an
   incremented vector clock, so your other devices accept it as causally newer
   rather than flagging it as a conflict.
4. **Refreshes the `.bak`** before touching the primary file.
5. **Writes conditionally, on the revision it read.** Never unconditionally.
   If another device wrote first, the whole mutation re-runs against the fresh
   state — their change survives, yours applies on top.

> Verified against a live Nextcloud: `If-Match` is genuinely enforced, and after
> a full create/schedule/complete/delete cycle the remote is still a valid
> schema-4 envelope with archives and untouched state byte-identical.

---

## Quick start

**Requirements:** Node 20.11+, a Nextcloud with Super Productivity already
syncing to it.

```bash
git clone <this-repo> superproductivity-mcp
cd superproductivity-mcp
npm install
cp .env.example .env
```

Fill in `.env`:

```ini
SP_NEXTCLOUD_URL=https://cloud.example.com
SP_NEXTCLOUD_USER=yourname
SP_NEXTCLOUD_PASSWORD=xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
SP_SYNC_FOLDER=super-productivity
```

> **Use an app password**, not your login password: Settings → Security →
> Devices & sessions → Create new app password. It is scoped, revocable, and it
> is the only thing that works when two-factor authentication is on.

Check everything before wiring it up to anything:

```bash
npm run doctor
```

```
Super Productivity MCP — doctor (v1.0.0)

  ok   configuration                https://cloud.example.com as yourname
  ok   sync folder                  super-productivity
  ok   mode                         read-write
  ok   client id                    M_TSrPmbHAoq
  ok   encryption                   not configured (the sync file must be plaintext)
  ok   reachable                    Nextcloud answered and the credentials were accepted
  ok   sync file                    SINGLE_FILE (sync-data.json)
  ok   decoded                      syncVersion 114, schema 4
  ok   conditional writes           the server returns a strong ETag, so concurrent writes are safe
  ok   devices                      B_UjDTUW, A_rmkezu
  ok   operation log                354 of 2000 retained
  ok   contents                     12 open tasks, 3 projects, 4 tags

All checks passed. The MCP server should work.
```

The doctor never writes. If a step fails, it says which one and why — which is
the whole point of having it, because every failure mode here otherwise shows up
inside your AI client as an unhelpful "the tool didn't work".

Then build:

```bash
npm run build
```

## Connecting it

<details open>
<summary><b>OpenClaw</b></summary>

Add to your MCP server configuration:

```json
{
  "mcpServers": {
    "superproductivity": {
      "command": "node",
      "args": ["/absolute/path/to/superproductivity-mcp/dist/main.js"],
      "env": {
        "SP_NEXTCLOUD_URL": "https://cloud.example.com",
        "SP_NEXTCLOUD_USER": "yourname",
        "SP_NEXTCLOUD_PASSWORD": "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
        "SP_SYNC_FOLDER": "super-productivity"
      }
    }
  }
}
```

You can leave `env` out entirely and let it read the `.env` file instead — set
`SP_ENV_FILE` to an absolute path if the working directory won't be the project
root.

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Same shape, in `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS,
`%APPDATA%\Claude\` on Windows).

</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add superproductivity -- node /absolute/path/to/dist/main.js
```

</details>

<details>
<summary><b>Any other MCP host</b></summary>

It is a standard stdio MCP server. Run `node dist/main.js`; it speaks JSON-RPC
on stdout and logs to stderr only.

</details>

---

## Running on a server (HTTP)

The same binary can listen over the MCP Streamable HTTP transport, which is what
a remote agent (or an always-on VPS install) needs. Set `MCP_TRANSPORT=http` and
an `MCP_AUTH_TOKEN` — the server **refuses to start** over HTTP without one.

```bash
openssl rand -base64 32        # generate a token
npm run build
MCP_TRANSPORT=http MCP_AUTH_TOKEN=… node dist/main.js
```

It listens on `http://127.0.0.1:8787/mcp` by default. `GET /healthz` answers
`ok` without a token, for liveness probes. Every `/mcp` request must carry:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Client configuration is then a URL rather than a command:

```json
{
  "mcpServers": {
    "superproductivity": {
      "type": "http",
      "url": "https://sp.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Keeping it running

`deploy/run.sh` is a small supervisor: it runs the server and restarts it five
seconds after a non-zero exit. `deploy/sp-mcp.service` is the equivalent
systemd unit if you prefer one.

```bash
npm ci && npm run build
nohup ./deploy/run.sh >>sp-mcp.log 2>&1 &
```

### TLS with Caddy

Put Caddy in front so the process stays on loopback and never terminates TLS
itself. Point the subdomain at the VPS, then use `deploy/Caddyfile.example`:

```
sp.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains and renews the certificate automatically. The bearer token is
checked by the server, so there is exactly one place that decides who may call
it — no second auth layer to drift out of sync.

### Calendar tools (CalDAV)

Set `CALDAV_URL` to enable the `calendar_*` tools. It accepts the Nextcloud base
URL, the DAV root, a calendar home, or a single calendar; credentials default to
the Nextcloud ones already configured. They are read-only until you set
`CALENDAR_MODE=read-write`, and writes need a target calendar named explicitly:

```bash
CALDAV_URL=https://cloud.example.com
CALDAV_CALENDARS=Personal,Work
CALDAV_WRITE_CALENDAR=Personal
CALENDAR_MODE=read-only      # or read-write
```

Calendar credentials should be a Nextcloud **app password** — scoped and
revocable — not the account password.

---

## Tools

### Reading

| Tool               | What it answers                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sp_overview`      | _"Where do things stand?"_ Counts, today's tasks, overdue work, all projects and tags with their ids. **Start here.**                  |
| `sp_list_tasks`    | Filter by project, tag, status, schedule or text. Ordered the way you'd work through them: overdue → today → by date → backlog → done. |
| `sp_get_task`      | One task in full, with notes and subtasks.                                                                                             |
| `sp_list_projects` | Projects with task counts.                                                                                                             |
| `sp_list_tags`     | Tags with ids.                                                                                                                         |

### Writing

| Tool                                         | Notes                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `sp_create_task`                             | Title is the only requirement. Pass `parentId` to create a subtask.                       |
| `sp_update_task`                             | Patches only the fields you send, so concurrent edits survive.                            |
| `sp_complete_task`                           | Complete, or reopen with `isDone: false`.                                                 |
| `sp_delete_task`                             | Deletes the task and its subtasks. Marked **destructive** so your host can confirm first. |
| `sp_schedule_task`                           | `dueDay` for all-day, `dueAt` for a specific time, `clear: true` to unschedule.           |
| `sp_plan_for_today` / `sp_remove_from_today` | The right tools for "do this today".                                                      |
| `sp_create_project` / `sp_update_project`    | Create, rename, archive, toggle backlog.                                                  |
| `sp_create_tag` / `sp_update_tag`            | Duplicate names are refused.                                                              |

### Diagnostics

| Tool                 | Notes                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `sp_sync_status`     | Layout, sync version, which devices have been writing, and any warnings. |
| `sp_recent_activity` | The operation log in plain language — _"did that actually save?"_        |

### Calendar (when `CALDAV_URL` is set)

| Tool                            | Notes                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `calendar_list_calendars`       | Calendars this server can see, with the href/name every other tool accepts.          |
| `calendar_list_events`          | Events in a window, with recurring events expanded into occurrences.                 |
| `calendar_get_event`            | One event by UID or href.                                                            |
| `calendar_search_events`        | Case-insensitive search over title, notes and location.                              |
| `calendar_create_event`         | Write mode only.                                                                     |
| `calendar_update_event`         | Patches only the fields you pass; recurrence, alarms and attendees are preserved.    |
| `calendar_delete_event`         | Write mode only. Marked destructive.                                                 |
| `calendar_time_block_from_task` | Puts a task on the calendar; re-running updates the block instead of duplicating it. |

In `SP_MODE=read-only` the write tools are not advertised at all, rather than
advertised and refused. A tool a model can see is a tool it will try. Calendar
writes have their own switch (`CALENDAR_MODE`), so tasks can be writable while
the calendar stays read-only, or the reverse.

### Two things worth knowing

**"Today" is not a tag you apply.** A task is in Today because its due date is
today. `sp_plan_for_today` is the way to put it there; the `TODAY` tag's task
list only stores ordering.

**Durations are in minutes.** Super Productivity stores milliseconds; this
server converts at the boundary so nothing is ever off by a factor of sixty.

---

## Configuration

| Variable                  | Default              | Notes                                                                                                                |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SP_NEXTCLOUD_URL`        | _required_           | Base URL, no path. `http://` is upgraded if your server redirects.                                                   |
| `SP_NEXTCLOUD_USER`       | _required_           | The username your files live under.                                                                                  |
| `SP_NEXTCLOUD_PASSWORD`   | _required_           | App password strongly preferred.                                                                                     |
| `SP_NEXTCLOUD_LOGIN_NAME` | —                    | Only if your instance logs in by email but stores files under a different username.                                  |
| `SP_SYNC_FOLDER`          | `super-productivity` | Folder inside your Nextcloud.                                                                                        |
| `SP_ENCRYPTION_PASSWORD`  | —                    | **Only** if you enabled encryption in Super Productivity's sync settings. Must match exactly.                        |
| `SP_MODE`                 | `read-only`          | `read-write` enables task writes; `read-only` hides every write tool.                                                |
| `SP_CLIENT_ID`            | derived              | This server's identity in the vector clock. Derived stably from machine + target; set it only if you need to pin it. |
| `SP_CACHE_TTL_SECONDS`    | `20`                 | How long a read may be served from cache. Writes always refetch.                                                     |
| `SP_LOG_LEVEL`            | `info`               | `silent` \| `error` \| `warn` \| `info` \| `debug`. Always stderr.                                                   |
| `SP_REQUEST_TIMEOUT_MS`   | `30000`              | Per-request timeout.                                                                                                 |
| `SP_ENV_FILE`             | `./.env`             | Where to read the env file from.                                                                                     |
| `MCP_TRANSPORT`           | `stdio`              | `stdio` \| `http`.                                                                                                   |
| `MCP_HOST`                | `127.0.0.1`          | Bind address in HTTP mode.                                                                                           |
| `MCP_PORT`                | `8787`               | Listen port in HTTP mode.                                                                                            |
| `MCP_AUTH_TOKEN`          | —                    | **Required** for HTTP. Bearer token every `/mcp` request must present.                                               |
| `CALDAV_URL`              | —                    | Set to enable calendar tools. Base URL, DAV root, calendar home or one calendar.                                     |
| `CALDAV_USER`             | Nextcloud user       | Separate DAV account, if any.                                                                                        |
| `CALDAV_PASSWORD`         | Nextcloud password   | App password recommended.                                                                                            |
| `CALDAV_CALENDARS`        | all discovered       | Comma-separated hrefs or display names to expose.                                                                    |
| `CALDAV_WRITE_CALENDAR`   | —                    | Calendar writes target. Required when more than one calendar is exposed.                                             |
| `CALENDAR_MODE`           | `read-only`          | `read-only` \| `read-write`. Independent of `SP_MODE`.                                                               |

Legacy `nextcloud_user` / `nextcloud_password` names are also accepted, so an
existing `.env` needs no renaming.

> **Why the `.env` file is parsed rather than sourced:** app passwords routinely
> begin with `$`, and `source .env` in a shell expands `$Nyd0…` to the empty
> string. The resulting failure looks exactly like a wrong password. This server
> reads the file literally and sidesteps the whole class of confusion.

---

## How it works

```
src/
├── domain/          Pure. No I/O, no framework, no network.
│   ├── model/         Super Productivity's state, as we read it
│   ├── reducers/      Faithful ports of upstream's own reducers
│   ├── sync/          Vector clocks, the compact operation format
│   ├── errors.ts      One taxonomy, split by what the caller should do
│   └── ports.ts       The boundary: FileStore, Clock, IdGenerator, Logger
├── application/     Use cases and projections
│   ├── workspace.ts   Read-modify-write with optimistic concurrency
│   ├── read-models.ts Raw state → something a model can act on
│   └── services/      Task, organiser and diagnostics use cases
├── infrastructure/  Everything that touches the outside world
│   ├── codec/         The pf_ prefix, gzip, Argon2id + AES-GCM
│   ├── webdav/        Conditional writes, strong validators
│   ├── sync/          Layout detection, operation replay
│   └── config/        Env loading and validation
├── presentation/    The MCP tool surface
└── composition-root.ts  The only place a concrete dependency is chosen
```

The dependency rule points inward: `domain` knows nothing about WebDAV or MCP.
That is not decoration — it is why the integration suite can run the **entire**
stack, including the conditional-write retry logic, against an in-memory store
with a frozen clock, offline, in under two seconds.

### Both sync layouts, detected automatically

Super Productivity has shipped two remote layouts, and can migrate a folder at
any time:

- **Single file** — `sync-data.json` holds the snapshot, archives and log
  together. The default.
- **Split** — `sync-ops.json` is the commit point, `sync-state.json` the
  snapshot. Opt-in ("Surgical sync").

The layout is detected on every read, never configured. In the split layout the
snapshot is rewritten only on compaction, so it can lag by up to 2000
operations; this server replays the pending log to close the gap, and **reports
anything it could not replay** instead of quietly showing you an incomplete
picture.

### Encryption

If you enabled encryption in Super Productivity, set `SP_ENCRYPTION_PASSWORD`
to the same password. The pipeline — JSON → gzip → Argon2id-derived AES-256-GCM
— matches upstream exactly, including the legacy PBKDF2 format for files written
by older clients.

A plaintext file is **refused** when encryption is configured. The encryption
flag lives outside the authenticated envelope, so anyone who can write to your
remote could strip it and serve you their own data; local intent wins over the
remote's self-declaration.

---

## Development

```bash
npm test              # unit + integration, no network, ~2s
npm run test:unit
npm run test:integration
npm run test:coverage
npm run test:e2e      # real Nextcloud — see below
npm run verify        # format + lint + typecheck + test
npm run dev           # run from source
```

**284 tests.** The integration suite runs the whole stack against an in-memory
store that evaluates `If-Match` for real, covering the situations that are
otherwise near-impossible to stage: a rival device committing inside the
read-write gap, a server with no usable ETags, a failed backup write, a
tombstoned folder, a corrupt remote.

The test fixture is a real sync file — same envelope, same 344-operation log,
same schema version — with every title and note replaced by synthetic text.

### End-to-end

`npm run test:e2e` runs against a real Nextcloud, in a **separate sandbox
folder** seeded from a copy of your sync file and deleted afterwards. Your real
sync folder is never written to by the suite. It skips itself when no
credentials are configured.

Set `SP_E2E_FOLDER` in `.env` (default `super-productivity-mcp-e2e`). It must
differ from `SP_SYNC_FOLDER`; the suite creates, overwrites and deletes files
inside it.

---

## Limitations

Stated plainly, because the alternative is discovering them later:

- **Sync is not instant.** Changes land in the sync file immediately; your
  desktop and phone pick them up on their next sync.
- **Archived tasks are read-only.** This server reads your archives but never
  writes to them. Complete tasks instead of archiving them.
- **The split layout is append-only.** When its operation log fills up, the
  server refuses further writes and tells you to open Super Productivity once
  so it can compact. Compacting would mean publishing a partially-replayed
  snapshot as authoritative, which could silently discard whatever it failed to
  replay.
- **No time tracking or Pomodoro.** Those are local, live features; there is
  nothing sensible to write from here.
- **Notes and repeating tasks are read-through, not writable.**
- **One level of subtask nesting**, matching Super Productivity itself.

## Troubleshooting

| Symptom                                  | Likely cause                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Nextcloud rejected the credentials`     | Login password with 2FA enabled — use an app password. Or a password starting with `$` that a shell ate; this server parses `.env` literally, but your process manager may not. |
| `Remote file not found: sync-data.json`  | Wrong `SP_SYNC_FOLDER`. Check the folder name in Nextcloud's file browser.                                                                                                      |
| `Not a Super Productivity sync file`     | Pointed at the wrong file, or encryption is on and `SP_ENCRYPTION_PASSWORD` is unset.                                                                                           |
| `The remote sync file is plaintext but…` | `SP_ENCRYPTION_PASSWORD` is set but encryption is off in the app. Clear it.                                                                                                     |
| `no usable ETag` in the doctor           | A proxy is stripping ETag headers. Writes will refuse rather than risk overwriting another device. Fix the proxy.                                                               |
| Changes not visible on your phone        | Open the app and let it sync. Check `sp_sync_status` for which devices have been writing.                                                                                       |
| `another device kept writing first`      | Something is syncing in a tight loop. Try again in a moment. Nothing was changed.                                                                                               |

---

## Credits

Built against [Super Productivity](https://github.com/johannesjo/super-productivity)
by Johannes Millan. The operation-log format, vector-clock algorithms and
reducer semantics here are ports of that project's own implementation — see
[`docs/sync-and-op-log/`](https://github.com/johannesjo/super-productivity/tree/master/docs/sync-and-op-log)
for the architecture this server had to learn to speak.

## License

MIT
