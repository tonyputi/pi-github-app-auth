/**
 * pi-github-app-auth — GitHub App authentication for Pi agent bash only.
 *
 * Commands the agent runs through its `bash` tool authenticate to GitHub as a
 * GitHub App installation (installation token). Everything else is untouched:
 * the user's normal terminal, Pi's manual `!` / `!!` shell, ~/.gitconfig,
 * gh auth, ~/.git-credentials, keychain and SSH config.
 *
 * How it works: overrides the built-in `bash` tool (createBashTool + spawnHook).
 * The synchronous spawnHook adjusts the spawned process environment:
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
 * an installation token (cached in memory by the library); a background timer
 * refreshes 5 minutes before GitHub's expires_at (with retry). If the token
 * is momentarily unavailable, GH_TOKEN gets a sentinel value and git/gh fail fast
 * (no helpers, no prompt, no keyring) instead of silently using the user's
 * personal credentials.
 *
 * Configuration (environment variables, e.g. via direnv):
 *   PI_GITHUB_APP_CLIENT_ID         GitHub App client id (JWT `iss`)
 *   PI_GITHUB_APP_INSTALLATION_ID   GitHub App installation id
 *   PI_GITHUB_APP_PRIVATE_KEY       GitHub App PEM private key
 */

import { createAppAuth } from "@octokit/auth-app";
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface GitHubAppConfig {
	/** GitHub App client id — used as the JWT `iss` claim. */
	clientId: string;
	/** GitHub App installation id for the token exchange. */
	installationId: string;
	/** PEM private key of the GitHub App (real or escaped newlines). */
	privateKey: string;
}

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh this long before expires_at
const SERVE_MARGIN_MS = 60 * 1000; // stop handing out the cached token this close to expiry
const REFRESH_RETRY_MS = 30 * 1000;
const GH_SENTINEL = "pi-github-app-unavailable";

// Runs under `sh -c` by git. `sleep 1` lets git finish writing the credential
// request to the helper's stdin before we exit (the canonical helper pattern).
// Reads the token from the environment — never embedded in config. The reset
// above means this is the ONLY helper: nothing personal is consulted, and the
// "store" action is a no-op, so the installation token is never persisted.
// The sentinel check keeps the no-token guard state a clean local failure.
const GITHUB_CREDENTIAL_HELPER = `!f() { sleep 1; if [ "$1" = get ] && [ -n "$GH_TOKEN" ] && [ "$GH_TOKEN" != "${GH_SENTINEL}" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; fi; }; f`;

// Any GitHub-bound ssh invocation inside agent shells fails loudly instead of
// silently using personal SSH keys (catches insteadOf rewrites this extension
// cannot foresee, e.g. rules added later or from includeIf volume configs).
// Non-GitHub hosts pass through to real ssh untouched.
const GIT_SSH_GUARD = `pi_github_app_guard() { for a in "$@"; do case "$a" in *github.com|*github.com:*) printf 'pi-github-app: GitHub SSH access is blocked in agent shells; use HTTPS (GitHub App). Arg: %s\\n' "$a" >&2; exit 111 ;; esac; done; command ssh "$@"; }; pi_github_app_guard`;

function readConfig(): { config?: GitHubAppConfig; error?: string } {
	const clientId = process.env.PI_GITHUB_APP_CLIENT_ID?.trim();
	const installationId = process.env.PI_GITHUB_APP_INSTALLATION_ID?.trim();
	const rawKey = process.env.PI_GITHUB_APP_PRIVATE_KEY?.trim();

	const present = [clientId, installationId, rawKey].filter((v) => v);
	if (present.length === 0) return {}; // not configured at all -> stay inert
	if (present.length < 3) {
		const missing = [
			!clientId && "PI_GITHUB_APP_CLIENT_ID",
			!installationId && "PI_GITHUB_APP_INSTALLATION_ID",
			!rawKey && "PI_GITHUB_APP_PRIVATE_KEY",
		].filter(Boolean);
		return { error: `incomplete configuration — missing ${missing.join(", ")}` };
	}
	// Tolerate PEM keys whose newlines were escaped as literal "\n".
	const privateKey = rawKey!.includes("\\n") && !rawKey!.includes("\n") ? rawKey!.replace(/\\n/g, "\n") : rawKey!;
	if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
		return { error: "PI_GITHUB_APP_PRIVATE_KEY does not look like a PEM private key" };
	}
	return { config: { clientId: clientId!, installationId: installationId!, privateKey } };
}

type AppAuth = ReturnType<typeof createAppAuth>;

/**
 * JWT signing + installation-token exchange, owned by @octokit/auth-app
 * (GitHub-maintained; installation tokens cached in memory by the library).
 *
 * `appId` receives the App client id: GitHub accepts it as the JWT `iss`
 * (verified live against the API), so no numeric App id is needed in config.
 */
function createAuth(clientId: string, privateKey: string): AppAuth {
	return createAppAuth({ appId: clientId, privateKey });
}

