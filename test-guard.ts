/** Offline regressions for PR identity, including the actual registered bash. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { _internals } from "./index.ts";
import { guardedGh, tokenDigest } from "./gh-guard.ts";

const dir = mkdtempSync(join(tmpdir(), "gh-pr-regression-"));
const keepEnv = { ...process.env };
const keepFetch = globalThis.fetch;
const gh = join(dir, "gh");
const log = join(dir, "calls.jsonl");
const marker = join(dir, "created");
const token = "test-installation-token";
const bot = "test-app[bot]";
const prUrl = "https://github.com/test-owner/safe-test/pull/42";
writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if(fs.existsSync(process.env.GH_CONFIG_DIR+'/hosts.yml')) throw new Error('personal gh config consulted');
if(process.env.GH_ENTERPRISE_TOKEN !== 'pi-github-app-unavailable') throw new Error('enterprise fallback not blocked');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0]==='repo') console.log(process.env.TEST_TARGET || 'https://github.com/test-owner/safe-test');
else if(args[0]==='pr' && args[1]==='create') {
 fs.writeFileSync(${JSON.stringify(marker)}, 'created');
 console.log(${JSON.stringify(prUrl)});
} else console.log('gh-ok');
`, { mode: 0o700 });
let checks: string[] = [];
let apiStatus = 200;
let author = bot;
let authorType = "Bot";
const mockFetch: typeof fetch = async (input, init) => {
	const url = String(input);
	checks.push(new URL(url).pathname);
	const authorization = new Headers(init?.headers).get("Authorization");
	if (url.includes("/installation/repositories") || url.includes("/pulls/")) {
		assert.equal(authorization, `Bearer ${token}`, "actual credential is the App token, never personal gh auth");
	}
	let data: unknown = {};
	if (url.endsWith("/access_tokens")) data = { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
	else if (url.endsWith("/app")) data = { slug: "test-app" };
	else if (url.includes("/users/")) data = { id: 99 };
	else if (url.includes("/pulls/")) data = { user: { login: author, type: authorType } };
	return new Response(JSON.stringify(data), { status: apiStatus, headers: { "content-type": "application/json" } });
};
async function bashFailure(result: Promise<any>, pattern: RegExp): Promise<void> {
	const value = await result;
	assert.equal(value.isError, true);
	assert.match(value.content[0].text, pattern);
}
const reset = () => {
	checks = []; apiStatus = 200; author = bot; authorType = "Bot";
	rmSync(marker, { force: true }); rmSync(log, { force: true });
	process.env.GH_TOKEN = token;
	process.env.GH_HOST = "github.com";
	delete process.env.TEST_TARGET;
};
try {
	globalThis.fetch = mockFetch;
	process.env.GITHUB_TOKEN = "personal-pat";
	process.env.GH_CONFIG_DIR = dir;
	writeFileSync(join(dir, "hosts.yml"), "github.com:\n    oauth_token: personal-gh-auth\n    user: human\n");
	reset();
	assert.equal(await guardedGh(gh, bot, tokenDigest(token), ["pr", "create", "--title", "test", "--body", "test"]), 0);
	assert.ok(existsSync(marker));
	assert.deepEqual(checks, ["/installation/repositories", "/repos/test-owner/safe-test/pulls/42"], "identity checked before and after creation");
	console.log("ok PR installation-token preflight + actual bot author postcondition with personal credentials present");
	reset();
	assert.equal(await guardedGh(gh, bot, tokenDigest(token), ["pr", "create", "--repo", "test-owner/safe-test", "--body", "--repo=enterprise.example/owner/repo", "--title", "--web"]), 0, "flag-looking body/title values must not change repo or invoke a browser");
	const targetArgs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
	assert.equal(targetArgs[2], "test-owner/safe-test");
	assert.ok(existsSync(join(dir, "hosts.yml")), "personal gh credential store is untouched");

	for (const bad of [undefined, "personal-pat", "pi-github-app-unavailable"]) {
		reset();
		if (bad === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = bad;
		await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), /credentials missing or replaced/);
		assert.ok(!existsSync(log) && !existsSync(marker), "real gh never starts with missing/replaced credentials");
	}
	for (const status of [401, 403, 500]) {
		reset(); apiStatus = status;
		await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), /identity check failed/);
		assert.ok(!existsSync(log) && !existsSync(marker), "expired, rejected or unavailable token cannot create a PR");
	}
	reset();
	globalThis.fetch = async () => { throw new Error(`request with secret ${token}`); };
	await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), (err: Error) => !err.message.includes(token) && /unavailable/.test(err.message));
	assert.ok(!existsSync(marker));
	globalThis.fetch = mockFetch;
	for (const expiresAt of [undefined, "nonsense", new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 1000).toISOString()]) {
		const fakeAuth = (async () => ({ token, expiresAt })) as unknown as Parameters<typeof _internals.fetchInstallationToken>[0];
		await assert.rejects(_internals.fetchInstallationToken(fakeAuth, { clientId: "x", installationId: "123", privateKey: "unused" }), /expired or too close/);
	}
	const failingAuth = (async () => { throw new Error(`request contains ${token}`); }) as unknown as Parameters<typeof _internals.fetchInstallationToken>[0];
	await assert.rejects(_internals.fetchInstallationToken(failingAuth, { clientId: "x", installationId: "123", privateKey: "unused" }), (err: Error) => !err.message.includes(token));
	console.log("ok missing/replaced/expired/unavailable credentials fail before gh creation, without leaking errors");

	for (const wrong of ["human", "other-app[bot]"]) {
		reset(); author = wrong;
		await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), /INVARIANT: unexpected PR author/);
		assert.ok(existsSync(marker), "postcondition reports the immutable PR, never pretends it was prevented");
	}
	reset();
	globalThis.fetch = async (input, init) => {
		if (String(input).includes("/pulls/")) throw new Error("network down after creation");
		return mockFetch(input, init);
	};
	await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), /PR may exist.*do not retry blindly/);
	assert.ok(existsSync(marker));
	globalThis.fetch = mockFetch;
	reset(); authorType = "User";
	await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create"]), /unexpected PR author/);
	reset(); process.env.TEST_TARGET = "https://enterprise.example/owner/repo";
	await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create", "-R", "enterprise.example/owner/repo"]), /target repository/);
	assert.ok(!existsSync(marker));
	for (const arg of ["--web", "--web=true", "-w", "-w=true", "--dry-run", "--dry-run=true"]) {
		reset();
		await assert.rejects(guardedGh(gh, bot, tokenDigest(token), ["pr", "create", arg]), /not supported/);
		assert.ok(!existsSync(marker));
	}
	console.log("ok wrong PR authors are invariant failures; unsupported hosts/browser creation blocked before mutation");

	// Child gh launcher uses its own process; keep its HTTP checks offline too.
	const preload = join(dir, "fetch-mock.mjs");
	writeFileSync(preload, `import fs from 'node:fs';
	globalThis.fetch = async (input, init) => {
	 const url = new URL(String(input));
	 if(init.headers.Authorization !== 'Bearer test-installation-token') throw new Error('wrong child credential');
	 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['api', url.pathname])+'\\n');
	 return new Response(JSON.stringify(url.pathname.includes('/pulls/') ? {user:{login:'test-app[bot]',type:'Bot'}} : {repositories:[]}), {status:200});
	};`);
	process.env.NODE_OPTIONS = `--import=${preload}`;
	process.env.PATH = `${dir}:${process.env.PATH}`;
	// Register the actual extension with missing, incomplete and malformed config.
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[credential]\n helper = !echo PERSONAL_HELPER >&2\n");
	const keys = ["PI_GITHUB_APP_CLIENT_ID", "PI_GITHUB_APP_INSTALLATION_ID", "PI_GITHUB_APP_PRIVATE_KEY"];
	for (const scenario of ["missing", "partial", "bad-key", "null-file", "auth-failure", "valid"]) {
		reset();
		for (const k of keys) delete process.env[k];
		rmSync(join(dir, "pi-github-app-auth.json"), { force: true });
		if (scenario === "partial") process.env.PI_GITHUB_APP_CLIENT_ID = "Iv1test";
		if (scenario === "null-file") writeFileSync(join(dir, "pi-github-app-auth.json"), "null");
		if (["bad-key", "auth-failure", "valid"].includes(scenario)) {
			process.env.PI_GITHUB_APP_CLIENT_ID = "Iv1test";
			process.env.PI_GITHUB_APP_INSTALLATION_ID = "123";
			process.env.PI_GITHUB_APP_PRIVATE_KEY = scenario === "bad-key" ? "not-a-key" : privateKey;
		}
		if (scenario === "auth-failure") apiStatus = 401;
		const tools: any[] = [];
		const events: Record<string, Function> = {};
		let command: any;
		extension({ getActiveTools: () => ["bash"], registerTool: (t: unknown) => tools.push(t), registerCommand: (_n: string, c: unknown) => { command = c; }, on: (n: string, h: Function) => { events[n] = h; } } as unknown as ExtensionAPI);
		assert.equal(tools.length, 1, `${scenario}: bash interception never silently disappears`);
		const ctx: any = { cwd: dir, model: undefined, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } };
		const envResult = await tools[0].execute("env", { command: "test -z \"$PI_GITHUB_APP_PRIVATE_KEY\" && printf '%s' \"$GH_TOKEN\"" }, undefined, undefined, ctx);
		const text = envResult.content[0].text;
		assert.equal(text, scenario === "valid" ? token : _internals.GH_SENTINEL);
		if (scenario === "valid") {
			const created = await tools[0].execute("create", { command: "gh pr create --repo test-owner/safe-test --title test --body test" }, undefined, undefined, ctx);
			assert.equal(created.content[0].text, `${prUrl}\n`);
			const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(calls.map((call) => call[0]), ["api", "repo", "pr", "api"], "registered agent bash verifies the actual spawned credential before gh creates and actual PR after");
			rmSync(log); rmSync(marker);
			await tools[0].execute("nested", { command: `node -e 'require("node:child_process").execFileSync("gh", ["pr", "create", "--repo=test-owner/safe-test", "--title", "test", "--body", "test"], {stdio:"inherit"})'` }, undefined, undefined, ctx);
			assert.ok(existsSync(marker), "subprocesses of the protected bash inherit the same gh guard");
			rmSync(marker);
			await bashFailure(tools[0].execute("override", { command: "GH_TOKEN=personal-pat gh pr create --title test --body test" }, undefined, undefined, ctx), /credentials missing or replaced/);
			assert.ok(!existsSync(marker));
		} else {
			await bashFailure(tools[0].execute("create", { command: "gh pr create --title test --body test" }, undefined, undefined, ctx), /App credentials missing/);
			const credential = await tools[0].execute("credential", { command: "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>&1; true" }, undefined, undefined, ctx);
			assert.ok(!credential.content[0].text.includes("PERSONAL_HELPER"), "personal git helper never consulted");
			await bashFailure(tools[0].execute("ssh", { command: "git ls-remote git@github.com:test-owner/safe-test.git" }, undefined, undefined, ctx), /exit|fatal/i);
		}
		let status = "";
		await command.handler("status", { ui: { notify: (s: string) => { status = s; } } });
		assert.match(status, /bash interception registered=yes/);
		assert.match(status, /bash tool active in model loadout: true/);
		assert.match(status, /NOT protected: external ctx_execute\/MCP/);
		assert.match(status, /manual shell: personal credentials/);
		assert.equal(events.tool_call({ toolName: "ctx_execute", input: { language: "python", code: "subprocess.run(['gh','pr','create','--repo','tonyputi/akrivia'])" } }).block, true, "actual #745 bypass is diagnosed/blocked, including nested tool calls");
		assert.equal(events.tool_call({ toolName: "mcp__github__create_pull_request", input: {} }).block, true);
		assert.equal(events.tool_call({ toolName: "ctx_execute", input: { code: "print(1)" } }), undefined);
		assert.equal(events.tool_call({ toolName: "bash", input: { command: "gh pr create" } }), undefined);
	}
	assert.equal(process.env.GITHUB_TOKEN, "personal-pat", "human environment never mutated by extension");
	console.log("ok registered bash remains isolated for missing/bad config and unavailable auth; bypass diagnostics and honest status");
} finally {
	globalThis.fetch = keepFetch;
	for (const key of Object.keys(process.env)) if (!(key in keepEnv)) delete process.env[key];
	Object.assign(process.env, keepEnv);
	rmSync(dir, { recursive: true, force: true });
}
console.log("all PR guard regression tests passed");
