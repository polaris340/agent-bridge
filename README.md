# agent-bridge

> 📢 **Disclaimer**: This project was written with Claude (Anthropic's AI). It has been
> confirmed to work in real use, but **the code has not been reviewed by a human.**
> Read it yourself before running it, and use it at your own risk
> ([MIT License](LICENSE), no warranty).

A bridge that feeds chat messages into **CLI coding agents living in tmux**, then posts
the agent's answer back to the chat when the turn ends. Both the agents and the chat
connectors are pluggable.

```
Discord message
   └─► router ─┬─► [tmux: codex-my-game]         codex   (stays alive)
               ├─► [tmux: claude-my-app-5122]   claude
               └─► [tmux: claude-workspace-8801] claude
                        │
             completion detection (per adapter)
                        ▼
                 reply on Discord
```

Launching an agent, typing the prompt, and waiting for the turn to end is the same for
every agent. **Only how completion is detected** differs, and that is up to the adapter.

> ⚠️ **Security**: anyone allowed to talk to the bot can make an agent run commands on
> this machine with a single chat message. Always set `ALLOWED_USER_IDS` and list only
> people you trust. First-time setup steps are in
> [SETUP_FOR_CLAUDE.md](SETUP_FOR_CLAUDE.md) (Korean).

> ℹ️ The bot's chat messages, logs, code comments and the setup guide are currently in
> Korean.

## Supported agents

| Agent | Completion detection | Accuracy |
| --- | --- | --- |
| `codex` | `task_complete` in the rollout jsonl. The full answer is in the event | exact |
| `claude` | the session jsonl ends with `text` and then goes quiet | exact |
| `sonnet` | same as `claude` (Claude Code launched with `--model sonnet`) | exact |
| any other CLI | the screen goes quiet (`generic`) | approximate |

`sonnet` is a variant of `claude`: it shares the same tmux session name and conversation
history, so switching between them with `!agent claude` / `!agent sonnet` keeps the
conversation going and only changes the model.

If a route names an agent without an adapter, that name is run as an executable and
attached with `generic` — e.g. `opencode`, `aider`, `gemini`.

### Why not scrape the screen

codex records even TUI sessions to `$CODEX_HOME/sessions/**/rollout-*.jsonl`, and that
file contains a `task_complete` event whose `last_agent_message` holds the **entire**
final answer. Nothing has to be guessed — neither when the turn ended nor what was said.

claude has no such end event; every message up to the final one is logged with
`stop_reason:"tool_use"`. Instead, turn boundaries are read from the shape of the
session jsonl:

- **Turn start**: `type:"user"` with a string `message.content`
  (tool results have an array content, which separates them from human input)
- **Turn end**: the last assistant message produced `text`, no `tool_use` follows it,
  and the file stays quiet for `IDLE_MS`

**A turn that ends in `tool_use` is never treated as complete, no matter how long it is
quiet.** This prevents sending half an answer while a slow tool is still running.

The screen (`capture-pane`) is only used for `!pane`, failure diagnostics, and checking
whether the input box has appeared.

### Not mixing up other people's sessions

If someone runs an agent by hand in the same folder, the logs get mixed. claude piles up
dozens of session files per folder, so picking "the newest file" can read someone
else's conversation.

- **claude**: the bot picks a UUID, launches with `--session-id`, and reads only that file
- **codex**: there is no option to set a new session's id. The bot grabs the first
  session that started after it launched codex, remembers its `session_id`, and from
  then on reads only that session

Either way, the bot reads only the sessions it launched. Instance info is stored in
`.spool/`, so restarting just the bot keeps using the agents already running in tmux.

## Setup

### 1. Create a Discord bot

1. https://discord.com/developers/applications → **New Application**
2. **Bot** in the sidebar → **Reset Token** → copy the token (`DISCORD_TOKEN` in `.env`)
3. On the same page, **turn on MESSAGE CONTENT INTENT**. If it is off, message bodies
   arrive as empty strings and the bot never reacts
4. For a personal tool, turn **Public Bot** off. To do that, first set the install link
   on the Installation tab to `None`
5. **OAuth2 → URL Generator**: scope `bot`, permissions `View Channel`,
   `Send Messages`, `Send Messages in Threads`, `Read Message History`,
   `Attach Files`, `Add Reactions`. Invite the bot to your server with the generated URL

### 2. Configure

```sh
cp .env.example .env
$EDITOR .env          # DISCORD_TOKEN is required
npm install
npm run doctor        # checks executables, folders, tmux, and the log parsers
```

The bot refuses to start if any route has no allowed scope (channel, server, or user).
Whatever is typed in chat becomes an instruction to the agent, so keeping the scope
narrow is the real line of defense. Even when opening a whole server, fill in
`ALLOWED_USER_IDS`.

| Setting | Meaning |
| --- | --- |
| `ALLOWED_GUILD_IDS` | any channel in these servers can use the bot |
| `ALLOWED_CHANNEL_IDS` | these channels get their own route (a pinned session) |
| `ALLOWED_USER_IDS` | who may call the bot. Empty means everyone in the scopes above |
| `AGENT` / `AGENT_CWD` | agent and folder for the channels above |
| `NEW_SESSION_AGENT` / `NEW_SESSION_CWD` | agent and folder for every other channel/thread |
| `PROJECT_ROOTS` | roots of the folders selectable with `!project` (subfolders are registered automatically) |
| `REQUIRE_MENTION` | only react to messages that mention the bot (default on) |
| `STREAM_PROGRESS` | also post the agent's mid-turn commentary (default on) |
| `TURN_TIMEOUT_MS` | per-turn limit. `0` means unlimited (default) |
| `THREAD_IDLE_MS` | shut down tmux after this much quiet (default 30 min; `.env.example` uses 6 h) |
| `CLAUDE_REMOTE_CONTROL` | `true` also opens claude sessions to Remote Control (default off) |

To give each channel a completely different agent/folder, create `routes.json`
(see `routes.example.json`). If that file exists, the route settings above are ignored.

## Running

```sh
npm start                                          # run the bot
npm run doctor                                     # check the configuration
npm test                                           # run the tests
npm run selftest                                   # one round trip without a connector
npm run selftest -- --agent claude --cwd /path "hello"
```

You can look at the tmux sessions the agents run in directly.

```sh
tmux ls
tmux attach -t claude-my-app-5122     # detach with Ctrl-b d
```

### Restarting

```sh
tools/restart.sh          # stop and start again (warns about panes that are mid-turn)
tail -f agent-bridge.log  # log (change the location with AGENT_BRIDGE_LOG)
```

🔴 **On macOS, start it from a terminal.** If you auto-start it at login with launchd,
macOS blocks the resulting tmux panes from `~/Documents` (EPERM, refused without
asking). If your work folders live there, it won't work as is. To auto-start, grant
tmux Full Disk Access first.

**Run only one bot at a time.** Two bots push keys into the same tmux session: the
launch command gets typed twice on one shell line, and after that chat messages land in
the shell instead of the agent. `.spool/bot.lock` prevents this.

## Using it in a channel

Where allowed, **mention the bot** and the message goes to that channel's agent
(`@botname take a look at this file`). Messages without a mention are ignored, so the
bot stays out of conversations between people. Commands are called the same way:
`@botname !status`. DMs can't contain mentions, so just type.

```
[your message]  👀                  ← seen

> Checking the file layout first     ← mid-turn commentary (quoted)
> Three places need changes

Done. In router.js ...               ← final answer
✅                                  ← end of this turn
```

The 👀 is removed once the answer starts going out. On failure it is removed and a
one-line reason is posted.

**Files the agent wants to show you are uploaded to the channel.** For claude, files it
sends with SendUserFile; for codex, images made with its built-in image tool
(`generated_images`). Images, videos and audio whose paths appear in the answer are
uploaded too. Terminal CLIs have no way to send files to a chat, so the bot does it for
them.

Upload locations are kept narrow. Only files inside the work folder, `/tmp`, and the
agent's own image folder are uploaded, and symlinks are resolved to their real
location before checking. Even inside those, dotfiles (`.env` …) and anything under
folders like `.ssh`, `.git`, `.aws` are never uploaded. Agents can be fooled by
instructions hidden in documents they read, so "send this file" is not taken at face
value.

**You can attach files and images too.** They are saved to `.spool/files/` and the
path is passed along in the prompt; the agent reads them itself. A file with no text is
fine. Saved files are cleaned up after a day.

**You can keep sending while waiting for an answer.** Agents pick up input that arrives
mid-turn (steering), so nothing is held back. Messages folded into one turn get **one
reply** (attached to the last message), so the same answer isn't posted once per
message.

### Channels and threads

| Situation | What happens |
| --- | --- |
| any channel in an allowed server | each channel gets its own session |
| you open a thread | each thread gets its own session |
| a channel listed in `ALLOWED_CHANNEL_IDS` | uses that route's pinned session |

A channel or thread is usually one unit of work, so each gets its own agent. They don't
wait on each other and their context doesn't mix. To share one session, set
`"perChannel": false` or `"perThread": false` on the route.

tmux sessions are named `<agent>-<folder>-<last 4 digits of channel id>`
(`claude-my-app-5122`), so `tmux ls` alone tells you what is running where.

### Shut down when quiet, resume when called

After `THREAD_IDLE_MS` (default 30 min) of quiet, the tmux session is shut down.
Otherwise tmux sessions and agent processes would pile up with every channel you open.

**The conversation survives the shutdown.** The agent keeps its history in its own
folder and the bot records the session id. The next message resumes that conversation
(`claude --resume <id>` / `codex resume <id> --cd <folder>`). A fresh session is
started only if resuming fails.

History is discarded only when moving folders (`!project`) and on `!restart`.
Sessions that are mid-turn are never shut down, and pinned channel sessions are never
shut down automatically.

### Commands

| Command | What it does |
| --- | --- |
| `!help` | help |
| `!project` (`!cd`) | list available folders |
| `!project <name>` | move this channel to that folder. **Creates it if it doesn't exist** |
| `!agent` | current agent and the names you can pick |
| `!agent <name>` | switch agent. Only agents with an adapter (`codex` `claude` `sonnet`) and names configured in routes are accepted. claude ↔ sonnet keeps the conversation |
| `!status` | agent, folder, tmux, watched log, busy or not |
| `!agents` | every running session |
| `!pane` | last 40 lines of the screen |
| `!esc` (`!cancel`) | interrupt the current turn |
| `!restart` | start over. **Discards the conversation** |

Commands skip the queue and answer immediately, even mid-turn.

Folders for `!project` are registered by scanning `PROJECT_ROOTS`, and `PROJECTS` adds
more one by one. An unknown name is created under the first `PROJECT_ROOTS` root and
`git init`-ed. Names accept only letters, digits, `.`, `_` and `-`, to stop names from
escaping the root. A channel remembers the folder it picked, so the session comes back
in that folder after being shut down.

## Things to know

**Input silently fails in two places.** A TUI that just launched doesn't accept input
at all, and an Enter sent right after pasting gets swallowed. So the bot waits until the
input box is actually drawn, checks that the pasted text shows up on screen, and sends
Enter after `ENTER_DELAY_MS`. If the turn still doesn't start, it sends Enter once more.

**Agents ask whether to trust a folder the first time they open it.** Pushing a prompt
into that screen loses it entirely. The bot detects the screen, gets past it, and logs
that it did.

**Multi-line or long messages are passed as files.** Pasting newlines through tmux
makes the TUI treat them as Enter, chopping the instruction up. Such messages are
written to a file in `.spool/` and replaced with "read this file and do what it says".
These files are cleaned up after a day.

**Turns have no time limit** (`TURN_TIMEOUT_MS=0`). A limit only turns an agent that is
still working into a failure. Even with a limit, answers from work that finishes late
are still posted to the channel.

**If an executable isn't found on PATH, give its full path.** The shell the bot starts
may have a different PATH from your terminal. Some terminals (cmux, for example) make
`which codex` point to a temporary shim that soon disappears.

**Approval mode follows the agent's own settings.** The bot doesn't set a sandbox. If a
tool-approval prompt appears, the turn stops there, so put the flags you need in the
route's `command` (`"codex --yolo"`). If the path has spaces, use an array
(`["/My Tools/codex", "--yolo"]`).

**Restarting the bot doesn't stop the agents in tmux.** The new bot attaches to the
running panes, and answers that finished in between are posted as "finished late"
(`⌛ 늦게 끝났다`). Answers that finish in the few seconds the bot is down are missed;
check those with `!pane` or `tmux attach`.

### Limits of the generic adapter

TUIs without a log format are judged complete when the screen goes quiet.

- **Answers include screen debris.** Status lines (`Build · 1m 24s`, token counts and
  so on) contain text, so the decoration filter doesn't remove them
- **Detection is approximate.** If the agent pauses for a long time, that pause may be
  taken as completion

For an agent you use often, a dedicated adapter is better. `src/agents/codex.js` is an
example that reads logs to detect completion; `src/agents/generic.js` is the simplest,
screen-only example.

## Files

| File | Role |
| --- | --- |
| `src/index.js` | wiring. Passes connector messages to the router and handles commands |
| `src/routing.js` | pure function that only decides which session a message goes to |
| `src/routing.test.js` | routing rule tests |
| `src/router.js` | attaches channels/threads to sessions and shuts down quiet ones |
| `src/session.js` | one tmux session = one agent. Launch, inject, wait for the turn, resume |
| `src/tmux.js` | ensure sessions, send keys (with input check), capture panes |
| `src/lock.js` | keeps more than one bot from running |
| `src/images.js` | decides which files may be uploaded to the chat |
| `src/agents/` | how completion is detected (codex / claude / generic) |
| `src/connectors/` | where messages come from (Discord for now) |
| `src/watchers/jsonl-tail.js` | tails JSONL session logs (file switching, UTF-8 boundaries) |
| `src/config.js` | routes, projects, allowed scopes |
| `src/doctor.js` | checks settings, executables, tmux, and log parsers |
| `src/selftest.js` | one round trip without a connector |

## Adding a connector

This is the whole contract `src/connectors/discord.js` keeps.

```js
new Connector({ token, onMessage })
await connector.start()
await connector.send(channelId, text, files, { mention })   // to speak first
await connector.stop()

// what onMessage receives
// { channelId, parentId, guildId, mentioned, isDirect, attachments,
//   userId, userName, displayName, text,
//   reply(text, files, { ping, mention }), react, unreact }
```

Match this shape for Slack, Telegram or anything else, register it in
`src/connectors/index.js`, and the rest (routing, sessions, agents) works unchanged.

## License

[MIT](LICENSE)
