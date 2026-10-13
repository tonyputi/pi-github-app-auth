/**
 * pi-github-app-auth setup — GitHub App manifest flow, run as a wizard inside
 * Pi (`/github-app-auth setup`) instead of a separate npm CLI.
 *
 * Flow (same GitHub flow the old CLI used, delivered in-process):
 *   1. A local HTTP server on 127.0.0.1 (ephemeral port, no secrets) serves an
 *      auto-submitting manifest form that pre-fills everything, name included.
 *   2. The browser opens the form; you press Create.
 *   3. GitHub redirects back with a single-use manifest `code`, exchanged via
 *      POST /app-manifests/{code}/conversions for slug, client_id and PEM key.
 *   4. The install page opens; installations are polled until the App is
 *      installed (or you pick one of several).
 *   5. Credentials are saved to <agent-dir>/pi-github-app-auth.json (0600),
 *      following the platform convention of auth.json / mcp-auth.json.
 *
 * Secrets discipline: the PEM lives in memory only until it is written once to
 * the credential file — never logged, never emitted to the environment. Env
 * vars (PI_GITHUB_APP_*) remain supported as a per-repo override but the file
 * is the recommended default: pi's own security guidance is to keep
 * credentials out of the environment when possible.
 */

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

const GITHUB_API = "https://api.github.com";
const REPO_URL = "https://github.com/tonyputi/pi-github-app-auth";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_POLL_MS = 5 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

export interface GitHubAppConfig {
	/** GitHub App client id — used as the JWT `iss` claim. */
	clientId: string;
	/** GitHub App installation id for the token exchange. */
	installationId: string;
	/** PEM private key of the GitHub App (real or escaped newlines). */
	privateKey: string;
}

export type AppAuth = ReturnType<typeof createAppAuth>;

/** Where the App was loaded from (env override wins over the credential file). */
export type ConfigSource = "env" | "file";

export interface ConfigResolution {
	config?: GitHubAppConfig;
	source?: ConfigSource;
	error?: string;
}

interface ManifestInput {
	/** Where the auto-submitting form POSTs. */
	action: string;
	/** Manifest payload (no secrets). */
	manifest: Record<string, unknown>;
}

interface InstallationRef {
	id: number;
	login: string;
}

interface Conversion {
	slug: string;
	clientId: string;
	pem: string;
}

// ---------------------------------------------------------------------------
// Credential store — same discipline as pi's own auth.json: 0600 file inside
// the agent directory, 0700 directory, modes applied only on creation so
// administrator-managed modes and ACLs remain intact.
// ---------------------------------------------------------------------------

/** <agent-dir>/pi-github-app-auth.json (PI_CODING_AGENT_DIR overrides the agent dir). */
export function credentialsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-github-app-auth.json");
}

/** Tolerate PEM keys whose newlines were escaped as literal "\n". */
export function normalizePem(key: string): string {
	return key.includes("\\n") && !key.includes("\n") ? key.replace(/\\n/g, "\n") : key;
}

function looksLikePem(key: string): boolean {
	return key.includes("BEGIN") && key.includes("PRIVATE KEY");
}

