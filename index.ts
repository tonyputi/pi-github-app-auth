/**
 * pi-github-app-auth — GitHub App authentication for Pi agent bash only.
 *
 * Commands the agent runs through its `bash` tool authenticate to GitHub as a
 * GitHub App installation (installation token). Everything else is untouched:
 * the user's normal terminal, Pi's manual `!` / `!!` shell, ~/.gitconfig,
 * gh auth, ~/.git-credentials, keychain and SSH config.
 *
 * The bash override is always registered, even with missing/broken config.
 * A token-free gh launcher on its temporary PATH checks the actual credential
 * before execution and verifies gh pr create's actual PR author afterward.
 * External execution tools do not inherit this PATH; they are unsupported.
 * The synchronous spawnHook also adjusts the spawned process environment:
 *
 *   - strips PI_GITHUB_APP_PRIVATE_KEY / _CLIENT_ID / _INSTALLATION_ID
 *     (the App private key is consumed here, never visible to any subprocess)
 *   - injects GH_TOKEN=<installation token>  (in-memory only, never on disk)
 *   - injects ephemeral git config via GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
 *     (equivalent to `git -c`, nothing persisted anywhere):
 *
 *       credential.helper = ""
 *           Resets the helper list, so personal helpers from the user's global
 *           config (e.g. `store` -> ~/.git-credentials, osxkeychain) are never
 *           consulted — and never *store* the installation token after auth.
 *       credential.https://github.com.helper = !f() { sleep 1; if [ "$1" = get ] ...
 *           Emits username=x-access-token / password=$GH_TOKEN. Reads the token
 *           from the environment at auth time; the token is never embedded in
 *           any config string. Scoped to github.com; other hosts unaffected.
 *       url.https://github.com/.insteadOf = git@github.com:  and  ssh://git@github.com/
 *           GitHub SSH remotes are transparently rewritten to HTTPS inside agent
 *           commands only; `git remote -v` keeps showing the original SSH URL.
 *           SSH host aliases that resolve to github.com in ~/.ssh/config
 *           (incl. `Include`d files) are covered too.
 *       GIT_TERMINAL_PROMPT = 0
 *           Git can never fall back to interactive (personal) credentials.
 *       GIT_SSH_COMMAND = guard function
 *           Any GitHub-bound ssh invocation inside agent shells fails loudly
 *           instead of silently using personal SSH keys. Non-GitHub hosts pass
 *           through to real ssh untouched.
 *       Countersink insteadOf rules (generated from the user's global config at load)
 *           Personal global url.*.insteadOf rules can rewrite GitHub HTTPS URLs
 *           onto personal SSH aliases; git resolves single-pass longest-prefix
 *           matches in favor of global config, so each is outranked here by a
 *           one-char-longer rule that maps the URL back to https://github.com/.
 *
 * Token lifecycle: @octokit/auth-app signs the App JWT and exchanges it for
 * an installation token. Tokens are refreshed on demand before agent commands,
 * never served in their final minute, and checked again by the gh launcher.
 * If auth is unavailable, GH_TOKEN gets a sentinel value and git/gh fail fast
 * (no helpers, no prompt, no keyring) instead of silently using the user's
 * personal credentials.
 *
 * Configuration — resolved in this order:
 *   1. Environment override (per-repo identity, e.g. via direnv):
 *        PI_GITHUB_APP_CLIENT_ID         GitHub App client id (JWT `iss`)
 *        PI_GITHUB_APP_INSTALLATION_ID   GitHub App installation id
 *        PI_GITHUB_APP_PRIVATE_KEY       GitHub App PEM private key
 *   2. Credential file <agent-dir>/pi-github-app-auth.json (0600), written by
 *      the in-Pi wizard: /github-app-auth setup
 */

import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { githubJson, installGhGuard } from "./gh-guard.ts";
import { join } from "node:path";
import {
	createAuth,
	credentialsPath,
	readConfig,
	resolveCommitterIdentity,
	runSetupWizard,
	saveStoredCredentials,
	type AppAuth,
	type GitHubAppConfig,
	type WizardUI,
} from "./setup.ts";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

const SERVE_MARGIN_MS = 60 * 1000; // never start a command with a nearly expired token
const GH_SENTINEL = "pi-github-app-unavailable";

