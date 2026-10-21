# dsh-im-bridge

[中文](README.md) | [English](README.en.md)

**Keep going, from Feishu, in the session that is already running on your desktop.**

Not a second agent. Not copy-pasting messages back and forth. It is the same conversation, the same
context, the same working files. Send a line from your phone and the desktop picks it up; change your
mind mid-task and it changes course immediately.

---

## Why use it

### The same session, not a new agent

This is the fundamental difference from "forward the message to another AI": there you re-explain the
background, wait for it to re-read your files, rebuild context from scratch. Here it continues the
session that is open on your desktop — history, opened files, tool approvals, model selection.

### No public IP

The plugin dials out to Feishu over a long connection from your machine. It opens no port, needs no
tunnel, no domain, no certificate, and exposes no address to the internet. Inbound firewall rules
stay closed.

### Change course mid-task

Most bots can only take the next message after the current turn finishes. This one puts your message
**into the turn that is already running**:

```
you: run these three steps, 30 seconds each
it:  (step 1 running)
you: skip step 3, just give me the conclusion
it:  (finishes step 2, stops, answers)
```

That is only possible because the injection happens inside the DSH process.

### Artifacts come back to you

Images, video, audio, documents — the agent sends them with one call, and scripts can too:

```bash
dsh-feishu-send-file --file script.md
dsh-feishu-send-file --file cut.mp4 --cover poster.jpg
```

### Ask for progress instead of guessing

Send `?status`:

```
- running: yes
- last turn: `590`
- background jobs (2):
  - `pwsh` python render.py --batch 3 — running 12m40s
- subagents (1):
  - research callback mechanism — running 3m12s
- queued: 1 message (waiting for the turn to end)
```

### Do not interrupt — queue instead

Start a line with `#` and it waits for the running turn instead of interrupting it. Without `#`, it
goes in immediately.

### No second process

It is a DSH plugin and lives inside DSH. No daemon, no startup task, no separate login.

---

## Install

### 1. Install the plugin

DSH sidebar → **Plugins** → **Installed** → **Install**, then enter:

```
github:danleivv/dsh-im-bridge
```

Confirm the trust prompt and restart DSH when asked.

### 2. Get Feishu app credentials

```bash
dsh-feishu-setup
```

It prints a link; confirm it in the Feishu mobile app and the credentials are written locally —
never through a chat message, never as a command-line argument.

> If your organization does not allow that flow, create a custom app in the Feishu developer console
> and run `dsh-feishu-setup-manual` to enter the credentials with hidden input. Both paths end in the
> same local file.

### 3. Restart DSH

Credentials are read at plugin startup, so restart once.

### 4. Send something in Feishu

The first message makes the plugin log the mapping to add to your config (see below).

---

## What it looks like in use

| You send | What happens |
|---|---|
| `run today's render` | a turn starts, the reply arrives as a card |
| another line while it runs | **inserted into that turn**, acknowledged at once |
| `#summarise when this finishes` | queued; the running turn is left alone |
| `?status` | what is running, background jobs, subagents, queue length |
| `send me the artifacts` | the agent sends the files to the chat |

Replies arrive as cards, with bold text, tables and code blocks rendering properly.

---

## Configuration (once)

Both files live in `~/.dsh-im-bridge/`:

| File | Purpose | When it is read |
|---|---|---|
| `config.json` | allowed sessions, which chat maps to which session | on every request — edits apply immediately |
| `gateway.json` | credentials, switch, rendering and behaviour | at plugin startup — restart after editing |

### `config.json`

```json
{
  "allowSessions": ["session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"],
  "sessionKeys": {
    "feishu:oc_xxxxxxxxxxxx:ou_yyyyyyyyyyyy": "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

After the first message the plugin logs the exact line to add:

```
pin it with: "sessionKeys": { "feishu:oc_xxx:ou_yyy": "<session id>" }
```

`allowSessions` is an allowlist: **empty means nothing is allowed**, so it doubles as a kill switch.

### `gateway.json`

Usually you never touch it — credentials are written by `dsh-feishu-setup`, everything else defaults.
To change rendering, busy behaviour, prefixes or emoji names, see
[`gateway.json.example`](gateway.json.example).

To keep credentials in the environment instead of a file:

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## FAQ

**Does it work when the desktop app is closed?**
No. The plugin lives inside DSH; that is the price of sharing the same session.

**Can I see tool-level progress on the phone?**
No — you get final replies only.

**Can one Feishu app serve several sessions?**
No. One app is one long connection and one session; use one app per session.

**Can someone else drive my bot?**
The first sender is bound automatically as the only allowed user; everyone else is ignored.

**Where are the credentials?**
`~/.dsh-im-bridge/gateway.json`, readable only by your user account. Neither the repository nor the
published package contains credentials.

**Do I need to install anything else?**
No. The plugin talks to Feishu itself.

---

## Known limitations

- The desktop app must be running.
- The phone shows final replies only, not tool-level progress.
- Tool approval prompts appear on the desktop only; the phone will wait.
- One Feishu app accepts one long-connection consumer; two consumers split the events.
- One app maps to one session.
- Status reactions (received / working / done) fail in some environments; replies are unaffected.

---

## Development

Architecture, modules, contracts, tests: [docs/DEVELOPING.md](docs/DEVELOPING.md).

## License

MIT — see [LICENSE](LICENSE). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
