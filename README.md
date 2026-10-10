# cc-glm-web-search

<p align="center">
  <b>Turn your existing Z.AI (GLM) plan quota into Claude Code's web search and web reader.</b><br>
  One email login — no API key, no separate billing.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success.svg" alt="Dependencies"></a>
</p>

> 中文说明：[README-CN.md](README-CN.md)

## Why this exists

Claude Code's built-in `WebSearch` and `WebFetch` go through Anthropic's own backend. Many people
already hold Z.AI plan quota that natively runs `web_search_prime` and `webReader` — that quota
just was never wired into Claude Code.

That is what this mod does: **one email login turns your subscription quota into Claude Code's
search and reader.** It installs and works; the tools the model sees are new, and the service
behind them is Z.AI.

## Features

| Capability | What it does |
|---|---|
| **Web search** | `glm_web_search`, backed by Z.AI's `web_search_prime` server tool |
| **Web reader** | `glm_web_fetch`, backed by Z.AI's `webReader` server tool |
| **Vision** | `glm_vision` — ⚠️ see the note below: the ZCode plan gateway does not accept image input |
| **Zero dependencies** | No `node_modules`, no build step, install and run |
| **Status view** | `/glm-status` draws the token, plan, quota bars and refill cycle, live |

> ⚠️ **What the vision tool actually does.** The ZCode plan gateway (`zcode.z.ai`) refuses image
> input: every picture comes back as `1210 图片输入格式/解析错误`. Measured with a 69-byte 1×1 PNG,
> a 13 KB logo over a public URL, and the same logo over base64 — all three refused, while search
> and reading pass on the same credential. `glm_vision` stays registered and says so plainly when
> called; real image understanding needs a Z.AI open-platform API key against `api.z.ai`, which
> this mod does not use.

## Install

From a terminal session:

```text
/plugin install cc-glm-web-search --marketplace czpGhost/cc-glm-web-search
```

Then sign in once inside the session:

```text
/glm login
```

The browser opens the authorization page; approving it stores the token by itself. From then on
`glm_web_search` and `glm_web_fetch` are ready to use.

While developing from a folder, run it directly:

```bash
claude --plugin-dir /absolute/path/to/cc-glm-web-search
```

## Usage

```text
/glm login     # sign in (opens the browser, stores the token on approval)
/glm logout    # sign out, forget the local credential
/glm status    # token, plan and quota

/glm-login   /glm-logout   /glm-status      # equivalent aliases
```

Each action is also registered under its own name, because the command menu matches by name —
typing `/glm-log` offers both `login` and `logout`.

`/glm-status` prints a **live** row: the quota view redraws once a second, so the reset countdown
ticks. `/glm login` shows a spinner and the authorization window counting down until the browser
approves. Neither touches Claude Code's own status bar — the drawing stays in the transcript.

## Screenshot

`/glm-status`:

```text
  ▸ token 30m · Start Plan · GLM-5.3 2.95M left · resets 2h 57m

      account  you@example.com
               token valid 30m

      plan     ZCode Start Plan [active] · ends 10-12 23:59 (3d 2h)
      quota    GLM-5.3        ██████████  98%  2.95M/3M   resets 2h 57m
      quota    GLM-5.3-Flash  ██████████ full      resets 2h 57m
      cycle    daily grant, refills at 00:00 Asia/Shanghai
```

The bars draw what is **left**. If they drew what was used, a brand-new account would show an
empty bar — exactly backwards.

## Configuration

| Field | Default | Purpose |
|---|---|---|
| `origin` | `https://zcode.z.ai` | The gateway origin |
| `model` | *(empty, resolved live)* | The model that runs the search/reader tools |
| `jwtEnv` | `ZAI_JWT` | The environment variable read for a direct token |
| `vision` | `true` | Whether `glm_vision` is registered |

Credentials resolve in order: `ZAI_JWT` → the token file. Delete the file or run `/glm logout` to
revoke on this machine.

## Two things to know

**Search has an upstream cap.** One `web_search_prime` call returns at most 10 sources.

**There is no dependency tree at all.** `hooks/` reaches Claude Code only through the injected
`$` interface (`$.fs`, `$.http`, `$.clock`, `$.process`) and references nothing outside its own
folder besides the module environment's own web APIs. So there is no `node_modules`, no
`dependencies`, no `peerDependencies` — and nothing to keep in step when the engine updates.

## Development

```bash
claude plugin validate /path/to/cc-glm-web-search
claude plugin test /path/to/cc-glm-web-search
```

`claude plugin validate` reads the manifest and the hooks module's source the way the engine will
and reports what the module hooks and calls. `claude plugin test` runs the `tests/*.test.ts` files
against the engine itself: the protocol decoding, the authorize-URL check, the token store's
resolution order, the quota view's formatting and the commands' behaviour with no credential.

## FAQ

**Do I need a paid plan?**
No. The free tier that comes with a new account already runs search, reader and the Flash vision
model.

**Where is the credential stored?**
`~/.claude/cc-glm-web-search/token.json` — a single file, no environment variable required. Delete
it or run `/glm logout` to revoke.

**Does it work on a headless host?**
Yes. Set `ZAI_JWT` to a token and the tools run with no browser; only the live status line and the
toasts need a terminal.

**What if Z.AI changes its client?**
The gateway checks a client fingerprint. A new ZCode release may need the identity constants in
`hooks/zai.ts` re-captured. That is a one-line change, not a rewrite.

**Does `glm_vision` work?**
No — not on this gateway. `zcode.z.ai` declines image input whatever the picture (code 1210). The
tool stays registered so the model gets an honest answer rather than silence. See the note at the
top; real vision needs an `api.z.ai` open-platform key.

**`glm_vision` times out?**
It used to, before the request stopped asking for a reasoning pass: the host allows one HTTP
request 30 seconds, and thinking over an image overran that. The request now runs with thinking
off.

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=czpGhost/cc-glm-web-search&type=timeline&legend=top-left)](https://www.star-history.com/?repos=czpGhost%2Fcc-glm-web-search&type=timeline&legend=top-left)

## Disclaimer

For technical exchange and learning only. Comply with the terms of service of the platforms
involved and with your local laws; use at your own risk.

## License

[MIT](LICENSE)