// Runs under `sh -c` by git. `sleep 1` lets git finish writing the credential
// request to the helper's stdin before we exit (the canonical helper pattern).
// Reads the token from the environment — never embedded in config. The reset
// above means this is the ONLY helper: nothing personal is consulted, and the
// "store" action is a no-op, so the installation token is never persisted.
// The sentinel check keeps the no-token guard state a clean local failure.
const GITHUB_CREDENTIAL_HELPER = `!f() { sleep 1; if [ "$1" = get ]; then if [ -n "$GH_TOKEN" ] && [ "$GH_TOKEN" != "${GH_SENTINEL}" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; else printf 'pi-github-app: App token unavailable; run /github-app-auth setup or /reload. No personal credentials allowed.\\n' >&2; fi; fi; }; f`;

// Any GitHub-bound ssh invocation inside agent shells fails loudly instead of
// silently using personal SSH keys (catches insteadOf rewrites this extension
// cannot foresee, e.g. rules added later or from includeIf volume configs).
// Non-GitHub hosts pass through to real ssh untouched.
const GIT_SSH_GUARD = `pi_github_app_guard() { for a in "$@"; do case "$a" in *github.com|*github.com:*) printf 'pi-github-app: GitHub SSH access is blocked in agent shells; use HTTPS (GitHub App). Arg: %s\\n' "$a" >&2; exit 111 ;; esac; done; command ssh "$@"; }; pi_github_app_guard`;


/**
 * JWT signing + installation-token exchange, owned by @octokit/auth-app
 * (GitHub-maintained; installation tokens cached in memory by the library).
 * `createAuth` and config resolution live in setup.ts alongside the wizard.
 *
 * `appId` receives the App client id: GitHub accepts it as the JWT `iss`
 * (verified live against the API), so no numeric App id is needed in config.
 */

async function fetchInstallationToken(auth: AppAuth, config: GitHubAppConfig): Promise<CachedToken> {
	let token: string;
	let expiresAt: string;
	try {
		({ token, expiresAt } = (await auth({ type: "installation", installationId: config.installationId, refresh: true })) as {
			token: string;
			expiresAt: string;
		});
	} catch (err) {
		const status = (err as { status?: unknown }).status;
		// Octokit errors can carry request credentials. Never forward their text.
		if (status === 401) throw new Error("GitHub rejected the App credentials (HTTP 401; check client id / private key)");
		if (status === 403 || status === 404) {
			throw new Error(`installation not authorized or not found (HTTP ${status})`);
		}
		throw new Error(`GitHub installation-token request failed (HTTP ${typeof status === "number" ? status : "?"})`);
	}
	const expiresAtMs = Date.parse(expiresAt);
	if (typeof token !== "string" || !token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + SERVE_MARGIN_MS) throw new Error("installation-token response is missing, expired or too close to expiry");
	return { token, expiresAtMs };
}

/**
 * SSH host aliases that ultimately point at github.com (e.g. "work.github.com"
 * from ~/.ssh/config) plus plain "github.com". Read-only; follows `Include`
 * lines (relative or absolute, glob patterns allowed) with a visited-set
 * against loops.
 */
function githubSshHosts(sshDir = join(homedir(), ".ssh")): string[] {
	const hosts = new Set<string>(["github.com"]);
	const visited = new Set<string>();
	const parse = (file: string, depth: number): void => {
		if (visited.has(file) || depth > 5) return;
		visited.add(file);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return;
		}
		let pendingHosts: string[] = [];
		for (const line of text.split("\n")) {
			const host = line.match(/^\s*Host\s+(\S.*)$/i);
			if (host) {
				pendingHosts = host[1].trim().split(/\s+/);
				continue;
			}
			const hostname = line.match(/^\s*HostName\s+(\S+)\s*$/i);
			if (hostname && hostname[1].toLowerCase() === "github.com") {
				for (const h of pendingHosts) if (h && !/[*?]/.test(h)) hosts.add(h.toLowerCase());
			}
			const include = line.match(/^\s*Include\s+(\S.*)$/i);
			if (include) {
				for (const pattern of include[1].trim().split(/\s+/)) {
					const abs = pattern.startsWith("/") ? pattern : join(sshDir, pattern);
					let files: string[] = [];
					try {
						files = globSync(abs);
					} catch {
						// unresolvable include: skip it
					}
					for (const f of files) parse(f, depth + 1);
				}
			}
		}
	};
	parse(join(sshDir, "config"), 0);
	return [...hosts];
}

interface GlobalRewrite {
	base: string;
	prefix: string;
}

