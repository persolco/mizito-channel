# mizito-channel

A command-line tool and [MCP](https://modelcontextprotocol.io) server that lets an AI agent use
[Mizito](https://office.mizito.ir) as a chat channel: list chats, read history, search, and
receive new messages. Sending is possible but **off by default**.

> **Unofficial.** Mizito has no public API. This talks to the same internal backend the web app
> uses (`https://app.mizito.ir`), signed in as *your own account*. It can break without notice, and
> automating login may conflict with Mizito's terms. Use it only with your own account and keep
> request rates low. Repeated logins can get an account flagged, so this tool caches the session
> token, logs in again only when the server rejects it, and **refuses to log in more than 3 times in
> 10 minutes** (tracked in `logins.json`).

## Contents

- [Quick start](#quick-start) · [CLI](#cli) · [MCP server](#mcp-server) · [Message format](#message-format)
- [Receiving new messages](#receiving-new-messages) · [Hermes Telegram forwarding](#hermes-telegram-forwarding) · [Sending](#sending) · [Configuration](#configuration)
- [Files and security](#files-and-security) · [Exit codes](#exit-codes) · [Limitations](#limitations) · [Development](#development)

## Quick start

Requires [Bun](https://bun.sh) 1.x.

```bash
git clone <this repo> && cd mizito-channel
bun install

bun src/cli/main.ts login            # asks for username and password, stores them (mode 0600)
bun src/cli/main.ts chats            # list your chats
bun src/cli/main.ts read "Team" --limit 5
```

Optional standalone binary (no Bun needed to run it):

```bash
bun run build                        # produces dist/mizito
./dist/mizito chats
```

Examples below use `mizito` for whichever you run (`bun src/cli/main.ts` or `./dist/mizito`).

## Local SQLite chat logger

`mizito log` explicitly archives selected exact chat IDs/names into a local SQLite database. Message text and actual supported voice/image bytes are stored in the database as BLOBs, not temporary-file pointers. Existing authentication is reused. It never sends messages, marks chats read, or takes the live watcher's lock/cursors.

```bash
# Text plus attachment metadata, latest 150 messages from one exact chat
mizito log "Exact team name" --db "$HOME/.config/mizito/chat-log/history.sqlite" --limit 150 --json

# Include supported voice notes and JPEG/PNG/WebP photos; poll the recent window every 30 seconds
MIZITO_ALLOW_DOWNLOAD=1 mizito log "Exact team name" --db "$HOME/.config/mizito/chat-log/history.sqlite" --limit 150 --media --follow --interval 30 --json
```

`--media` and `MIZITO_ALLOW_DOWNLOAD=1` are both required for media collection. Downloads remain off for ordinary read/search/watch calls. Multiple explicit chat arguments are accepted; wildcard/all-chat collection is not implicit. Reruns deduplicate messages, update observed edits/deletions, reuse successful unchanged media, and retry failures. Documents/videos and other unsupported media are recorded as metadata with an explicit unsupported status, never falsely reported as archived bytes. There is no cloud vision or transcription in this logger.

**The archive is plaintext, not encrypted.** It contains private messages and requested media; protect it and its backups. The directory is mode `0700` and DB `0600`; unsafe existing paths are refused. Output is counters only. `--follow` runs in the foreground until Ctrl-C; no service is installed or collection started automatically. This is a bounded recent-window logger, not a promise of complete history or gap-free capture during bursts exceeding the window. See [logger details](docs/chat-logger.md).

## CLI

| Command | What it does |
|---|---|
| `mizito login` | Prompts for username/password (or uses `MIZITO_USERNAME` / `MIZITO_PASSWORD`), logs in once, saves credentials and the session token. |
| `mizito chats [--json]` | Lists chats: id, `group`/`dm`, unread count, name. |
| `mizito projects [--json]` | Lists project ids, titles, and member ids for task creation and assignment. |
| `mizito tasks [mine\|following\|project\|done] [--project ID] [--offset N] [--json]` | Lists Mizito tasks. Defaults to open tasks assigned to you. Project scope requires `--project`. |
| `mizito task-get <task-id> [--project ID] [--json]` | Reads task details by id. Use `--project` for tasks outside your own lists. |
| `mizito task-create <project-id> <title> [--notes TEXT] [--assignee ID] [--deadline ISO]` | Creates a task. Repeat `--assignee` for multiple people; omitting it assigns the task to you. |
| `mizito task-update <task-id> [--title TEXT] [--notes TEXT] [--deadline ISO] [--assignee ID] [--project ID] [--moveTo ID]` | Replaces the supplied fields. `--project` helps find a task; `--moveTo` moves it to another project. An empty deadline clears it. |
| `mizito task-delete <task-id> [--project ID]` | Moves a task to Mizito's trash. |
| `mizito task-complete <task-id> [--project ID]` / `mizito task-reopen <task-id> [--project ID]` | Marks a task done or reopens it. |
| `mizito task-comment <task-id> <text> [--project ID]` | Adds a comment visible to task participants. |
| `mizito read <chat> [--limit N] [--json]` | Recent messages from a chat. Text output is oldest first; `--json` is newest first. Default limit 15. |
| `mizito search <chat> <text> [--json]` | Searches a chat's history (scans up to 20 pages of 15 messages, newest first). |
| `mizito watch [--json]` | Streams new messages from all chats until Ctrl-C. With `--json`, one JSON object per line. |
| `mizito hermes-watch` | Durably forwards incoming messages to a signed Hermes webhook. Requires `HERMES_WEBHOOK_URL` and `HERMES_WEBHOOK_SECRET`. |
| `mizito send <chat> <text>` | Sends a message as you. Refused unless `MIZITO_ALLOW_SEND=1`. |
| `mizito send-files <chat> <path...> [--text <caption>]` | Uploads and sends 1–10 local files as separate messages; the optional caption is placed on the last file. Refused unless `MIZITO_ALLOW_SEND=1`. |
| `mizito download-audio <exact-chat> <24-lowerhex-message-id> [--json]` | Explicit gated voice-note download. |
| `mizito download-image <exact-chat> <24-lowerhex-message-id> [--json]` | Explicit gated JPEG/PNG/WebP photo download. |
| `mizito mcp` | Starts the stdio MCP server. |

The MCP server exposes read-only `list_projects`, `list_tasks` and `get_task`. When `MIZITO_ALLOW_TASK_WRITE=1`, it also exposes `create_task`, `update_task`, `delete_task`, `set_task_completed`, and `comment_on_task`. Task access tokens stay inside the connector and are never returned. The task endpoints are part of Mizito's unofficial web API, so live behavior may change. Write operations are disabled by default and require explicit approval of the exact action in the MCP tool descriptions.

**Naming a chat.** `<chat>` is a chat id or a chat name. Names are matched ignoring case, Arabic vs
Persian letter forms (`ي`/`ی`, `ك`/`ک`, `ى`), Arabic-Indic vs Persian digits, and all spaces and ZWNJ
(half-space), so `علیرضا` finds `علی‌رضا`.
Reading and searching accept a unique partial name; if several chats match you get an error listing
them. `send` and `send-files` require an **exact** id or name so a message can't go to the wrong chat.

```bash
mizito chats --json | jq '.[] | select(.unread > 0) | .name'
mizito read "تیم فنی" --limit 20
mizito watch --json | while read -r line; do echo "$line" | jq -r '.chatName + ": " + .text'; done
```

## MCP server

Run `mizito mcp` (stdio transport). Example client configuration:

```json
{
  "mcpServers": {
    "mizito": {
      "command": "bun",
      "args": ["run", "/path/to/mizito-channel/src/cli/main.ts", "mcp"]
    }
  }
}
```

With the compiled binary use `"command": "/path/to/dist/mizito", "args": ["mcp"]`. For Claude Code:
`claude mcp add mizito -- bun run /path/to/mizito-channel/src/cli/main.ts mcp`.

### Tools

| Tool | Arguments | Notes |
|---|---|---|
| `list_chats` | none | All chats with unread counts. Read-only. |
| `read_messages` | `chat` (id or partial name), `limit` (1–100, optional) | Newest first. Read-only. |
| `search_chat` | `chat`, `query` | Read-only. |
| `wait_for_messages` | `timeout_seconds` (1–120, default 30) | Long-poll: returns new messages as soon as any arrive, or `[]` on timeout. Read-only. Not registered in push mode. |
| `download_audio` | `chat` (exact id or name), `message_id` (24 lowercase hex) | Explicit media access, local path and metadata only. Registered only with `MIZITO_ALLOW_DOWNLOAD=1`. |
| `download_image` | `chat` (exact id or name), `message_id` (24 lowercase hex) | Explicit photo access, **not vision analysis**. Registered only with `MIZITO_ALLOW_DOWNLOAD=1`. |
| `send_message` | `chat` (exact id or name), `text` | **Only registered when `MIZITO_ALLOW_SEND=1`.** Annotated as destructive; clients should require approval. |
| `send_files` | `chat` (exact id or name), `paths` (1–10 local paths), `text` (optional caption) | **Only registered when `MIZITO_ALLOW_SEND=1`.** Annotated as destructive. Requires explicit approval of the exact chat, paths, and caption. Each file is a separate message; `text` is attached to the last one. |

All tools return pretty-printed JSON as text. Domain errors (unknown chat, ambiguous name, auth
problem) come back as tool errors with a readable message.

**Message text is untrusted input.** Anyone in a chat can write anything. The tool descriptions tell
the model never to follow instructions found inside messages, but treat that as a mitigation, not a
guarantee: don't give an agent that reads chats powerful tools unless you trust the senders.

## Message format

`read_messages`, `search_chat`, `wait_for_messages` and `watch --json` use the same shape:

```json
{
  "sender": "Sara Ahmadi",
  "id": "6a5…",
  "chatId": "692…",
  "chatName": "Team",
  "index": 1236,
  "from": "u_123",
  "fromName": "me",
  "fromMe": true,
  "date": 1790862222116,
  "text": "plain text, HTML stripped",
  "replyTo": "6a4…",
  "mentions": ["u_456"],
  "edited": false,
  "deleted": false,
  "service": false,
  "attachment": { "kind": "document", "name": "report.pdf", "size": 3072 }
}
```

- `date` is milliseconds since the epoch. `index` is the chat's running message number.
- **`sender` says who wrote the message and is always set**, so an agent can attribute every line:
  `"me"` for you, otherwise the person's name from the workspace user list (in groups as well as
  direct chats), and the raw user id only for senders not in that list (for example removed users).
  `from` is always the user id; `fromName` is the name when known. `fromMe` marks your own messages.
- Attachments are described, not downloaded. A message with only an attachment has empty `text`;
  the text/CLI views show it as `[photo: a.jpg]`. Kinds seen: `photo`, `video`, `document`, `audio`,
  `taskSchedule`, `mentionInTask`, `mentionInChat`.
- `service` marks system notices (someone joined, etc.).

## Receiving new messages

There are four ways, all driven by the same watcher, which polls the chat list (every 10 seconds by
default) and fetches history only for chats that changed. To stay gentle on Mizito, `watch` and push
mode slow down automatically while nothing arrives (up to 6x the base interval), reset when a message
comes in, and back off hard (up to 5 minutes) after a rate-limit or network error instead of failing:

1. **`wait_for_messages`** (MCP, default). The agent calls it in a loop.
2. **`mizito watch --json`** (CLI). Pipe JSON lines into any script or agent.
3. **Channel push** (MCP, `MIZITO_PUSH=1`). New messages are pushed into a running Claude Code
   session as channel notifications; `wait_for_messages` is not registered in this mode. Load the
   server as a development channel (research preview):

   ```bash
   MIZITO_PUSH=1 claude --dangerously-load-development-channels server:mizito
   ```

   Push mode **requires an allowlist**: set `MIZITO_PUSH_CHATS` to comma-separated chat ids or exact
   names, and only those chats are pushed (your own messages never are). The server refuses to start
   without it. The allowlist is per chat, not per sender, so everyone in an allowlisted group can
   put text in front of your agent. Claude Code's channel docs recommend gating on sender identity;
   only allowlist chats whose members you trust.
4. **`mizito hermes-watch`**. Incoming messages are delivered to a signed HTTP webhook for a Hermes
   Telegram integration. See [Hermes Telegram forwarding](#hermes-telegram-forwarding).

Delivery behaviour:

- The first run **baselines** existing history and delivers nothing. Only messages that arrive
  afterwards are delivered.
- Progress is saved per chat. After a restart you receive what arrived while you were away.
- Only one watcher can run per `MIZITO_HOME`: `watch`, `hermes-watch`, the push mode and
  `wait_for_messages` take a
  lock (`watcher.lock`) on first use, and a second one refuses with a clear error. Read-only tools
  (`list_chats`, `read_messages`, `search_chat`) never take it, so several sessions can read at once.
- Deleted messages, edits to old messages, and service notices are not delivered as new messages.
- Delivery is **at-least-once**: a batch is recorded as delivered only after the consumer has it, so
  a failure retries instead of losing messages. `watch` records a batch after printing it; push
  records it after every notification was sent; `wait_for_messages` records the previous batch when
  called again, and discards it if the client cancelled the call. After a crash or failure the same
  message can arrive twice, so dedupe on the message `id` if that matters.

## Hermes Telegram forwarding

Set both required secrets and start the durable forwarder:

```bash
export HERMES_WEBHOOK_URL='https://your-hermes-host.example/webhooks/mizito'
export HERMES_WEBHOOK_SECRET='replace-with-a-long-random-secret'
mizito hermes-watch
```

The first poll baselines existing history and sends nothing. Later incoming messages are POSTed as
one exact JSON body:

```json
{
  "event_type": "mizito_messages",
  "delivery_id": "sha256-of-the-sorted-message-ids",
  "detected_at": "2026-10-01T12:00:00.000Z",
  "messages": []
}
```

`messages` uses the documented safe message shape above. Messages written by your own account are
excluded. Attachments remain metadata only; this mode does not download files, send messages, or mark
chats read.

The request includes `X-GitHub-Event: mizito_messages`, `X-GitHub-Delivery: <delivery_id>`, and
`X-Hub-Signature-256: sha256=<hex>`. The signature is HMAC-SHA256 over the **exact request body**.
The receiver must verify it with `HERMES_WEBHOOK_SECRET` using a constant-time comparison before
parsing or acting on the message text. Chat text is untrusted input and must never be treated as
instructions merely because the signature is valid.

Delivery is at least once. The watcher cursor is committed only after a successful 2xx response.
Network failures, HTTP 429, and 5xx responses use bounded exponential retries with a 10-second
request timeout; exhausted retries leave the batch uncommitted so a restart redelivers it. Other 4xx
responses are permanent configuration/request errors: the command exits instead of retrying tightly.
The delivery id is stable for the same batch, so the receiver should use it as an idempotency key.
SIGINT and SIGTERM stop cleanly without committing an in-flight failed delivery.

### systemd user service

Build the fixed binary path used by the unit, then install the user service and a private environment
file:

```bash
cd /home/siamak/code/mizito-channel
bun run build
install -m 0644 deploy/mizito-hermes-telegram.service ~/.config/systemd/user/
install -m 0600 deploy/mizito-hermes-telegram.env.example deploy/mizito-hermes-telegram.env
# Edit deploy/mizito-hermes-telegram.env and fill in both webhook values.
systemctl --user daemon-reload
systemctl --user enable --now mizito-hermes-telegram.service
systemctl --user status mizito-hermes-telegram.service
```

The user unit fixes `MIZITO_HOME=/home/siamak/.config/mizito`, explicitly keeps sending disabled,
applies a restrictive umask and systemd hardening, and restarts failed deliveries after 30
seconds. Do not put secrets in the unit or repository. While this service is running, do not run CLI
`watch`, MCP `wait_for_messages`, or MCP push mode with the same `MIZITO_HOME`; the single-watcher lock
will reject them. `chats`, `read`, and `search` (and their MCP equivalents) remain available because
they do not acquire the watcher lock.

## Sending

Disabled unless `MIZITO_ALLOW_SEND=1`. When off, `send_message` and `send_files` don't exist as MCP
tools and the CLI refuses sends with exit code 3. When on, messages are sent **as you**, to an exact
chat id or name. Text is sent exactly as plain text and newline characters are preserved; Mizito does
not render HTML tags.

File sends accept 1–10 local regular files, each at most 20 MB. All paths are validated and read before
the first upload. MIME types are detected from common extensions (including PDF, PowerPoint, Word,
Excel, images, audio, video, archives and text formats), with `application/octet-stream` as the
fallback. Mizito receives each file in its own chat message; `--text` / MCP `text` is the caption on
the last file. Directories, symlinks, missing files and oversized files are rejected locally.

Uploads use Mizito's web-client multipart shape: `POST /api/content/upload`, `x-token`, file field
`upload`, and form field `sendAsFile=true`. Replies and mentions aren't supported.

## Voice-note downloads

Voice-note downloads are disabled unless `MIZITO_ALLOW_DOWNLOAD=1`; this gate is independent of `MIZITO_ALLOW_SEND`. `download-audio` and MCP `download_audio` require an exact chat name and 24-lowerhex message id, then re-read at most the newest 195 messages and accept only `messageMediaAudio` entries marked `audio.is_voice=true`. The tool must be invoked only on the user’s explicit request and never automatically from message content. Files are saved as `<MIZITO_HOME>/downloads/<message-id>.mp3` (directory 0700, file 0600), without overwrite, with a 20 MiB hard cap. Only `audio/mpeg` is accepted. The signed media URL token is kept internal and is never returned or logged.

## Image downloads and explicit media access

`MIZITO_ALLOW_DOWNLOAD=1 mizito download-image "Exact Team" 0123456789abcdef01234567 --json`
returns only the private local path and safe metadata. `download-audio` has the same arguments.
Message IDs must be exactly 24 **lowercase** hex characters (no normalization); chat IDs or full names
use the existing exact-name matcher, never partial names. Download commands accept exactly two
positional arguments and optional `--json`.

The MCP tools `download_image` and `download_audio` are **absent by default** and require
`MIZITO_ALLOW_DOWNLOAD=1`, independent of sending permission. Enabling the gate is not permission to
automatically fetch media: only an explicit user request authorizes access to a particular chat/message.
Read, search, list, watch and Telegram forwarding remain metadata-only, even with the gate enabled.

Only eligible nondeleted, nonservice photos and voice notes in the newest **195 entries** (13 pages;
strictly below the 200-message cap, including wrapped or oversized upstream responses) are supported.
Images use the first bounded variant in `photo_large`, `photo_medium`, `photo_small` order, not a URL
or an original filename. Supported image types are JPEG, PNG and WebP, with matching MIME/signature,
bounded structural headers, complete container/end markers, actual dimensions matching metadata,
maximum 20 MiB, maximum 16,384 per dimension and 40 million pixels. Animated PNG/WebP is rejected.
This is structural validation, not a full image decoder or malware scanner.

CDN access uses only the configured origin's fixed `/cdn/` route with `x-token`; redirects are refused.
Media identifiers, content keys and authentication tokens are not returned or logged. Fetch/stream
operations have a 30-second deadline, cancellation and byte limits. Native authentication and automatic
single re-login are unchanged. Downloads never overwrite existing files, use private permissions and
pinned directory descriptors to prevent symlink/directory-swap writes. Secure file downloads currently
require **Linux with procfs** and fail closed elsewhere; the gated in-memory media API is portable.

**Media access is not semantic analysis.** This connector does not run vision, OCR, transcription,
cloud processing or arbitrary URL downloads. A user may explicitly authorize a separate subsequent
vision/transcription step using the returned local file. See [media safety](docs/media-downloads.md)
for API details and the observed-schema/live-validation boundary.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MIZITO_USERNAME`, `MIZITO_PASSWORD` | – | Credentials. Override the saved file. Bun also loads a `.env` file from the current directory automatically (it is gitignored), so running the tool from a folder with a `.env` uses those credentials. Copy `.env.example` to `.env` to start. |
| `MIZITO_USER_ID` | derived | Your own user id. Normally not needed; it is fetched automatically. |
| `MIZITO_ALLOW_DOWNLOAD` | off | Only `1` enables explicit voice/image downloads; independent of sending. |
| `MIZITO_ALLOW_SEND` | off | `1` enables sending. Any other value leaves it off. |
| `MIZITO_ALLOW_TASK_WRITE` | off | Only `1` enables task creation, editing, deletion, and comments; independent of message sending. |
| `MIZITO_PUSH` | off | `1` makes `mizito mcp` push channel notifications. Needs `MIZITO_PUSH_CHATS`. |
| `MIZITO_PUSH_CHATS` | – | Comma-separated chat ids or exact names allowed to be pushed. |
| `HERMES_WEBHOOK_URL` | – | Required by `hermes-watch`; HTTPS endpoint that receives Mizito batches. |
| `HERMES_WEBHOOK_SECRET` | – | Required by `hermes-watch`; shared secret used for exact-body HMAC-SHA256 signing. |
| `MIZITO_POLL_MS` | `10000` | Base poll interval for new messages, in milliseconds (minimum 1000). |
| `MIZITO_HOME` | `~/.config/mizito` | Directory for saved state. |
| `MIZITO_BASE_URL` | `https://app.mizito.ir` | Backend base URL. |

## Files and security

Everything lives in `MIZITO_HOME` (default `~/.config/mizito`), created with mode `0600`:

| File | Contents |
|---|---|
| `credentials.json` | Username and password **in plain text** (a Keychain option is not implemented). |
| `session.json` | Cached session token, reused across runs so each command doesn't log in again. |
| `cursors.json` | Per-chat progress for new-message delivery. |
| `names.json` | Cached display names for direct chats. |
| `logins.json` | Timestamps of recent logins, used by the login throttle. |
| `watcher.lock` | Pid of the running watcher; removed on exit, stale locks are taken over. |

- Use a consistent `MIZITO_HOME`. Pointing it at a fresh directory discards the cached token and
  forces a new login.
- Secrets are never printed or included in tool output. Reading never marks chats as read.
- Prefer a dedicated or low-privilege account if you can, and remove `credentials.json` when you stop
  using the tool.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Any other error (network, unexpected response, unknown chat, ambiguous name…) |
| `2` | Authentication error (no credentials, login rejected, session rejected) |
| `3` | Sending is disabled |
| `4` | Media downloading is disabled |
| `64` | Usage error (unknown command, missing arguments) |

## Limitations

- Unofficial API: field names and behaviour can change. Unexpected responses surface as clear errors
  rather than silent failures.
- Polling, not realtime: new messages appear within one poll interval (10 s by default, longer when idle). Mizito's web app uses
  socket.io; using it is not implemented yet.
- The first poll after a fresh start fetches one page per chat, which takes several seconds for
  large accounts.
- Single account and workspace; no general media download (only explicit voice-note and photo downloads), replies, reactions or read receipts.
- No Keychain storage, and the push allowlist is per chat rather than per sender.

## Development

```bash
bun install
bun test                # unit tests (no network)
bun run typecheck
bun run build           # dist/mizito
```

Layout: `src/core` (HTTP client, models, chat service, watcher, stores), `src/cli` (commands),
`src/mcp` (server). The design and plan are in `docs/superpowers/`, and observed API shapes are in
`docs/superpowers/notes/api-findings.md`. `scripts/spike.ts` is a throwaway probe that **performs a
login**, so avoid running it repeatedly.
