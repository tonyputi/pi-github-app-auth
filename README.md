# pi-github-app-auth

[![CI](https://github.com/tonyputi/pi-github-app-auth/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tonyputi/pi-github-app-auth/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-github-app-auth)](https://www.npmjs.com/package/pi-github-app-auth)
[![npm downloads](https://img.shields.io/npm/dm/pi-github-app-auth)](https://www.npmjs.com/package/pi-github-app-auth)
[![license](https://img.shields.io/github/license/tonyputi/pi-github-app-auth)](LICENSE)

**Your Pi agent should authenticate to GitHub as an App — not as you.**

Give [Pi](https://pi.dev) agent-executed `git` and `gh` commands a dedicated GitHub App identity, without changing personal credentials or persistent Git configuration.

- Separate agent and human GitHub identities
- Repository-scoped, short-lived installation tokens
- Transparent `git` / `gh` authentication in the agent's `bash` tool
- App-bot committer attribution, with your Git author identity preserved
- Guided setup inside Pi

## Quick start

Install the extension:

```sh
pi install npm:pi-github-app-auth
```

Start Pi, then run:

```text
/github-app-auth setup
/github-app-auth status
```

The setup wizard walks you through five steps:

1. Choose your personal account or organization.
2. Open the pre-filled GitHub App form in your browser and select **Create**.
3. Let the wizard exchange the App manifest for the client id and private key.
4. Install the App on the repositories you want the agent to access; the wizard detects the installation.
5. Save credentials to `<agent-dir>/pi-github-app-auth.json` with mode `0600`, then confirm the Pi reload.

Use `/github-app-auth status` any time to check configuration, token availability, and commit attribution without displaying secrets. Until setup succeeds, GitHub authentication in the protected agent shell is blocked rather than falling back to your personal account.

The callback server binds only to `127.0.0.1`. Wizard-generated private keys are written to the credential file, not exported into the environment.

## Why a separate GitHub App?

Without this extension, an agent shell inherits personal tokens, credential helpers, and SSH keys. A push, PR, or issue comment can therefore appear under your account; helpers can also persist an automation token in your keychain or `~/.git-credentials`.

| Context | GitHub identity |
| --- | --- |
| Pi agent `bash` tool | GitHub App installation, or blocked authentication if unavailable |
| Your normal terminal | Your existing personal credentials |
| Pi manual shell (`!` / `!!`) | Your existing personal environment |

Installation tokens normally expire after one hour and are limited to the repositories and permissions granted to the App. You can revoke the installation without changing personal credentials.

### Scope: authentication, not automation

The extension changes authentication for Pi's agent `bash` tool. It does not create PRs, manage issues, or wrap `gh`: your usual commands do the work.

This is **credential separation, not a sandbox**. Independent MCP servers, other extensions spawning processes, remote tools, and commands explicitly overriding credentials are outside this protection. See [Security model and limitations](#security-model-and-limitations).

## Alternate installation paths

From GitHub:

```sh
pi install git:github.com/tonyputi/pi-github-app-auth
```

From a local checkout:

```sh
pi install /absolute/path/to/pi-github-app-auth
```

The only runtime dependency is GitHub-maintained `@octokit/auth-app`; the rest uses Node built-ins and the Pi extension API.

Prefer manual setup? Register and install an App using the links below, then provide the [configuration](#configuration).

## GitHub App permissions

New to GitHub Apps? Follow the official guides: [register the App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [generate a private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), and [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the target account/org.

- A GitHub App owned by you/your org with a generated private key.
- The App **installed** on the account/org/repositories you want the agent to reach.
- Repository permissions for what the agent should do — for typical agent work: **Contents: Read & write** (clone/push), **Pull requests: Read & write**, **Issues: Read & write**, **Metadata: Read-only** (mandatory), plus **Workflows: Read & write** if the agent touches GitHub Actions. No webhook URL is needed.

## Commit attribution

Agent commands create commits with **your author identity** (the machine's `user.name` / `user.email`) but the **committer pinned to the App bot** — GitHub renders both, so on a shared-App team you can see at a glance who launched the agent and that the commit is machine-made:

```
authored by alice, committed by pi-agent-x1y2[bot]
```

- Zero configuration: the identity (App slug + bot user id) is resolved automatically via the GitHub API at setup and cached in the credential file; installs created before this feature resolve it lazily on first use.
- PRs created through the protected agent `bash` tool authenticate as the App. A human teammate — **including the person who launched the agent** — can review them and request changes, subject to repository rules (GitHub blocks self-review by the PR author).
- A bot committer on a commit does **not** prove that its PR was opened by the bot: commit attribution and PR authentication are separate.
- Agent commits are unsigned (`commit.gpgsign` off inside agent commands): signing machine work with a personal key would attach your verified badge to bot commits. Organizations that require signed commits should sign agent work deliberately.
- Known limits: rebasing rewrites the committer (attribution is strongest on the commits the agent originally created), and the author identity is per-machine — one human per machine, which is how Pi is normally run.

## How it works

The extension overrides Pi's built-in `bash` tool and adjusts the child environment of commands executed through that tool:

- `GH_TOKEN=<installation token>` — `gh` authenticates as the App installation.
- Ephemeral git config (process environment only, equivalent to `git -c`, nothing persisted):
  - `credential.helper` is **reset**, so personal helpers (macOS keychain, `store`, `gh auth git-credential`) are never consulted — and never *write* the installation token into `~/.git-credentials`.
  - A `credential.https://github.com.helper` shim answers `username=x-access-token` / `password=$GH_TOKEN`, reading the token from the environment at auth time.
  - `url.https://github.com/.insteadOf` rules translate GitHub SSH remotes to HTTPS **inside agent commands only**.
  - `GIT_TERMINAL_PROMPT=0` so git can never fall back to interactive personal credentials.
  - A `GIT_SSH_COMMAND` guard makes any GitHub-bound `ssh` invocation fail loudly instead of silently using a personal SSH key — including rewrites it cannot foresee.
  - Countersink `insteadOf` rules (generated at load from your global git config) so personal URL rewrites cannot drag GitHub URLs back onto personal SSH aliases.
  - `commit.gpgsign` is disabled so agent commits are never signed with a personal key.
- When the bot identity is resolved, `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` pin the **committer** to the App bot while the author stays your own identity — see [Commit attribution](#commit-attribution).
- `PI_GITHUB_APP_*` variables are **stripped** from the child environment: an agent command like `env` never sees the private key. Only the short-lived installation token is visible to the processes that need it.
- Personal `GITHUB_TOKEN` inherited from your shell is removed in agent shells so nothing silently falls back to it.

## HTTPS and SSH remotes

All three common remote forms are handled transparently inside agent commands, without rewriting `git remote -v` or any repository config:

```
git@github.com:owner/repo.git      -> https://github.com/owner/repo.git
ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo.git
https://github.com/owner/repo.git   -> (unchanged, App credential helper)
```

SSH host aliases that resolve to `github.com` in `~/.ssh/config` (including `Include`d files, e.g. `work.github.com`) are covered as well. Commits keep your configured author identity — authentication and authorship are separate concerns.

## Token lifecycle

1. A GitHub App JWT is signed **in memory** by `@octokit/auth-app` (`iss` = client id).
2. It is exchanged for an installation token, cached **in memory only** by the library — never written to disk, logs, or error messages.
3. A background timer refreshes it **5 minutes before** GitHub's `expires_at` (retrying every 30 s on failure).

If configuration is missing, invalid, or incomplete, the `bash` protection still registers and supplies an invalid sentinel token instead of personal credentials. Run setup or fix the configuration, then reload Pi.

With valid configuration, token-fetch failures are retried every 30 seconds. A cached token is usable until its final minute; when no usable token is available, the protected shell supplies the same sentinel. GitHub authentication fails instead of silently consulting your personal credentials.

## Configuration

Credentials live in `<agent-dir>/pi-github-app-auth.json` (default `~/.pi/agent/`, override with `PI_CODING_AGENT_DIR`), written by the wizard:

```json
{
	"clientId": "Iv1xxxxxxxxxxxxxxxx",
	"installationId": "12345678",
	"privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
}
```

Real newlines in the PEM work as-is; escaped `\n` sequences are tolerated too.

**Environment override** — for per-repo identities (e.g. a different App per project via direnv), the three `PI_GITHUB_APP_*` variables take precedence over the file when set:

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

Prefer the file when you can: keeping the key out of the environment avoids automatically passing it to unrelated subprocesses. It does not prevent processes running as your user from reading the file.

## Security model and limitations

- **Not a sandbox:** extensions and agent commands run with your user's system access. The `0600` credential file is readable by your user, including user-level agent processes. Review third-party extensions before installing.
- Protection applies to the overridden agent `bash` tool, including calls routed to that tool through native codemode. It does not isolate the whole Pi process, independent MCP tools, or commands deliberately replacing the injected authentication settings.
- Missing/invalid/incomplete configuration and unavailable tokens block normal GitHub authentication in this protected shell. This is not a universal fail-closed guarantee across arbitrary tools.
- The App private key is stored in `<agent-dir>/pi-github-app-auth.json`, not passed to agent bash children. With environment-based configuration, the parent Pi process still receives the key; the extension strips those variables from protected children.
- JWTs and installation tokens are held in memory by the extension, not persisted by it. The installation token is visible to protected child processes through `GH_TOKEN`: do not print it or expose it to untrusted commands.
- Your persistent `~/.gitconfig`, repository `.git/config`, `gh auth`, keychain, and SSH configuration are not modified by authentication injection. Its settings exist only in the child environment.
- Commit author, bot committer, and PR author are distinct. Verify the PR author on GitHub when identity matters.

## Troubleshooting

Run `/github-app-auth status` inside Pi (no secrets are shown).

- **`incomplete configuration — missing …`** — some of the three `PI_GITHUB_APP_*` variables is set but not all (a partial override hides the credential file). Either complete the set or unset them all and rely on the credential file. In this state agent `git`/`gh` fail closed with a sentinel token instead of using your personal credentials — run `/github-app-auth setup` to fix.
- **`GitHub rejected the App JWT (HTTP 401)`** — wrong client id, wrong/stale private key, or system clock skew beyond ~1 minute.
- **`installation … not authorized or not found (HTTP 403/404)`** — the App is not installed on the target account/org, the installation id is wrong, or the App lacks the required permissions.
- **`GitHub SSH access is blocked in agent shells`** — a remote (or a personal git `insteadOf` rule) pointed at GitHub over SSH in a form the extension could not translate; use an HTTPS remote or check your global `url.*.insteadOf` rules.
- **`pi-github-app-unavailable` appearing as a token error** — no usable installation token is available. Check configuration first; with valid configuration, token-fetch failures are retried every 30 s. Protected agent bash does not fall back to personal credentials.

## Development and contributing

```sh
npm ci
npm test
npx tsc --noEmit
```

See [Contributing](.github/CONTRIBUTING.md) for the development workflow. Report vulnerabilities privately using the [security policy](.github/SECURITY.md), not a public issue.

## Code of conduct

This project follows the [Contributor Covenant](https://github.com/tonyputi/pi-github-app-auth/blob/main/.github/CODE_OF_CONDUCT.md) — the same standard used across the wider open-source community.

## License

[MIT](LICENSE)
