/** Token-free gh launcher used only on the overridden agent bash PATH. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export function installGhGuard(dir: string, realGh: string, bot: string, token: string | null): void {
	const script = join(dirname(fileURLToPath(import.meta.url)), "gh-guard.ts");
	// Only the token's digest is written; the credential stays in the child env.
	writeFileSync(join(dir, "gh"), `#!/bin/sh\nexec ${[process.execPath, script, realGh, bot, token ? tokenDigest(token) : ""].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
}

/** Never include response bodies or fetch/CLI exceptions in auth diagnostics. */
export async function githubJson(path: string, token: string, apiBase = "https://api.github.com"): Promise<any> {
	let response: Response;
	try {
		response = await fetch(`${apiBase}${path}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-github-app-auth", "X-GitHub-Api-Version": "2022-11-28" },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("GitHub authentication/identity check unavailable; no personal credential fallback");
	}
	if (!response.ok) throw new Error(`GitHub authentication/identity check failed (HTTP ${response.status}); no personal credential fallback`);
	try { return await response.json(); }
	catch { throw new Error("GitHub returned an invalid identity response"); }
}

export async function guardedGh(realGh: string, bot: string, digest: string, args: string[], apiBase = "https://api.github.com"): Promise<number> {
	const token = process.env.GH_TOKEN;
	if (!token || !digest || !bot || tokenDigest(token) !== digest) {
		throw new Error("App credentials missing or replaced in agent bash; run /github-app-auth setup or /reload. Personal gh credentials are not allowed");
	}
	if (process.env.GH_HOST && process.env.GH_HOST !== "github.com") throw new Error("Only github.com is supported in protected agent bash");
	// This endpoint accepts installation tokens, not a user PAT or gh auth login.
	await githubJson("/installation/repositories?per_page=1", token, apiBase);
	const configDir = mkdtempSync(join(tmpdir(), "pi-github-app-gh-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: configDir };
		delete env.GH_DEBUG;
		delete env.GITHUB_TOKEN;
		// An alternate host must fail, not consult a personal enterprise login.
		env.GH_ENTERPRISE_TOKEN = "pi-github-app-unavailable";
		delete env.GITHUB_ENTERPRISE_TOKEN;
		delete env.GH_FORCE_TTY;
		const createsPr = args.some((arg, i) => arg === "pr" && args[i + 1] === "create");
		if (!createsPr) {
			const result = spawnSync(realGh, args, { env, stdio: "inherit" });
			if (result.error) throw new Error("Could not execute gh");
			return result.status ?? 1;
		}
		let repo: string | undefined;
		let help = false;
		const values = new Set(["--repo", "-R", "--assignee", "-a", "--attach", "--base", "-B", "--body", "-b", "--body-file", "-F", "--head", "-H", "--label", "-l", "--milestone", "-m", "--project", "-p", "--recover", "--reviewer", "-r", "--template", "-T", "--title", "-t"]);
		const booleans = new Set(["--draft", "-d", "--fill", "-f", "--fill-first", "--fill-verbose", "--no-maintainer-edit"]);
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "pr" || arg === "create") continue;
			const key = arg.split("=")[0];
			if (key === "--web" || key === "-w" || key === "--dry-run" || key === "--editor" || key === "-e") throw new Error("Browser/dry-run/editor PR creation is not supported; supply --title and --body/--body-file");
			if (arg === "--help") { help = true; continue; }
			if (values.has(key)) {
				const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
				if (key === "--repo" || key === "-R") repo = value;
			} else if (arg.startsWith("-R") && arg.length > 2) repo = arg.slice(2);
			else if (!booleans.has(key)) throw new Error("Unsupported gh pr create argument form; use separate flags and values (no PR created)");
		}
		if (help) return spawnSync(realGh, args, { env, stdio: "inherit" }).status ?? 1;
		const target = spawnSync(realGh, ["repo", "view", ...(repo ? [repo] : []), "--json", "url", "--jq", ".url"], { env, encoding: "utf8" });
		if (target.status !== 0 || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\s*$/.test(target.stdout ?? "")) {
			throw new Error("Cannot verify a github.com target repository; PR creation blocked");
		}
		const repoUrl = target.stdout.trim();
		const result = spawnSync(realGh, args, { env, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
		if (result.error) throw new Error("Could not execute gh pr create; check GitHub before retrying");
		if (result.status !== 0) {
			process.stdout.write(result.stdout ?? "");
			return result.status ?? 1;
		}
		const urls = result.stdout.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g) ?? [];
		const url = urls.at(-1);
		if (!url || !url.startsWith(`${repoUrl}/pull/`)) throw new Error("INVARIANT: gh returned no verifiable PR URL; check GitHub before retrying");
		const path = new URL(url).pathname.replace(/\/pull\//, "/pulls/");
		let pr: any;
		try { pr = await githubJson(`/repos${path}`, token, apiBase); }
		catch { throw new Error(`INVARIANT: PR may exist at ${url}, but author verification failed; do not retry blindly`); }
		if (pr?.user?.login !== bot || pr?.user?.type !== "Bot") {
			throw new Error(`INVARIANT: unexpected PR author at ${url}; expected ${bot}. PR authors are immutable; stop and investigate`);
		}
		process.stdout.write(result.stdout);
		return 0;
	} finally { rmSync(configDir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [realGh, bot, digest, ...args] = process.argv.slice(2);
	try { process.exitCode = await guardedGh(realGh, bot, digest, args); }
	catch (err) {
		console.error(`pi-github-app: ${err instanceof Error ? err.message : "gh guard failed"}`);
		process.exitCode = 1;
	}
}
