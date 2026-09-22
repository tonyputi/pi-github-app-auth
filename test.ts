/**
 * Self-check for the pure helpers exported via _internals. No framework, no
 * network: run with `npm test` (Node 22.18+ strips types natively).
 */
import assert from "node:assert";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internals } from "./index.ts";

const { readConfig, mintAppJwt, githubSshHosts, githubCountersinks, agentEnv, GITHUB_CREDENTIAL_HELPER, GH_SENTINEL } = _internals;

// --- readConfig -----------------------------------------------------------
{
	const keep = ["PI_GITHUB_APP_CLIENT_ID", "PI_GITHUB_APP_INSTALLATION_ID", "PI_GITHUB_APP_PRIVATE_KEY"].map((k) => [k, process.env[k]]);
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

// --- mintAppJwt -----------------------------------------------------------
{
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
	const jwt = mintAppJwt({ clientId: "Iv1abc", installationId: "1", privateKey });
	const [h, p, s] = jwt.split(".");
	assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "RS256");
	const claims = JSON.parse(Buffer.from(p, "base64url").toString());
	assert.equal(claims.iss, "Iv1abc");
	assert.ok(claims.exp - claims.iat === 570, "9 min lifetime + 30s skew");
	assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url"), "signature verifies with the App public key");
	console.log("ok mintAppJwt");
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

console.log("\nall tests passed");
