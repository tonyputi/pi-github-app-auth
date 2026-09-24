#!/usr/bin/env node
/**
 * pi-github-app-auth setup — assisted GitHub App creation via App Manifest.
 *
 * Turns the manual setup (create App, set permissions, generate key, install,
 * copy two ids) into: one command + creating the App in the browser + one
 * install click. App authentication via @octokit/auth-app (GitHub-maintained);
 * everything else is Node built-ins.
 *
 * Flow:
 *   1. Serves the auto-submitting manifest form on 127.0.0.1 (ephemeral port,
 *      no secrets in it) that pre-fills everything but the name, plus a
 *      one-shot callback that captures the single-use manifest `code`.
 *   2. You pick a (globally unique) App name and press Create in the browser.
 *      GitHub redirects to the local callback with a single-use `code`.
 *   3. The code is exchanged via POST /app-manifests/{code}/conversions for
 *      the App id/slug, client_id and PEM private key.
 *   4. Opens the App install page; polls GET /app/installations with a fresh
 *      in-memory JWT until the installation appears (or you pick one).
 *   5. Prints an `.envrc` block (or appends it with `--envrc <path>`).
 *
 * If PI_GITHUB_APP_CLIENT_ID and PI_GITHUB_APP_PRIVATE_KEY are already set
 * (e.g. you only lost the installation id), creation is skipped and the
 * command goes straight to step 4.
 *
 * Secrets discipline: the PEM and JWTs live in memory only and are never
 * logged. The PEM is emitted exactly once — into your terminal (or your
 * chosen file) so you can store it — and never into logs or errors.
 */

import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAppAuth } from "@octokit/auth-app";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const GITHUB_API = "https://api.github.com";
const REPO_URL = "https://github.com/tonyputi/pi-github-app-auth";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_POLL_MS = 5 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

interface SetupArgs {
	org?: string;
	envrcPath?: string;
	help?: boolean;
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

/** Parse `code` out of a callback request target (null when absent). */
function callbackCode(target: string | undefined): string | null {
	if (!target) return null;
	const q = target.indexOf("?");
	if (q === -1) return null;
	const code = new URLSearchParams(target.slice(q + 1)).get("code")?.trim();
	return code ? code : null;
}

/** Decide how to resolve the installation id from what the API lists. */
function selectInstallation(
	installations: InstallationRef[],
): { kind: "none" } | { kind: "single"; id: number } | { kind: "choose"; options: InstallationRef[] } {
	if (installations.length === 0) return { kind: "none" };
	if (installations.length === 1) return { kind: "single", id: installations[0].id };
	return { kind: "choose", options: installations };
}

/** Tolerate PEM keys whose newlines were escaped as literal "\n". */
function normalizePem(key: string): string {
	return key.includes("\\n") && !key.includes("\n") ? key.replace(/\\n/g, "\n") : key;
}

type AppAuth = ReturnType<typeof createAppAuth>;

/** App auth instance (JWT `iss` = client id — accepted by GitHub, see index.ts). */
function createAuth(clientId: string, privateKey: string): AppAuth {
	return createAppAuth({ appId: clientId, privateKey });
}

/** Manifest creation endpoint + pre-filled payload for the agent's needs. */
function manifestInput(port: number, org?: string): ManifestInput {
	const action = org
		? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	return {
		action,
		manifest: {
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
		},
	};
}

/** Auto-submitting form page (written to a temp file and opened). No secrets. */
function manifestFormHtml(action: string, manifest: Record<string, unknown>): string {
	const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<!doctype html><html><body><form id="f" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"></form><script>document.getElementById("f").submit()</script></body></html>`;
}

/** `.envrc` block for direnv (placeholder-free, ready to store). */
function formatEnvrc(clientId: string, installationId: string, privateKey: string): string {
	return [
		`export PI_GITHUB_APP_CLIENT_ID="${clientId}"`,
		`export PI_GITHUB_APP_INSTALLATION_ID="${installationId}"`,
		`export PI_GITHUB_APP_PRIVATE_KEY="${privateKey}"`,
	].join("\n");
}

const USAGE = `pi-github-app-auth setup — create the GitHub App via manifest, install it, emit .envrc

Usage: pi-github-app-auth-setup [--org <name>] [--envrc <path>]

  --org <name>    create the App under an organization instead of your account
  --envrc <path>  append the export block to <path> instead of only printing it
  -h, --help      this text

With PI_GITHUB_APP_CLIENT_ID + PI_GITHUB_APP_PRIVATE_KEY already set, App
creation is skipped and only the installation id is resolved.`;

function parseArgs(argv: string[]): SetupArgs {
	const args: SetupArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--org") {
			const v = argv[++i];
			if (!v) throw new Error("missing value for --org\n\n" + USAGE);
			args.org = v;
		} else if (a === "--envrc") {
			const v = argv[++i];
			if (!v) throw new Error("missing value for --envrc\n\n" + USAGE);
			args.envrcPath = v;
		} else if (a === "-h" || a === "--help") {
			args.help = true;
		} else {
			throw new Error(`unknown argument "${a}"\n\n${USAGE}`);
		}
	}
	return args;
}

