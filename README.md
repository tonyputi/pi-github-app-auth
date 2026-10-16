# pi-github-app-auth

A [Pi](https://pi.dev) extension that authenticates **commands executed through its overridden agent `bash` tool** to GitHub as a **GitHub App installation**, leaving your personal credentials untouched. Normal `gh pr create` on that tool's PATH verifies the installation credential before creation and the actual bot PR author afterward.

**Not a global GitHub sandbox:** external execution tools (`ctx_execute`, MCP, custom tools) do not inherit this bash environment. They must not be used for agent GitHub mutations. See [Supported paths and limits](#supported-paths-and-limits).

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

The extension provides authentication and scoped isolation, not a GitHub workflow engine. Use normal `git` and `gh` commands in its agent bash. A temporary, token-free `gh` launcher validates the actual `GH_TOKEN` before invoking the real CLI; for `gh pr create`, it also verifies the target repository and actual PR author. Commit author/committer metadata is **not** proof of PR authorship.

### Supported paths and limits

- **Protected:** normal `gh pr create --repo owner/repo --head branch --base main --title '...' --body '...'` through the overridden `bash` tool. `--body-file` is supported. Use separate option flags and values (or long `--flag=value`); unsupported/combined flag forms fail before creation. The launcher rejects missing/replaced credentials, an invalid installation token, non-`github.com` targets and browser/editor PR creation before a PR is created. After success, it fetches the PR and requires the configured App's `[bot]` login and `Bot` type. A postcondition failure reports the PR URL; stop and investigate rather than retrying blindly.
- **Codemode:** `tools.bash(...)` reaches the same protection when it uses Pi's native nested tool dispatch. `tools.ctx_execute(...)` does not. Known external GitHub execution/MCP calls are blocked with an actionable diagnostic; this is a best-effort diagnostic, not a parser for arbitrary code.
- **Subagents / nested sessions:** only supported when they independently load this extension and use its bash tool. A parent session's installation does not prove a child's protection. Check status in the child; custom SDK sessions must load the extension explicitly.
- **Unsupported:** GitHub MCP/custom execution, arbitrary API-based PR creation (`gh api`/`curl`/SDK), `gh` aliases that create PRs, absolute paths to `gh`, changing PATH, startup scripts that replace it, detached processes outliving a tool call, explicit credential overrides, alternate GitHub hosts, and any code that deliberately bypasses the launcher. The extension does not intercept those paths and cannot guarantee their PR authorship. Do not use them for agent PR creation.
- **Deliberately personal:** your terminal and Pi manual `!` / `!!` shell. They are outside protection, not evidence that an agent command is protected.

The extension runs with your OS permissions. It is not a defense against malicious tools or arbitrary code reading your credential files. For stronger isolation, run the entire agent and its external tools in an OS/container sandbox without personal credentials.

## Installation

Requires Pi **>=1.2, <2** (native tool interception/dispatch) and its supported Node runtime on **macOS/Linux**. The guarded launcher is not supported on Windows; agent bash is blocked there instead of silently running unprotected. Check the version of the Pi executable you actually launch; a separate older `pi` on PATH does not use the same runtime.

```bash
pi install npm:pi-github-app-auth
```

or from git:

```bash
pi install git:github.com/tonyputi/pi-github-app-auth
```

or from a local checkout:

```bash
pi install /absolute/path/to/pi-github-app-auth
```

One runtime dependency — `@octokit/auth-app` (GitHub-maintained) for App JWTs and installation tokens. Everything else is Node built-ins and the Pi extension API.

## Setup

The whole setup runs **inside Pi** — no separate commands, no direnv, no restart juggling:

```bash
pi install npm:pi-github-app-auth   # then start pi and run:
/github-app-auth setup
```

What happens: pick personal account or organization → a pre-filled GitHub App form opens in your browser (name included — just press **Create**) → the App is created from a manifest, so client id and private key come back automatically → the install page opens and the wizard detects the installation → credentials are saved to `<agent-dir>/pi-github-app-auth.json` with mode `0600` (same discipline as Pi's own `auth.json`) → confirm to reload Pi and you're live. Check any time with `/github-app-auth status`.

The security-sensitive parts stay tight: the private key exists in memory only until it is written once to the 0600 file, it never enters the environment, and the local callback server binds to `127.0.0.1` only.

Prefer the manual route? Follow GitHub's App guides, then continue below.

> The old `pi-github-app-auth-setup` npm CLI still works but only prints a pointer to `/github-app-auth setup`; it will be removed in 1.0.

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

Prefer the file when you can: keeping the key out of the environment means your own shells and every unrelated subprocess never see it.

### GitHub App prerequisites

New to GitHub Apps? Follow the official guides: [register the App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [generate a private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), and [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the target account/org.

- A GitHub App owned by you/your org with a generated private key.
- The App **installed** on the account/org/repositories you want the agent to reach.
- Repository permissions for what the agent should do — for typical agent work: **Contents: Read & write** (clone/push), **Pull requests: Read & write**, **Issues: Read & write**, **Metadata: Read-only** (mandatory), plus **Workflows: Read & write** if the agent touches GitHub Actions. No webhook URL is needed.

## How it works

The extension **always** overrides Pi's built-in `bash` tool, including with absent or invalid configuration. Local commands still work; unavailable App authentication never re-enables personal GitHub credentials. It adjusts every command spawned through that tool:

- `GH_TOKEN=<installation token>` — the temporary `gh` launcher checks its SHA-256 digest against the token obtained for the configured App and calls the installation-token-only `/installation/repositories` API before invoking the real `gh`. A PAT or personal `gh auth` cannot pass this check. The expected bot comes from authenticated `GET /app`, not cached commit attribution.
- A private temporary directory holds the token-free launcher (only executable paths, bot login and token digest), is prepended to this bash's PATH, and is removed when the tool call finishes. The token itself is never written there. Each real `gh` invocation uses a separate empty temporary `GH_CONFIG_DIR` and an invalid enterprise-token sentinel, so personal `gh auth` configuration/aliases and alternate-host credentials are not a fallback; your real gh config is untouched.
- `GH_HOST=github.com`; inherited enterprise tokens, `GH_DEBUG`, `BASH_ENV` and `ENV` are removed to avoid ambient auth/startup overrides.
- Ephemeral git config (process environment only, equivalent to `git -c`, nothing persisted):
  - `credential.helper` is **reset**, so personal helpers (macOS keychain, `store`, `gh auth git-credential`) are never consulted — and never *write* the installation token into `~/.git-credentials`.
  - A `credential.https://github.com.helper` shim answers `username=x-access-token` / `password=$GH_TOKEN`, reading the token from the environment at auth time.
  - `url.https://github.com/.insteadOf` rules translate GitHub SSH remotes to HTTPS **inside agent commands only**.
  - `GIT_TERMINAL_PROMPT=0` so git can never fall back to interactive personal credentials.
  - A `GIT_SSH_COMMAND` guard makes Git-managed SSH invocations to recognized GitHub hosts fail loudly rather than use a personal key. Direct `ssh`, unresolved aliases and deliberate SSH overrides are not a supported PR workflow.
  - Countersink `insteadOf` rules (generated at load from your global git config) so personal URL rewrites cannot drag GitHub URLs back onto personal SSH aliases.
  - `commit.gpgsign` is disabled so agent commits are never signed with a personal key.
- `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` pin the **committer** to the App bot while the author stays your own identity — see [Commit attribution](#commit-attribution).
- `PI_GITHUB_APP_*` variables are **stripped** from the child environment: an agent command like `env` never sees the private key. Only the short-lived installation token is visible to the processes that need it.
- Personal `GITHUB_TOKEN` inherited from your shell is removed in agent shells so nothing silently falls back to it.

## Token lifecycle

1. A GitHub App JWT is signed **in memory** by `@octokit/auth-app` (`iss` = client id).
2. It is exchanged for an installation token, validated, and cached **in memory only** in that extension runtime — never written to disk, logs, or error messages.
3. Before each bash call, a missing or nearly expired token is refreshed on demand. Expired responses and tokens in their final minute are rejected. Concurrent calls share the refresh, not another session's credentials.
4. The launcher checks the actual credential again immediately before every `gh` execution, so expired/revoked/replaced tokens cannot fall back to `gh auth`.

If authentication is unavailable, `GH_TOKEN` is given a sentinel value and git/gh fail instead of using your personal credentials. A later agent bash call retries authentication. There are no background refresh timers.

## Commit attribution

Agent commands create commits with **your author identity** (the machine's `user.name` / `user.email`) but the **committer pinned to the App bot** — GitHub renders both, so on a shared-App team you can see at a glance who launched the agent and that the commit is machine-made:

```
authored by alice, committed by pi-agent-x1y2[bot]
```

- Zero configuration: the identity (App slug + bot user id) is resolved automatically via the GitHub API at setup and cached in the credential file; installs created before this feature resolve it lazily on first use.
- PR authorship is a separate API identity, not a consequence of this attribution. Only the supported guarded `gh pr create` path verifies that the PR itself is authored by the App, allowing the human who launched the agent to submit a native **Request changes** review.
- Agent commits are unsigned (`commit.gpgsign` off inside agent commands): signing machine work with a personal key would attach your verified badge to bot commits. Organizations that require signed commits should sign agent work deliberately.
- Known limits: rebasing rewrites the committer (attribution is strongest on the commits the agent originally created), and the author identity is per-machine — one human per machine, which is how Pi is normally run.

## HTTPS and SSH remotes

All three common remote forms are handled transparently inside agent commands, without rewriting `git remote -v` or any repository config:

```
git@github.com:owner/repo.git      -> https://github.com/owner/repo.git
ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo.git
https://github.com/owner/repo.git   -> (unchanged, App credential helper)
```

SSH host aliases that resolve to `github.com` in `~/.ssh/config` (including `Include`d files, e.g. `work.github.com`) are covered as well. Commits keep your configured author identity — authentication and authorship are separate concerns.

## Security notes

- The private key exists in memory until setup writes it once to `<agent-dir>/pi-github-app-auth.json` (mode `0600`, readable only by your user — the same discipline as Pi's own `auth.json`; like any file on your account, it is readable by the agent too). JWTs and installation tokens are never written to disk, logs, or error messages.
- Nothing in *your* persistent configuration is modified: `~/.gitconfig`, repository `.git/config`, `gh auth`, keychain, and SSH config stay exactly as they are. All changes are per-process environment.
- Packages run with full system access — review third-party extension source before installing.

## Troubleshooting

Run `/github-app-auth status` inside Pi (no secrets are shown).

- **`incomplete configuration — missing …`** — some of the three `PI_GITHUB_APP_*` variables is set but not all (a partial override hides the credential file). Complete the set or unset them all and rely on the credential file, then `/reload`. Bash interception stays registered: GitHub authentication fails closed, never with your normal credentials. The same applies to missing/malformed credential files.
- **`GitHub rejected the App JWT (HTTP 401)`** — wrong client id, wrong/stale private key, or system clock skew beyond ~1 minute.
- **`installation … not authorized or not found (HTTP 403/404)`** — the App is not installed on the target account/org, the installation id is wrong, or the App lacks the required permissions.
- **`GitHub SSH access is blocked in agent shells`** — a remote (or a personal git `insteadOf` rule) pointed at GitHub over SSH in a form the extension could not translate; use an HTTPS remote or check your global `url.*.insteadOf` rules.
- **`App credentials missing or replaced` / `pi-github-app-unavailable`** — the installation token/identity could not be verified, or the command changed its credential. Check `/github-app-auth status`, configuration and GitHub connectivity; retry once resolved. Personal credentials are never a fallback.
- **`INVARIANT`** — a PR may already exist, but the author could not be confirmed or was unexpected. Follow the reported URL and investigate; authors cannot be changed in place. Never treat a failed postcheck as pre-creation prevention.
- Status separately reports configuration, token readiness (lazy until the first bash call), registered bash interception, and unsupported/manual paths. Another extension replacing this tool, or a runtime launched without this extension, is outside its control.

## Regression #29: evidence, recovery and release gate

On 2026-10-15, Akrivia PRs #744/#745 were actually authored by `tonyputi`; #745's bot committer did not change its PR author. Local transcript evidence for #745 shows `codemode → tools.ctx_execute(language: python) → subprocess.run(['gh','pr','create', ...])` at **17:10:50 UTC**, returning the PR at **17:10:54 UTC**. This bypassed the bash spawn hook. The exact #744 creation path has not been established; do not infer it from #745. The separate invalid-config fallback was reproduced in the old registration logic and is removed.

**Recovery:** GitHub cannot change the author of existing PRs #744/#745. With maintainer approval, open replacement bot-authored PRs using the original branches, link both directions, carry forward unresolved review context, verify native human review, and only then close the old PRs. Do not rewrite commits or close old discussions as a substitute for this recovery.

**Release gate (not satisfied by mocks or commit metadata):**

1. Run `npm test` and `npx tsc --noEmit`.
2. Use a dedicated, safe test repository accessible to the App — **never Akrivia**. From a real Pi agent session loading this checkout, run guarded `gh pr create`; verify via GitHub that `PR.user.login == <configured-app>[bot]`.
3. Using the human's deliberately personal credentials, submit an actual native review with `event: REQUEST_CHANGES`; fetch the review and require `state: CHANGES_REQUESTED` and the expected human login.
4. From a real Pi agent session with missing/invalid App auth and personal gh credentials still available, attempt PR creation on a separate test branch. Require a failed tool call and verify GitHub created **no PR** for that branch.
5. Record the test repo, PR/review IDs, identity/state and negative result before closing the test PR and deleting test branches. Do not publish/declare the invariant fixed if this gate has not passed.

Repeatable opt-in gate, from a deliberate human terminal with App config and personal `gh` credentials available:

```bash
PI_GITHUB_APP_AUTH_LIVE_TEST=1 npm run test:live
```

It refuses any target other than the private `tonyputi/pi-github-app-auth-e2e` repository, runs the installed Pi peer's real CLI twice, submits/verifies the native human review and only then cleans up. A failed run leaves its test refs and private temporary JSONL evidence for investigation; inspect before retrying.

**Latest verification, 2026-10-15 at 19:40:11 UTC:** [dedicated test PR #2](https://github.com/tonyputi/pi-github-app-auth-e2e/pull/2), author `pullsmith-by-tonyputi[bot]`; human `tonyputi`, [native review **5538914741**](https://github.com/tonyputi/pi-github-app-auth-e2e/pull/2#pullrequestreview-5538914741), state **`CHANGES_REQUESTED`**. A separate real Pi session with invalid App config and personal credentials present failed PR creation; GitHub returned **0 PRs** for its unique negative-test branch. Positive session `01a14114-2714-760e-88a6-97a55769a424`; negative session `01a14114-134f-7052-9b2f-7996e99dc18a`. The PR was closed and the two test branches deleted only after verification. No Akrivia mutations were made.

## Code of conduct

This project follows the [Contributor Covenant](https://github.com/tonyputi/pi-github-app-auth/blob/main/.github/CODE_OF_CONDUCT.md) — the same standard used across the wider open-source community.

## License

MIT
