/**
 * Self-check for the pure helpers exported via _internals. No framework, no
 * network: run with `npm test` (Node 22.18+ strips types natively).
 */
import assert from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internals } from "./index.ts";
import { _setupInternals } from "./setup.ts";

const { readConfig, createAuth, fetchInstallationToken, githubSshHosts, githubCountersinks, agentEnv, parseSubcommand, GITHUB_CREDENTIAL_HELPER, GH_SENTINEL } = _internals;

// --- readConfig -----------------------------------------------------------
{
	const keep: Array<[string, string | undefined]> = ["PI_GITHUB_APP_CLIENT_ID", "PI_GITHUB_APP_INSTALLATION_ID", "PI_GITHUB_APP_PRIVATE_KEY"].map((k) => [k, process.env[k]] as const);
	for (const [k] of keep) delete process.env[k];
	assert.deepEqual(readConfig(), {}, "unconfigured -> inert");

	process.env.PI_GITHUB_APP_CLIENT_ID = "Iv1test";
	process.env.PI_GITHUB_APP_INSTALLATION_ID = "123";
	assert.ok(readConfig().error?.includes("PI_GITHUB_APP_PRIVATE_KEY"), "partial config -> error names the missing var");

	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
	process.env.PI_GITHUB_APP_PRIVATE_KEY = "not-a-key";
	assert.ok(readConfig().error?.includes("PEM"), "bogus key -> PEM error");

	process.env.PI_GITHUB_APP_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
	const { config, error } = readConfig();
	assert.ok(config && !error, "valid escaped-PEM config accepted");
	assert.ok(config!.privateKey.includes("\n"), "escaped newlines restored");

	for (const [k, v] of keep) if (v !== undefined) process.env[k] = v;
	console.log("ok readConfig");
}

// --- app auth (library-owned JWT; only wiring is ours) -----------------------
{
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
	const auth = createAuth("Iv1abc", privateKey);
	const { token } = (await auth({ type: "app" })) as { token: string };
	const [h, p] = token.split(".");
	assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "RS256");
	assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).iss, "Iv1abc");
	assert.equal(typeof fetchInstallationToken, "function", "installation exchange stays awaitable for the background loop");
	console.log("ok appAuth");
}