/** Read the credential file. Missing file -> inert; anything else broken -> error. */
export function loadStoredCredentials(): ConfigResolution {
	let text: string;
	try {
		text = readFileSync(credentialsPath(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: `could not read ${credentialsPath()} (${(err as Error).message})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: `${credentialsPath()} is not valid JSON` };
	}
	const o = parsed as Record<string, unknown>;
	const clientId = typeof o.clientId === "string" ? o.clientId.trim() : "";
	const installationId = typeof o.installationId === "string" ? o.installationId.trim() : "";
	const privateKey = typeof o.privateKey === "string" ? normalizePem(o.privateKey.trim()) : "";
	if (!clientId || !installationId || !privateKey) {
		return { error: `${credentialsPath()} is missing clientId / installationId / privateKey` };
	}
	if (!looksLikePem(privateKey)) return { error: `privateKey in ${credentialsPath()} does not look like a PEM private key` };
	return { config: { clientId, installationId, privateKey } };
}

/** Write the credential file (0600) and return its path. */
export function saveStoredCredentials(config: GitHubAppConfig): string {
	const path = credentialsPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(config, null, "\t") + "\n", { mode: 0o600 });
	return path;
}

/**
 * Resolve the App config: env vars (per-repo override, e.g. direnv) win over
 * the credential file. Missing pieces are reported, partial env configs are
 * errors (they are explicit user intent, unlike an absent file).
 */
export function readConfig(): ConfigResolution {
	const clientId = process.env.PI_GITHUB_APP_CLIENT_ID?.trim();
	const installationId = process.env.PI_GITHUB_APP_INSTALLATION_ID?.trim();
	const rawKey = process.env.PI_GITHUB_APP_PRIVATE_KEY?.trim();

	const present = [clientId, installationId, rawKey].filter((v) => v);
	if (present.length === 0) {
		// No env config -> the credential file.
		const fromFile = loadStoredCredentials();
		return fromFile.config ? { ...fromFile, source: "file" as const } : fromFile;
	}
	if (present.length < 3) {
		const missing = [
			!clientId && "PI_GITHUB_APP_CLIENT_ID",
			!installationId && "PI_GITHUB_APP_INSTALLATION_ID",
			!rawKey && "PI_GITHUB_APP_PRIVATE_KEY",
		].filter(Boolean);
		return { error: `incomplete environment configuration — missing ${missing.join(", ")}` };
	}
	const privateKey = normalizePem(rawKey!);
	if (!looksLikePem(privateKey)) return { error: "PI_GITHUB_APP_PRIVATE_KEY does not look like a PEM private key" };
	return { config: { clientId: clientId!, installationId: installationId!, privateKey }, source: "env" };
}

// ---------------------------------------------------------------------------
// Pure manifest-flow helpers (also exercised by test.ts)
// ---------------------------------------------------------------------------

/** App auth instance (JWT `iss` = client id — accepted by GitHub, see index.ts). */
export function createAuth(clientId: string, privateKey: string): AppAuth {
	return createAppAuth({ appId: clientId, privateKey });
}

/** Parse `code` out of a callback request target (null when absent). */
export function callbackCode(target: string | undefined): string | null {
	if (!target) return null;
	const q = target.indexOf("?");
	if (q === -1) return null;
	const code = new URLSearchParams(target.slice(q + 1)).get("code")?.trim();
	return code ? code : null;
}

/** Decide how to resolve the installation id from what the API lists. */
export function selectInstallation(
	installations: InstallationRef[],
): { kind: "none" } | { kind: "single"; id: number } | { kind: "choose"; options: InstallationRef[] } {
	if (installations.length === 0) return { kind: "none" };
	if (installations.length === 1) return { kind: "single", id: installations[0].id };
	return { kind: "choose", options: installations };
}

/** Suggested App name: hostname-based plus a random suffix for global uniqueness. */
export function defaultAppName(): string {
	const host = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
	const suffix = Math.random().toString(16).slice(2, 6);
	return `pi-agent-${host}-${suffix}`;
}

/** Manifest creation endpoint + pre-filled payload for the agent's needs. */
export function manifestInput(port: number, opts: { org?: string; name?: string } = {}): ManifestInput {
	const action = opts.org
		? `https://github.com/organizations/${encodeURIComponent(opts.org)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	const manifest: Record<string, unknown> = {
		url: REPO_URL,
		redirect_url: `http://127.0.0.1:${port}/callback`,
		public: false,
		description: "Authenticates Pi agent bash commands to GitHub as an App installation.",
		default_permissions: {
			contents: "write",
			issues: "write",
			pull_requests: "write",
			workflows: "write",
			metadata: "read",
		},
		default_events: [],
	};
	if (opts.name) manifest.name = opts.name;
	return { action, manifest };
}

/** Auto-submitting form page. No secrets. */
export function manifestFormHtml(action: string, manifest: Record<string, unknown>): string {
	const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<!doctype html><html><body><form id="f" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"></form><script>document.getElementById("f").submit()</script></body></html>`;
}

/** Best-effort browser open; `onFail` runs when no opener is available. */
export function openBrowser(target: string, onFail?: () => void): void {
	const [cmd, cmdArgs] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", target]]
				: ["xdg-open", [target]];
	execFile(cmd, cmdArgs, (err) => {
		if (err) onFail?.();
	});
}

/**
 * Local setup server: serves the auto-submitting manifest form at `/` and
 * captures the single-use manifest `code` at `/callback`.
 *
 * No `state` check on the callback: the only abuse is tricking your own
 * browser into linking someone else's fresh App to your environment — the
 * attacker gains nothing (it is their App) and the wrong slug is visible
 * immediately. Same trade-off as Probot's setup flow.
 */
export function createSetupServer(): {
	server: Server;
	setFormHtml: (html: string) => void;
	waitForCode: () => Promise<string>;
} {
	let form = "<h1>Loading GitHub App form…</h1>";
	let settled = false;
	let resolveCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const code = new Promise<string>((res, rej) => {
		resolveCode = res;
		rejectCode = rej;
	});
	// Swallow the "no listener" rejection path: waitForCode arms the timer.
	void code.catch(() => {});
	const fail = (err: Error): void => {
		if (!settled) {
			settled = true;
			rejectCode(err);
		}
	};
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const target = req.url ?? "/";
		if (target === "/" || target.startsWith("/?")) {
			res.writeHead(200, { "content-type": "text/html" }).end(form);
			return;
		}
		if (target.startsWith("/callback")) {
			const found = callbackCode(target);
			if (found && !settled) {
				settled = true;
				res.writeHead(200, { "content-type": "text/html" }).end("<h1>App created — back to Pi.</h1>");
				resolveCode(found);
				return;
			}
		}
		res.writeHead(404, { "content-type": "text/plain" }).end("not found");
	});
	server.on("error", fail);
	return {
		server,
		setFormHtml: (html: string): void => {
			form = html;
		},
		waitForCode: (): Promise<string> => {
			const timer = setTimeout(
				() => fail(new Error("timed out waiting for the GitHub redirect (5 min) — re-run /github-app-auth setup")),
				CALLBACK_TIMEOUT_MS,
			);
			timer.unref();
			void code.finally(() => clearTimeout(timer));
			return code;
		},
	};
}