async function fetchInstallationToken(auth: AppAuth, config: GitHubAppConfig): Promise<CachedToken> {
	let token: string;
	let expiresAt: string;
	try {
		({ token, expiresAt } = (await auth({ type: "installation", installationId: config.installationId })) as {
			token: string;
			expiresAt: string;
		});
	} catch (err) {
		const status = (err as { status?: unknown }).status;
		const message = err instanceof Error ? err.message : String(err);
		const detail = message ? ` — ${message}` : "";
		if (status === 401) throw new Error(`GitHub rejected the App credentials (HTTP 401; check client id / private key)${detail}`);
		if (status === 403 || status === 404) {
			throw new Error(`installation ${config.installationId} not authorized or not found (HTTP ${status})${detail}`);
		}
		throw new Error(`GitHub installation-token request failed (HTTP ${status ?? "?"})${detail}`);
	}
	const expiresAtMs = Date.parse(expiresAt);
	if (!token || !Number.isFinite(expiresAtMs)) throw new Error("malformed installation-token response (missing token or expires_at)");
	return { token, expiresAtMs };
}

let cached: CachedToken | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let failureReported = false;
let appAuth: AppAuth | null = null;

function scheduleRefresh(config: GitHubAppConfig, atMs: number): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => void refresh(config), Math.max(atMs - Date.now(), 0));
	refreshTimer.unref();
}

async function refresh(config: GitHubAppConfig): Promise<void> {
	try {
		cached = await fetchInstallationToken(appAuth!, config);
		failureReported = false;
		scheduleRefresh(config, cached.expiresAtMs - REFRESH_MARGIN_MS);
	} catch (err) {
		if (!failureReported) {
			failureReported = true;
			console.error(`pi-github-app: ${err instanceof Error ? err.message : String(err)} — will retry; agent git/gh commands will fail rather than use personal credentials`);
		}
		scheduleRefresh(config, Date.now() + REFRESH_RETRY_MS);
	}
}

/** The cached token, but never in its final minute (refresh has 5 min of runway). */
function currentToken(): string | null {
	if (!cached || Date.now() >= cached.expiresAtMs - SERVE_MARGIN_MS) return null;
	return cached.token;
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

function agentEnv(env: NodeJS.ProcessEnv, token: string | null, countersinks: Array<[string, string]> = []): NodeJS.ProcessEnv {
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
	// Fail loudly rather than ever using personal SSH keys for GitHub hosts.
	next.GIT_SSH_COMMAND = GIT_SSH_GUARD;
	return next;
}

/** First whitespace-separated token of raw command args ("" when blank). */
function parseSubcommand(args: string): string {
	return args.trim().split(/\s+/)[0] ?? "";
}

export default function piGithubAppAuth(pi: ExtensionAPI): void {
	const { config, error } = readConfig();
	if (error) {
		// Invalid/incomplete config: stay inert — never break the user's session.
		console.error(`pi-github-app: ${error} — staying inactive; agent git/gh run with your normal credentials (see /github-app-auth status)`);
	}
	// Computed once at load (regenerated on /reload); the SSH guard covers drift.
	const countersinks = config ? githubCountersinks() : [];
	if (config) {
		appAuth = createAuth(config.clientId, config.privateKey);
		void refresh(config); // token ready long before the agent's first bash call
	}

	// Only override bash when fully configured; otherwise stay inert so agent
	// commands behave exactly as if the extension were not installed.
	if (config) {
		const bashTool = createBashToolDefinition(process.cwd(), {
			spawnHook: ({ command, cwd, env }) => ({
				command,
				cwd,
				env: agentEnv(env, config ? currentToken() : null, countersinks),
			}),
		});

		pi.registerTool(bashTool);
	}

	pi.registerCommand("github-app-auth", {
		description: "GitHub App auth for agent bash — subcommands: status (no secrets)",
		handler: async (args, ctx) => {
			const sub = parseSubcommand(args);
			if (sub && sub !== "status" && sub !== "help") {
				ctx.ui.notify(`github-app-auth: unknown subcommand "${sub}" — try /github-app-auth status`, "warning");
				return;
			}
			const token = config ? currentToken() : null;
			const expiry = cached ? new Date(cached.expiresAtMs).toLocaleTimeString() : "—";
			ctx.ui.notify(
				[
					config ? "github-app-auth: active (agent bash authenticates as the GitHub App)" : `github-app-auth: NOT active — ${error ?? "not configured"}`,
					token ? `installation token: cached in memory, expires ${expiry}` : "installation token: not available right now",
					"agent bash env: GH_TOKEN + ephemeral git config (credential helper, SSH->HTTPS insteadOf + SSH guard); PI_GITHUB_APP_* removed",
				].join("\n"),
				config && token ? "info" : "warning",
			);
		},
	});
}

// Exposed for self-check scripts only; pi itself only uses the default export.
export const _internals = { agentEnv, githubSshHosts, githubCountersinks, readConfig, createAuth, fetchInstallationToken, parseSubcommand, GITHUB_CREDENTIAL_HELPER, GH_SENTINEL };