/** Suffixes used to build strictly-longer countersink prefixes (URL-safe chars). */
const COUNTERSINK_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-~";

/** Read the user's global `url.<base>.insteadOf = <prefix>` rules (read-only). */
function globalInsteadOfRules(): GlobalRewrite[] {
	try {
		const out = execFileSync("git", ["config", "--global", "--get-regexp", "url\\..*\\.insteadof"], { encoding: "utf8" });
		return out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const m = line.match(/^url\.(.*)\.insteadof (.+)$/i);
				return m ? { base: m[1], prefix: m[2] } : null;
			})
			.filter((r): r is GlobalRewrite => r !== null);
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status !== 1) console.error(`pi-github-app: could not read global insteadOf rules (git exit ${status ?? "?"}) — the SSH guard still blocks GitHub SSH`);
		return []; // status 1 = no matches: nothing to counter
	}
}

/**
 * Countersinks for the user's own global `url.*.insteadOf` rules. Git resolves
 * insteadOf with a single-pass longest-prefix match and keeps the first rule of
 * equal length (global wins ties), so each countersink prefix is one char longer
 * and maps the URL back to its https://github.com/ form:
 *   - https prefixes  -> no-op rewrite (URL already https; the App helper auths)
 *   - git@ prefixes   -> rewrite to the equivalent https://github.com/<owner>/<x> form
 * URLs whose next char is not in the charset fall through to the SSH guard.
 */
function githubCountersinks(): Array<[string, string]> {
	const sinks: Array<[string, string]> = [];
	for (const { prefix } of globalInsteadOfRules()) {
		const ghHttps = prefix.match(/^https:\/\/github\.com\/([^/]+\/$)/);
		const ghSsh = prefix.match(/^git@github\.com:([^/]+\/$)/);
		if (!ghHttps && !ghSsh) continue; // unrelated rule — the SSH guard covers it
		const owner = ghHttps ? ghHttps[1] : ghSsh![1];
		for (const x of COUNTERSINK_CHARS) {
			if (ghHttps) sinks.push([`url.${prefix}${x}.insteadOf`, `${prefix}${x}`]);
			else sinks.push([`url.https://github.com/${owner}${x}.insteadOf`, `${prefix}${x}`]);
		}
	}
	return sinks;
}

function agentEnv(
	env: NodeJS.ProcessEnv,
	token: string | null,
	countersinks: Array<[string, string]> = [],
	committer: { name: string; email: string } | null = null,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env };
	// The App key and its coordinates are consumed here — never leaked to a shell.
	delete next.PI_GITHUB_APP_PRIVATE_KEY;
	delete next.PI_GITHUB_APP_CLIENT_ID;
	delete next.PI_GITHUB_APP_INSTALLATION_ID;

	next.GIT_TERMINAL_PROMPT = "0";
	// Ephemeral per-process git config (same as `git -c`; nothing persisted).
	// Offset by any pre-existing GIT_CONFIG_COUNT entries instead of clobbering.
	const base = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0;
	const entries: Array<[string, string]> = [
		["credential.helper", ""], // reset: personal helpers never consulted or stored to
		["credential.https://github.com.helper", GITHUB_CREDENTIAL_HELPER],
	];
	for (const host of githubSshHosts()) {
		entries.push(["url.https://github.com/.insteadOf", `git@${host}:`]);
		entries.push(["url.https://github.com/.insteadOf", `ssh://git@${host}/`]);
	}
	entries.push(...countersinks); // outrank personal global insteadOf rewrites
	if (committer) {
		// Attribution: agent commits keep the machine's author identity (the
		// human behind the launch) while the committer is pinned to the App bot,
		// so GitHub renders "authored by <you>, committed by <app>[bot]".
		next.GIT_COMMITTER_NAME = committer.name;
		next.GIT_COMMITTER_EMAIL = committer.email;
		// A personal key signing a bot-committed commit would attach the human's
		// verified badge to machine work — agent commits stay unsigned instead.
		entries.push(["commit.gpgsign", "false"]);
	}
	for (const [i, [key, value]] of entries.entries()) {
		next[`GIT_CONFIG_KEY_${base + i}`] = key;
		next[`GIT_CONFIG_VALUE_${base + i}`] = value;
	}
	next.GIT_CONFIG_COUNT = String(base + entries.length);

	if (token) {
		next.GH_TOKEN = token;
	} else {
		// No token: give gh a sentinel so it fails loudly instead of silently
		// using the personal keyring account; git fails via the helper's sentinel check.
		next.GH_TOKEN = GH_SENTINEL;
	}
	// direnv setups often expose a personal GITHUB_TOKEN in pi's process; gh would
	// prefer GH_TOKEN, but other tools read GITHUB_TOKEN — keep agent shells
	// GitHub-App-only.
	delete next.GITHUB_TOKEN;
	delete next.GH_ENTERPRISE_TOKEN;
	delete next.GITHUB_ENTERPRISE_TOKEN;
	delete next.GH_DEBUG;
	// Shell startup hooks must not silently restore ambient personal credentials.
	delete next.BASH_ENV;
	delete next.ENV;
	next.GH_HOST = "github.com";
	// Fail loudly rather than ever using personal SSH keys for GitHub hosts.
	next.GIT_SSH_COMMAND = GIT_SSH_GUARD;
	return next;
}

