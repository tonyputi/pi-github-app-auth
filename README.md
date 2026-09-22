# pi-github-app-auth

A [Pi](https://pi.dev) extension that authenticates **commands executed by the Pi agent** to GitHub as a **GitHub App installation** — while leaving your personal GitHub credentials completely untouched.

Keywords: coding agent GitHub authentication, GitHub App installation token, git push as GitHub App, gh CLI as GitHub App, agent identity separation, least-privilege GitHub access for AI agents.

## The problem

Coding agents like Pi execute `git` and `gh` commands through a shell that inherits everything your personal environment offers: SSH keys in `~/.ssh`, credential helpers (macOS Keychain, `~/.git-credentials`, `gh auth`), and tokens exported by your shell profile or direnv (e.g. `GH_TOKEN`, `GITHUB_TOKEN`). As a result, every GitHub operation an agent performs is attributed to **you**, the human:

- `git push`, `gh pr create`, issue comments, and workflow runs happen under your personal account even when the work belongs to an automation identity.
- Over SSH, git silently uses your default personal key (`id_ed25519` or whatever `~/.ssh/config` selects), including multi-account alias hosts that map to `github.com`.
- Personal credential helpers are not only consulted for authentication — after a successful agent authentication they can also **store** the agent's token permanently into `~/.git-credentials` or the keychain.
- Long-lived personal tokens (`ghp_…`) exported as `GH_TOKEN`/`GITHUB_TOKEN` leak into every subprocess the agent spawns, including build tools that forward the environment.
- Common workarounds each have real drawbacks: `gh auth login` mutates global gh state; `git config credential.helper` edits are persistent and repository-wide; tokens embedded in remote URLs leak through `git remote -v` and shell history; personal fine-grained PATs are still long-lived secrets.

In short: without deliberate isolation, an AI coding agent shares one GitHub identity with its human, with persistent credential storage in the blast radius.

## The solution

`pi-github-app-auth` gives the Pi agent its own GitHub identity — a **GitHub App installation** — and nothing else:

By default, `git` and `gh` commands run by a coding agent use whatever credentials are ambient in your shell: personal tokens, keychain helpers, SSH keys. That makes it easy to accidentally open a PR, push a branch, or comment as *you* instead of as the machine identity you meant to use — or to let a helper silently persist an agent token into `~/.git-credentials`.

This extension draws a hard line:

| Context | GitHub identity |
| --- | --- |
| Pi agent `bash` tool | GitHub App installation (short-lived token) |
| Your normal terminal | your existing personal credentials |
| Pi manual shell (`!` / `!!`) | your existing personal environment |

GitHub App installation tokens are short-lived (one hour), scoped to the repositories and permissions granted to the installation, fully revocable, and visible in the GitHub audit log as the App — not as you. That is the principle of least privilege for agent GitHub access.

The extension only provides authentication and isolation. It does not create PRs, manage issues, or wrap `gh` — your normal `git` and `gh` commands simply run as the App when the agent executes them.

## Installation

```bash
pi install git:github.com/tonyputi/pi-github-app-auth
```

or from a local checkout:

```bash
pi install /absolute/path/to/pi-github-app-auth
```

Requires no npm dependencies — only Node built-ins (`crypto`, `fetch`) and the Pi extension API.

## Configuration

Three environment variables (typically via direnv):

| Variable | Meaning |
| --- | --- |
| `PI_GITHUB_APP_CLIENT_ID` | GitHub App client id (App settings → General → About) |
| `PI_GITHUB_APP_INSTALLATION_ID` | Installation id (the number in the installation URL) |
| `PI_GITHUB_APP_PRIVATE_KEY` | The App's PEM private key |

Example `.envrc` (placeholder values only):

```bash
export PI_GITHUB_APP_CLIENT_ID="Iv1xxxxxxxxxxxxxxxx"
export PI_GITHUB_APP_INSTALLATION_ID="12345678"
export PI_GITHUB_APP_PRIVATE_KEY="$(cat ~/secrets/my-github-app.pem)"
```

Real newlines in the PEM work as-is; escaped `\n` sequences are tolerated too.

### GitHub App prerequisites

- A GitHub App owned by you/your org with a generated private key.
- The App **installed** on the account/org/repositories you want the agent to reach.
- Repository permissions for what the agent should do — for typical agent work: **Contents: Read & write** (clone/push), **Pull requests: Read & write**, **Issues: Read & write**, **Metadata: Read-only** (mandatory), plus **Workflows: Read & write** if the agent touches GitHub Actions. No webhook URL is needed.

## How it works

The extension overrides Pi's built-in `bash` tool and adjusts the environment of every command the agent spawns:

- `GH_TOKEN=<installation token>` — `gh` authenticates as the App installation.
- Ephemeral git config (process environment only, equivalent to `git -c`, nothing persisted):
  - `credential.helper` is **reset**, so personal helpers (macOS keychain, `store`, `gh auth git-credential`) are never consulted — and never *write* the installation token into `~/.git-credentials`.
  - A `credential.https://github.com.helper` shim answers `username=x-access-token` / `password=$GH_TOKEN`, reading the token from the environment at auth time.
  - `url.https://github.com/.insteadOf` rules translate GitHub SSH remotes to HTTPS **inside agent commands only**.
  - `GIT_TERMINAL_PROMPT=0` so git can never fall back to interactive personal credentials.
  - A `GIT_SSH_COMMAND` guard makes any GitHub-bound `ssh` invocation fail loudly instead of silently using a personal SSH key — including rewrites it cannot foresee.
  - Countersink `insteadOf` rules (generated at load from your global git config) so personal URL rewrites cannot drag GitHub URLs back onto personal SSH aliases.
- `PI_GITHUB_APP_*` variables are **stripped** from the child environment: an agent command like `env` never sees the private key. Only the short-lived installation token is visible to the processes that need it.
- Personal `GITHUB_TOKEN` inherited from your shell is removed in agent shells so nothing silently falls back to it.

## Token lifecycle

1. A GitHub App JWT is signed **in memory** with RS256 (`iss` = client id, 9-minute expiry).
2. It is exchanged for an installation token via `POST /app/installations/{id}/access_tokens`.
3. The token is cached **in memory only** — never written to disk, logs, or error messages.
4. A background timer refreshes it **5 minutes before** GitHub's `expires_at` (retrying every 30 s on failure).

If the token is momentarily unavailable, `GH_TOKEN` is given a sentinel value and git/gh fail with a clear error instead of silently using your personal credentials.

## HTTPS and SSH remotes

All three common remote forms are handled transparently inside agent commands, without rewriting `git remote -v` or any repository config:

```
git@github.com:owner/repo.git      -> https://github.com/owner/repo.git
ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo.git
https://github.com/owner/repo.git   -> (unchanged, App credential helper)
```

SSH host aliases that resolve to `github.com` in `~/.ssh/config` (including `Include`d files, e.g. `work.github.com`) are covered as well. Commits keep your configured author identity — authentication and authorship are separate concerns.

## Security notes

- The private key, JWTs, and installation tokens are never written to disk, logs, or error messages.
- Nothing in your persistent configuration is modified: `~/.gitconfig`, repository `.git/config`, `gh auth`, keychain, and SSH config stay exactly as they are. All changes are per-process environment.
- Packages run with full system access — review third-party extension source before installing.

## Troubleshooting

Run `/pi-github-app-status` inside Pi (no secrets are shown).

- **`incomplete configuration — missing …`** — one of the three `PI_GITHUB_APP_*` variables is unset or empty. With direnv, `direnv allow` and restart Pi.
- **`GitHub rejected the App JWT (HTTP 401)`** — wrong client id, wrong/stale private key, or system clock skew beyond ~1 minute.
- **`installation … not authorized or not found (HTTP 403/404)`** — the App is not installed on the target account/org, the installation id is wrong, or the App lacks the required permissions.
- **`GitHub SSH access is blocked in agent shells`** — a remote (or a personal git `insteadOf` rule) pointed at GitHub over SSH in a form the extension could not translate; use an HTTPS remote or check your global `url.*.insteadOf` rules.
- **`pi-github-app-unavailable` appearing as a token error** — the installation token could not be fetched (network/API outage); the extension retries every 30 s and personal credentials are never used as a fallback.

## License

MIT
