/** Opt-in live release gate. Mutates ONLY the dedicated private E2E repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth, readConfig } from "./setup.ts";

/** Minimal App-identity lookup for this gate only; no guard machinery needed. */
async function githubJson(path: string, token: string): Promise<any> {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-github-app-auth-live-test", "X-GitHub-Api-Version": "2022-11-28" },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`GitHub identity check failed (HTTP ${response.status})`);
	return response.json();
}

assert.equal(process.env.PI_GITHUB_APP_AUTH_LIVE_TEST, "1", "Explicit opt-in required: PI_GITHUB_APP_AUTH_LIVE_TEST=1 npm run test:live");
const repo = "tonyputi/pi-github-app-auth-e2e";
const root = dirname(fileURLToPath(import.meta.url));
// Use the installed peer's CLI, not an unrelated older `pi` earlier on PATH.
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const evidenceDir = mkdtempSync(join(tmpdir(), "pi-github-app-live-"));
const { config } = readConfig();
assert.ok(config, "A configured App is required");
const auth = createAuth(config.clientId, config.privateKey);
const jwt = await auth({ type: "app" });
const app = await githubJson("/app", jwt.token);
const { token } = await auth({ type: "installation", installationId: config.installationId });
const bot = `${app.slug}[bot]`;

// Deliberately personal parent CLI. The agent children must replace these creds.
function humanApi(path: string, method = "GET", body?: object): any {
	const result = spawnSync("gh", ["api", path, "--method", method, ...(body ? ["--input", "-"] : [])], { input: body ? JSON.stringify(body) : undefined, encoding: "utf8" });
	assert.equal(result.status, 0, `Human API ${method} ${path} failed; credentials are not printed`);
	return result.stdout ? JSON.parse(result.stdout) : undefined;
}
const human = humanApi("user").login;
assert.ok(human && !human.endsWith("[bot]"), "Run this gate from a deliberate human shell, not protected agent bash");
const repository = humanApi(`repos/${repo}`);
assert.equal(repository.private, true, "E2E repository must be private");
assert.equal(repository.full_name, repo);
const base = repository.default_branch;
const main = await githubJson(`/repos/${repo}/git/ref/heads/${base}`, token);
const stamp = Date.now();
const branches = [`auth-positive-${stamp}`, `auth-negative-${stamp}`];
async function appMutation(path: string, method: string, data?: object): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
			method, redirect: "error", signal: AbortSignal.timeout(15_000),
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-github-app-auth-live-test" },
			body: data ? JSON.stringify(data) : undefined,
		});
	} catch { throw new Error("Dedicated test repository API unavailable; inspect test refs before retrying"); }
	assert.ok(response.ok, `Dedicated test repository ${method} ${path} failed (HTTP ${response.status})`);
}
for (const branch of branches) {
	await appMutation("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: main.object.sha });
	await appMutation("contents/auth-acceptance.txt", "PUT", { branch, message: "test: PR identity acceptance fixture", content: Buffer.from(`Identity acceptance ${branch}\n`).toString("base64") });
}
function runAgent(branch: string, invalid: boolean): { session: string; toolError: boolean } {
	const command = `gh pr create --repo ${repo} --head ${branch} --base ${base} --title 'GitHub App identity acceptance test' --body 'Dedicated acceptance test for pi-github-app-auth issue 29. Safe to close after native human Request changes verification.'`;
	const prompt = `This is a bounded live acceptance test in a dedicated private test repository, explicitly authorized by the user. Execute EXACTLY ONE bash tool call with this exact command, then report the result. Do not inspect files, read credentials, change authentication, retry or bypass a failure. Command:\n${command}`;
	const env = { ...process.env };
	if (invalid) env.PI_GITHUB_APP_PRIVATE_KEY = "invalid-for-negative-acceptance-test";
	const result = spawnSync(process.execPath, [cli, "--no-extensions", "--extension", join(root, "index.ts"), "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--no-session", "--tools", "bash", "--thinking", "minimal", "--mode", "json", prompt], {
		cwd: evidenceDir, env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
	});
	const name = invalid ? "negative" : "positive";
	writeFileSync(join(evidenceDir, `${name}.jsonl`), result.stdout ?? "", { mode: 0o600 });
	writeFileSync(join(evidenceDir, `${name}.stderr`), result.stderr ?? "", { mode: 0o600 });
	assert.equal(result.status, 0, `Pi ${name} failed; inspect ${evidenceDir}`);
	const events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const starts = events.filter((e) => e.type === "tool_execution_start");
	assert.equal(starts.length, 1, `Pi ${name} must execute exactly one real tool call; inspect ${evidenceDir}`);
	assert.equal(starts[0].toolName, "bash");
	assert.equal(starts[0].args.command, command);
	const end = events.find((e) => e.type === "tool_execution_end");
	assert.ok(end, `Missing tool completion; inspect ${evidenceDir}`);
	assert.equal(end.isError, invalid, `Unexpected tool result; inspect ${evidenceDir}`);
	return { session: events.find((e) => e.type === "session")?.id, toolError: end.isError };
}
// Negative first: personal credentials are still present in the child environment.
const negative = runAgent(branches[1], true);
const unwanted = humanApi(`repos/${repo}/pulls?state=all&head=tonyputi:${branches[1]}`);
assert.equal(unwanted.length, 0, "FAIL CLOSED: no PR may exist for the negative branch");
console.log("PASS negative real Pi session: invalid App auth, personal creds present, no PR created");
const positive = runAgent(branches[0], false);
const created = humanApi(`repos/${repo}/pulls?state=open&head=tonyputi:${branches[0]}`);
assert.equal(created.length, 1);
const pr = created[0];
assert.equal(pr.user.login, bot);
assert.equal(pr.user.type, "Bot");
const review = humanApi(`repos/${repo}/pulls/${pr.number}/reviews`, "POST", { event: "REQUEST_CHANGES", body: "Live identity acceptance: the launching human can submit native Request changes on this App-authored PR." });
const recorded = humanApi(`repos/${repo}/pulls/${pr.number}/reviews/${review.id}`);
assert.equal(recorded.user.login, human);
assert.equal(recorded.state, "CHANGES_REQUESTED");
const evidence = { verifiedAt: new Date().toISOString(), repo, pr: pr.html_url, prAuthor: pr.user.login, human, reviewId: review.id, reviewState: recorded.state, negativePrCount: unwanted.length, positive, negative };
writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
// Clean up only after every identity/review/negative assertion succeeded.
humanApi(`repos/${repo}/pulls/${pr.number}`, "PATCH", { state: "closed" });
for (const branch of branches) await appMutation(`git/refs/heads/${branch}`, "DELETE");
console.log(`PASS live release gate; test PR closed, test branches deleted. Evidence: ${evidenceDir}`);