function openBrowser(target: string): void {
	const [cmd, cmdArgs] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", target]]
				: ["xdg-open", [target]];
	execFile(cmd, cmdArgs, (err) => {
		if (err) console.log(`Open this URL manually:\n${target}`);
	});
}

function prompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return rl.question(question).finally(() => rl.close());
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
function createSetupServer(): {
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
				res.writeHead(200, { "content-type": "text/html" }).end("<h1>App created — back to the terminal.</h1>");
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
				() => fail(new Error("timed out waiting for the GitHub redirect (5 min) — re-run and complete the form faster")),
				CALLBACK_TIMEOUT_MS,
			);
			timer.unref();
			void code.finally(() => clearTimeout(timer));
			return code;
		},
	};
}

interface Conversion {
	slug: string;
	clientId: string;
	pem: string;
}

async function exchangeCode(code: string, apiBase: string = GITHUB_API): Promise<Conversion> {
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

async function listInstallations(auth: AppAuth, apiBase: string = GITHUB_API): Promise<InstallationRef[]> {
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

async function resolveInstallationId(
	clientId: string,
	privateKey: string,
	slug: string,
	apiBase: string = GITHUB_API,
): Promise<string> {
	console.log(`\nInstall the App, then it is detected automatically:\nhttps://github.com/apps/${slug}/installations/new`);
	openBrowser(`https://github.com/apps/${slug}/installations/new`);
	const deadline = Date.now() + INSTALL_TIMEOUT_MS;
	const auth = createAuth(clientId, privateKey);
	for (;;) {
		const found = await listInstallations(auth, apiBase).catch(() => [] as InstallationRef[]);
		const sel = selectInstallation(found);
		if (sel.kind === "single") return String(sel.id);
		if (sel.kind === "choose") {
			console.log("\nSeveral installations found:");
			for (const [i, o] of sel.options.entries()) console.log(`  ${i + 1}. ${o.login} (id ${o.id})`);
			const pick = await prompt("Pick one [1]: ");
			const n = pick.trim() === "" ? 1 : Number.parseInt(pick.trim(), 10);
			const chosen = sel.options[n - 1];
			if (!chosen) throw new Error("invalid choice — re-run and pick a listed number");
			return String(chosen.id);
		}
		if (Date.now() >= deadline) throw new Error("no installation appeared within 3 minutes — install the App, then re-run");
		console.log("Waiting for the installation… (complete it in the browser)");
		await new Promise((r) => setTimeout(r, INSTALL_POLL_MS));
	}
}

/** The setup CLI runs standalone under plain node, which strips types natively since 22.18. */
function checkNodeVersion(version: string): void {
	const [major, minor] = version.split(".").map(Number);
	if (!Number.isInteger(major) || major < 22 || (major === 22 && (!Number.isInteger(minor) || minor < 18))) {
		throw new Error(`node ${version} is too old — setup needs node >= 22.18 (native type stripping)`);
	}
}

async function main(argv: string[]): Promise<void> {
	checkNodeVersion(process.versions.node);
	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return;
	}
	const fromEnv =
		process.env.PI_GITHUB_APP_CLIENT_ID?.trim() && process.env.PI_GITHUB_APP_PRIVATE_KEY?.trim()
		? {
				clientId: process.env.PI_GITHUB_APP_CLIENT_ID!.trim(),
				privateKey: normalizePem(process.env.PI_GITHUB_APP_PRIVATE_KEY!.trim()),
			}
		: null;

	let clientId: string;
	let privateKey: string;
	if (fromEnv) {
		console.log("App credentials found in the environment — skipping creation.");
		({ clientId, privateKey } = fromEnv);
	} else {
		const setup = createSetupServer();
		await new Promise<void>((resolve, reject) => {
			setup.server.once("error", reject);
			setup.server.listen(0, "127.0.0.1", () => resolve());
		});
		const port = (setup.server.address() as { port: number }).port;
		let conversion: Conversion;
		try {
			const { action, manifest } = manifestInput(port, args.org);
			setup.setFormHtml(manifestFormHtml(action, manifest));
			console.log("Opening the GitHub App form (pre-filled) — pick a unique name and press Create.");
			openBrowser(`http://127.0.0.1:${port}/`);
			conversion = await exchangeCode(await setup.waitForCode());
			console.log("App created.");
		} finally {
			setup.server.close();
		}
		clientId = conversion!.clientId;
		privateKey = conversion!.pem;
		const installationId = await resolveInstallationId(clientId, privateKey, conversion!.slug);
		emit(clientId, installationId, privateKey, args.envrcPath);
		return;
	}
	// Existing-App path: installation id is the only missing piece.
	const auth = createAuth(clientId, privateKey);
	const found = await listInstallations(auth);
	const sel = selectInstallation(found);
	if (sel.kind === "none") throw new Error("the App has no installations — install it on an account first, then re-run");
	if (sel.kind === "single") {
		emit(clientId, String(sel.id), privateKey, args.envrcPath);
		return;
	}
	console.log("Several installations found:");
	for (const [i, o] of sel.options.entries()) console.log(`  ${i + 1}. ${o.login} (id ${o.id})`);
	const pick = await prompt("Pick one [1]: ");
	const n = pick.trim() === "" ? 1 : Number.parseInt(pick.trim(), 10);
	const chosen = sel.options[n - 1];
	if (!chosen) throw new Error("invalid choice — re-run and pick a listed number");
	emit(clientId, String(chosen.id), privateKey, args.envrcPath);
}

function emit(clientId: string, installationId: string, privateKey: string, envrcPath?: string): void {
	const block = formatEnvrc(clientId, installationId, privateKey);
	if (envrcPath) {
		appendFileSync(envrcPath, (needsLeadingNewline(envrcPath) ? "\n" : "") + block + "\n", { mode: 0o600 });
		console.log(`\nAppended to ${envrcPath}. Reload direnv, restart Pi, then run /github-app-auth status.`);
	} else {
		console.log(`\nStore this block (e.g. in .envrc via direnv):\n\n${block}\n\nThen reload direnv, restart Pi, and run /github-app-auth status.`);
	}
}

function needsLeadingNewline(path: string): boolean {
	// Appending blindly is fine — direnv tolerates a blank line; a missing
	// newline would glue our first export onto the previous line.
	try {
		const tail = readFileSync(path, "utf8").slice(-1);
		return tail !== "" && tail !== "\n";
	} catch {
		return false;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	await main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(`pi-github-app-auth setup: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}

// Exposed for self-check scripts only.
export const _setupInternals = {
	parseArgs,
	callbackCode,
	selectInstallation,
	normalizePem,
	manifestInput,
	manifestFormHtml,
	formatEnvrc,
	createAuth,
	checkNodeVersion,
	createSetupServer,
	exchangeCode,
	listInstallations,
	USAGE,
};