/** First whitespace-separated token of raw command args ("" when blank). */
function parseSubcommand(args: string): string {
	return args.trim().split(/\s+/)[0] ?? "";
}

/** /github-app-auth setup — the manifest-flow wizard, entirely inside Pi. */
async function runSetupCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"github-app-auth: the setup wizard needs an interactive session (pi in a terminal). Headless alternative: create the App manually and set PI_GITHUB_APP_* — see the README.",
			"warning",
		);
		return;
	}
	const existing = readConfig();
	if (existing.config) {
		const where = existing.source === "env" ? "environment variables (PI_GITHUB_APP_*)" : credentialsPath();
		const again = await ctx.ui.confirm("github-app-auth", `An App is already configured via ${where}. Create and configure a different one?`);
		if (!again) return;
	}
	const ui: WizardUI = ctx.ui;
	try {
		const result = await runSetupWizard(ui);
		if (!result) return; // cancelled
		if (process.env.PI_GITHUB_APP_CLIENT_ID?.trim() || process.env.PI_GITHUB_APP_PRIVATE_KEY?.trim()) {
			ui.notify(
				"github-app-auth: PI_GITHUB_APP_* environment variables are set and will take precedence over the saved file (per-repo override). The new App only becomes active once they are unset.",
				"warning",
			);
		}
		const activate = await ctx.ui.confirm(
			"github-app-auth — setup complete",
			`App "${result.slug}" installed (installation ${result.installationId}); credentials saved to ${result.path} (mode 0600).\nReload the Pi runtime now to activate? Same as /reload — sessions are preserved.`,
		);
		if (activate) await ctx.reload();
		else ui.notify("github-app-auth: saved. Run /reload when ready to activate.", "info");
	} catch (err) {
		ui.notify(`github-app-auth: setup failed — ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

export default function piGithubAppAuth(pi: ExtensionAPI): void {
	const { config, source, error } = readConfig();
	const countersinks = githubCountersinks();
	let cached: CachedToken | null = null;
	let bot = "";
	let committer: { name: string; email: string } | null = null;
	let preparing: Promise<void> | null = null;
	let authError = error ?? (config ? "token not requested yet" : "not configured; run /github-app-auth setup");
	const currentToken = (): string | null => cached && Date.now() < cached.expiresAtMs - SERVE_MARGIN_MS ? cached.token : null;
	async function prepare(): Promise<void> {
		if (!config || currentToken()) return;
		if (preparing) return preparing;
		preparing = (async () => {
			try {
				const auth = createAuth(config!.clientId, config!.privateKey);
				const candidate = await fetchInstallationToken(auth, config!);
				const jwt = await auth({ type: "app" });
				const app = await githubJson("/app", jwt.token);
				if (typeof app.slug !== "string" || !/^[a-z0-9-]+$/.test(app.slug)) throw new Error("Cannot verify the configured App bot identity");
				await githubJson("/installation/repositories?per_page=1", candidate.token);
				bot = `${app.slug}[bot]`;
				committer = config!.committerName === bot && config!.committerEmail
					? { name: bot, email: config!.committerEmail }
					: await resolveCommitterIdentity(auth);
				if (source === "file" && committer) {
					try { saveStoredCredentials({ ...config!, committerName: committer.name, committerEmail: committer.email }); }
					catch { /* Attribution cache is optional; authentication is not. */ }
				}
				cached = candidate;
				authError = "";
			} catch {
				cached = null;
				authError = "App token/identity unavailable; check configuration and GitHub access, then retry (no personal fallback)";
			}
		})().finally(() => { preparing = null; });
		return preparing;
	}
	let realGh = "/gh-not-installed";
	try { realGh = execFileSync("which", ["gh"], { encoding: "utf8" }).trim().split("\n")[0]; } catch { /* The launcher fails closed if gh is absent. */ }
	const bashTool = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...bashTool,
		promptGuidelines: [...(bashTool.promptGuidelines ?? []), "Run GitHub commands only via this protected bash tool, including from codemode. Never use ctx_execute, MCP, custom execution tools or unverified subagents for GitHub mutations. Use normal gh pr create (not an absolute gh path or browser creation); the launcher verifies the installation token and actual PR author. This is not an OS sandbox."],
		async execute(id, params, signal, onUpdate, ctx) {
			if (process.platform === "win32") throw new Error("pi-github-app-auth's guarded bash launcher supports macOS/Linux only; Windows agent bash is blocked rather than using personal credentials");
			await prepare();
			const token = currentToken();
			const dir = mkdtempSync(join(tmpdir(), "pi-github-app-"));
			try {
				installGhGuard(dir, realGh, bot, token);
				const guarded = createBashToolDefinition(ctx.cwd, {
					spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: { ...agentEnv(env, token, countersinks, committer), PATH: `${dir}:${env.PATH ?? ""}` } }),
				});
				return await guarded.execute(id, params, signal, onUpdate, ctx);
			} finally { rmSync(dir, { recursive: true, force: true }); }
		},
	});
	pi.on("tool_call", (event) => {
		if (unsupportedGithubTool(event.toolName, event.input)) return { block: true, reason: "GitHub access through this tool is NOT protected. Run the command through the pi-github-app-auth bash tool instead (including tools.bash from codemode)." };
	});

	pi.registerCommand("github-app-auth", {
		description: "GitHub App auth for agent bash — subcommands: status, setup",
		handler: async (args, ctx) => {
			const sub = parseSubcommand(args);
			if (sub === "setup") {
				await runSetupCommand(ctx);
				return;
			}
			if (sub && sub !== "status" && sub !== "help") {
				ctx.ui.notify(`github-app-auth: unknown subcommand "${sub}" — try /github-app-auth status or /github-app-auth setup`, "warning");
				return;
			}
			const token = config ? currentToken() : null;
			const expiry = cached ? new Date(cached.expiresAtMs).toLocaleTimeString() : "—";
			ctx.ui.notify(
				[
					`github-app-auth: configured=${Boolean(config)}; bash interception registered=yes (even without config)`,
					`bash tool active in model loadout: ${pi.getActiveTools().includes("bash")}`,
					authError ? `auth: ${authError}` : `verified App: ${bot}`,
					config ? `config source: ${source === "env" ? "environment override (PI_GITHUB_APP_*)" : credentialsPath()}` : "",
					committer ? `commit attribution: agent commits authored by your git identity, committed as ${committer.name}` : "",
					token ? `installation token: cached in memory, expires ${expiry}` : "installation token: not available right now",
					"agent bash: GH_TOKEN + ephemeral git config + guarded gh on PATH; unavailable auth fails closed",
					"scope: normal gh pr create in this bash only; preflight installation-token check + postflight PR author check",
					"NOT protected: external ctx_execute/MCP/custom execution, absolute gh paths, altered PATH, explicit credential overrides, detached processes, subagents without this extension",
					"human terminal and Pi !/!! manual shell: personal credentials, deliberately outside protection",
				]
					.filter(Boolean)
					.join("\n"),
				config && token ? "info" : "warning",
			);
		},
	});
}

/** Early diagnostics for known bypasses, not a parser or a sandbox for arbitrary code. */
function unsupportedGithubTool(name: string, input: unknown): boolean {
	if (name === "bash") return false;
	if (/github|create_?pull_?request/i.test(name)) return true;
	return /ctx_(execute|execute_file|batch_execute)$/.test(name) && /\bgh\b|github\.com|git[\s'",]+push/.test(JSON.stringify(input) ?? "");
}

// Exposed for self-check scripts only; pi itself only uses the default export.
export const _internals = { agentEnv, githubSshHosts, githubCountersinks, readConfig, createAuth, fetchInstallationToken, parseSubcommand, unsupportedGithubTool, GITHUB_CREDENTIAL_HELPER, GH_SENTINEL };