// --- githubSshHosts -------------------------------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "ssh-test-"));
	try {
		writeFileSync(join(dir, "config"), [
			"Host work.github.com",
			"  HostName github.com",
			"",
			"Host *",
			"  HostName not-github.example.com",
			"",
			"Include incl/*.conf",
		].join("\n"));
		writeFileSync(join(dir, "loop.conf"), "Include config\n"); // cycle: must not hang
		mkdirSync(join(dir, "incl"));
		writeFileSync(join(dir, "incl", "a.conf"), "Host ci.github.com\n  HostName github.com\n");

		const hosts = githubSshHosts(dir);
		for (const h of ["github.com", "work.github.com", "ci.github.com"]) assert.ok(hosts.includes(h), `alias ${h} detected`);
		assert.ok(!hosts.some((h) => h.includes("*")), "wildcard Host excluded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("ok githubSshHosts");
}

// --- githubCountersinks ---------------------------------------------------
{
	const gitconfig = [
		'[url "https://github.com/myowner/"]',
		"	insteadOf = https://github.com/myowner/",
		'[url "git@github.com:otherowner/"]',
		"	insteadOf = git@github.com:otherowner/",
	].join("\n");
	const file = join(mkdtempSync(join(tmpdir(), "gitcfg-")), "config");
	writeFileSync(file, gitconfig);
	const prev = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = file;
	try {
		const sinks = githubCountersinks();
		assert.ok(sinks.length === 2 * 66, `one sink per charset char per rule (got ${sinks.length})`);
		const httpsSink = sinks.find(([k]) => k.includes("myowner/a"));
		assert.deepEqual(httpsSink, ["url.https://github.com/myowner/a.insteadOf", "https://github.com/myowner/a"], "https countersink is a no-op, one char longer");
		const sshSink = sinks.find(([k]) => k.includes("otherowner/a"));
		assert.deepEqual(sshSink, ["url.https://github.com/otherowner/a.insteadOf", "git@github.com:otherowner/a"], "ssh countersink rewrites back to https, one char longer");
	} finally {
		if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev;
		rmSync(join(file, ".."), { recursive: true, force: true });
	}
	console.log("ok githubCountersinks");
}

// --- agentEnv -------------------------------------------------------------
{
	const base = {
		PATH: "/bin",
		GITHUB_TOKEN: "personal-token",
		PI_GITHUB_APP_PRIVATE_KEY: "key",
		PI_GITHUB_APP_CLIENT_ID: "id",
		PI_GITHUB_APP_INSTALLATION_ID: "inst",
	};
	const withToken = agentEnv(base, "tok123", []);
	assert.equal(withToken.GH_TOKEN, "tok123");
	assert.equal(withToken.GIT_TERMINAL_PROMPT, "0");
	assert.ok(withToken.GIT_SSH_COMMAND?.includes("pi_github_app_guard"), "SSH guard installed");
	assert.ok(!("GITHUB_TOKEN" in withToken), "personal GITHUB_TOKEN stripped");
	for (const k of Object.keys(base)) if (k.startsWith("PI_GITHUB_APP_")) assert.ok(!(k in withToken), `${k} stripped`);
	assert.equal(withToken.GIT_CONFIG_COUNT, String(2 + githubSshHosts().length * 2), "base entries + 2 insteadOf rules per detected host");
	assert.equal(withToken.GIT_CONFIG_KEY_0, "credential.helper");
	assert.equal(withToken.GIT_CONFIG_VALUE_0, "");
	assert.equal(withToken.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
	assert.equal(withToken.GIT_CONFIG_VALUE_1, GITHUB_CREDENTIAL_HELPER);
	assert.ok(GITHUB_CREDENTIAL_HELPER.includes(GH_SENTINEL), "helper fails closed on the sentinel");

	assert.equal(agentEnv(base, null, []).GH_TOKEN, GH_SENTINEL, "no token -> sentinel, not silent fallback");

	const n = githubSshHosts().length;
	const sinkIdx = 3 + 2 + n * 2; // base=3 offset, 2 base entries, host rules
	const offsetEnv = agentEnv({ ...base, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "x", GIT_CONFIG_VALUE_2: "y" }, "t", [["url.a.insteadOf", "b"]]);
	assert.equal(offsetEnv.GIT_CONFIG_KEY_3, "credential.helper", "respects pre-existing GIT_CONFIG_COUNT");
	assert.equal(offsetEnv.GIT_CONFIG_KEY_5, "url.https://github.com/.insteadOf", "host rules follow the offset");
	assert.equal(offsetEnv[`GIT_CONFIG_KEY_${sinkIdx}`], "url.a.insteadOf", "countersinks appended after host rules");
	assert.equal(offsetEnv.GIT_CONFIG_COUNT, String(sinkIdx + 1));
	console.log("ok agentEnv");
}

// --- parseSubcommand ------------------------------------------------------
{
	assert.equal(parseSubcommand(""), "");
	assert.equal(parseSubcommand("   "), "");
	assert.equal(parseSubcommand("status"), "status");
	assert.equal(parseSubcommand("  status  "), "status");
	assert.equal(parseSubcommand("status extra args"), "status");
	assert.equal(parseSubcommand("bogus"), "bogus");
	console.log("ok parseSubcommand");
}

// --- setup (pure parts; browser/API flow is manual) ------------------------
{
	const { parseArgs, callbackCode, selectInstallation, normalizePem, manifestInput, manifestFormHtml, formatEnvrc, checkNodeVersion } = _setupInternals;

	assert.deepEqual(parseArgs([]), {});
	assert.deepEqual(parseArgs(["--org", "acme", "--envrc", "/tmp/x"]), { org: "acme", envrcPath: "/tmp/x" });
	assert.deepEqual(parseArgs(["--help"]), { help: true });
	assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
	assert.throws(() => parseArgs(["--org"]), /missing value/);

	assert.equal(callbackCode("/callback?code=abc123"), "abc123");
	assert.equal(callbackCode("/callback?code=abc123&state=x"), "abc123");
	assert.equal(callbackCode("/callback"), null);
	assert.equal(callbackCode("/favicon.ico"), null);
	assert.equal(callbackCode(undefined), null);

	assert.deepEqual(selectInstallation([]), { kind: "none" });
	assert.deepEqual(selectInstallation([{ id: 1, login: "a" }]), { kind: "single", id: 1 });
	assert.equal(selectInstallation([{ id: 1, login: "a" }, { id: 2, login: "b" }]).kind, "choose");

	assert.ok(normalizePem("A\\nB").includes("\n"), "escaped newlines restored");
	assert.ok(normalizePem("A\nB").includes("\n"), "real newlines kept");

	const { action, manifest } = manifestInput(8471);
	assert.equal(action, "https://github.com/settings/apps/new");
	assert.deepEqual(manifestInput(8471, "acme").action, "https://github.com/organizations/acme/settings/apps/new");
	const perms = manifest.default_permissions as Record<string, string>;
	assert.equal(perms.contents, "write");
	assert.equal(perms.metadata, "read");
	assert.equal((manifest as { redirect_url: string }).redirect_url, "http://127.0.0.1:8471/callback");
	assert.ok(!("hook_attributes" in manifest), "webhook config omitted when no webhook URL is configured");

	const html = manifestFormHtml(action, manifest);
	assert.ok(html.includes('method="post"') && html.includes('.submit()'), "auto-submitting form posts the manifest");
	assert.ok(html.includes(action), "form targets the creation endpoint");
	assert.ok(!html.includes("</script><script"), "no injection point in embedded JSON");

	const block = formatEnvrc("ID", "42", "PEM");
	assert.ok(block.includes('PI_GITHUB_APP_CLIENT_ID="ID"') && block.includes('PI_GITHUB_APP_INSTALLATION_ID="42"'), "envrc block names");

	checkNodeVersion(process.versions.node); // our own runtime passes
	assert.throws(() => checkNodeVersion("20.11.0"), /too old/);
	assert.throws(() => checkNodeVersion("22.17.9"), /too old/);
	assert.throws(() => checkNodeVersion("garbage"), /too old/);
	console.log("ok setup");
}

// --- setup server + API parts (localhost only, no external network) --------
{
	const { createAuth, createSetupServer, exchangeCode, listInstallations } = _setupInternals;

	// form serving + code capture
	const setup = createSetupServer();
	await new Promise<void>((res, rej) => {
		setup.server.once("error", rej);
		setup.server.listen(0, "127.0.0.1", () => res());
	});
	const port = (setup.server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}`;
	setup.setFormHtml("<form>hello</form>");
	assert.equal(await (await fetch(`${base}/`)).text(), "<form>hello</form>");
	assert.equal((await fetch(`${base}/nope`)).status, 404);
	const codePromise = setup.waitForCode();
	assert.equal((await fetch(`${base}/callback?code=abc123`)).status, 200);
	assert.equal(await codePromise, "abc123");
	setup.server.close();
	console.log("ok setup server");

	// manifest conversion + installation listing against a mock API
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
	const { createServer } = await import("node:http");
	const api = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		if (req.method === "POST") res.end(JSON.stringify({ slug: "my-app", client_id: "Iv1x", pem: privateKey }));
		else res.end(JSON.stringify([{ id: 7, account: { login: "octo" } }]));
	});
	await new Promise<void>((res, rej) => {
		api.once("error", rej);
		api.listen(0, "127.0.0.1", () => res());
	});
	const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
	const conv = await exchangeCode("single-use", apiBase);
	assert.equal(conv.slug, "my-app");
	assert.equal(conv.clientId, "Iv1x");
	assert.ok(conv.pem.includes("PRIVATE KEY"));
	assert.deepEqual(await listInstallations(createAuth("Iv1x", privateKey), apiBase), [{ id: 7, login: "octo" }]);
	api.close();
	console.log("ok setup api");
}

console.log("\nall tests passed");