function listenLocal(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve((server.address() as { port: number }).port);
		});
	});
}

export async function exchangeCode(code: string, apiBase: string = GITHUB_API): Promise<Conversion> {
	const res = await fetch(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
		method: "POST",
		headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-github-app-auth-setup" },
	});
	if (!res.ok) throw new Error("GitHub rejected the manifest code (expired or already used) — re-run the setup");
	const data = (await res.json()) as { id?: unknown; slug?: unknown; client_id?: unknown; pem?: unknown };
	if (typeof data.slug !== "string" || typeof data.client_id !== "string" || typeof data.pem !== "string") {
		throw new Error("unexpected GitHub response to the manifest conversion — re-run the setup");
	}
	return { slug: data.slug, clientId: data.client_id, pem: normalizePem(data.pem) };
}

export async function listInstallations(auth: AppAuth, apiBase: string = GITHUB_API): Promise<InstallationRef[]> {
	const { token } = (await auth({ type: "app" })) as { token: string };
	const res = await fetch(`${apiBase}/app/installations`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "pi-github-app-auth-setup",
		},
	});
	if (!res.ok) throw new Error(`could not list App installations (HTTP ${res.status}) — is the key right?`);
	const data = (await res.json()) as Array<{ id?: unknown; account?: { login?: unknown } }>;
	return data.flatMap((i) =>
		typeof i.id === "number" && typeof i.account?.login === "string" ? [{ id: i.id, login: i.account.login }] : [],
	);
}

// ---------------------------------------------------------------------------
// The wizard, as run by /github-app-auth setup
// ---------------------------------------------------------------------------

/** Minimal UI surface the wizard needs (structurally pi's ctx.ui). */
export interface WizardUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface WizardResult {
	/** Created App slug (also used in its install/URLs). */
	slug: string;
	/** Installation id that was detected/selected. */
	installationId: string;
	/** Path the credentials were saved to. */
	path: string;
}

function installationLabel(o: InstallationRef): string {
	return `${o.login} (id ${o.id})`;
}

/** Poll until exactly one installation exists, or let the user pick among several. */
async function pickInstallation(ui: WizardUI, auth: AppAuth): Promise<string> {
	const deadline = Date.now() + INSTALL_TIMEOUT_MS;
	for (;;) {
		const found = await listInstallations(auth).catch(() => [] as InstallationRef[]);
		if (found.length === 1) return String(found[0].id);
		if (found.length > 1) {
			const picked = await ui.select("github-app-auth — several installations found, pick one", found.map(installationLabel));
			if (picked === undefined) throw new Error("cancelled — nothing was saved; re-run /github-app-auth setup when ready");
			const chosen = found.find((o) => installationLabel(o) === picked);
			if (!chosen) throw new Error("invalid installation selection — re-run /github-app-auth setup");
			return String(chosen.id);
		}
		if (Date.now() >= deadline) {
			throw new Error("no installation appeared within 3 minutes — install the App, then re-run /github-app-auth setup");
		}
		await new Promise((r) => setTimeout(r, INSTALL_POLL_MS));
	}
}

async function cancelled(ui: WizardUI): Promise<null> {
	ui.notify("github-app-auth: setup cancelled.", "info");
	return null;
}

/**
 * The interactive setup flow. Throws on hard failures (caller surfaces them);
 * returns null when the user cancelled. Never touches the pi runtime itself —
 * activation (or a reload) is the caller's decision.
 */
export async function runSetupWizard(ui: WizardUI): Promise<WizardResult | null> {
	const scope = await ui.select("github-app-auth — where should the App live?", ["Personal account", "An organization"]);
	if (!scope) return cancelled(ui);
	let org: string | undefined;
	if (scope !== "Personal account") {
		org = (await ui.input("github-app-auth — organization login", "my-org"))?.trim();
		if (!org) return cancelled(ui);
	}
	const suggested = defaultAppName();
	const name = (await ui.input("github-app-auth — App name (must be unique on GitHub)", suggested))?.trim() || suggested;

	const setup = createSetupServer();
	let conversion: Conversion;
	try {
		const port = await listenLocal(setup.server);
		const { action, manifest } = manifestInput(port, { org, name });
		setup.setFormHtml(manifestFormHtml(action, manifest));
		const local = `http://127.0.0.1:${port}/`;
		ui.notify(`github-app-auth: opening the pre-filled App form ("${name}") — press Create. If no browser opens: ${local}`, "info");
		openBrowser(local, () => ui.notify(`github-app-auth: no browser available — open ${local} to continue.`, "warning"));
		conversion = await exchangeCode(await setup.waitForCode());
	} finally {
		setup.server.close();
	}

	ui.notify(`github-app-auth: App "${conversion.slug}" created — now install it (opening the page; waiting up to 3 min).`, "info");
	const installUrl = `https://github.com/apps/${conversion.slug}/installations/new`;
	openBrowser(installUrl, () => ui.notify(`github-app-auth: no browser available — open ${installUrl} to install the App.`, "warning"));
	const installationId = await pickInstallation(ui, createAuth(conversion.clientId, conversion.pem));

	const path = saveStoredCredentials({ clientId: conversion.clientId, installationId, privateKey: conversion.pem });
	return { slug: conversion.slug, installationId, path };
}

// Exposed for self-check scripts only; pi itself uses the wizard via index.ts.
export const _setupInternals = {
	callbackCode,
	selectInstallation,
	normalizePem,
	defaultAppName,
	manifestInput,
	manifestFormHtml,
	createAuth,
	createSetupServer,
	exchangeCode,
	listInstallations,
	loadStoredCredentials,
	saveStoredCredentials,
	credentialsPath,
	readConfig,
	runSetupWizard,
	openBrowser,
	environment: () => process.env, // test seam: PI_CODING_AGENT_DIR isolation
};
