import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig, parseConfig, providerIdFor, updateConfig } from "../src/config.ts";
import { tempPaths } from "./helpers.ts";

test("config lives under <agentDir>/extensions/pi-cpa-provider and auth stays in agentDir", () => {
	const paths = tempPaths();
	assert.ok(paths.configPath.endsWith("/extensions/pi-cpa-provider/config.json"));
	assert.ok(paths.cacheDir.endsWith("/extensions/pi-cpa-provider/cache"));
	assert.equal(paths.authPath, `${paths.agentDir}/auth.json`);
	assert.equal(providerIdFor("home"), "cpa-home");
});

test("valid instances parse with normalized URL and defaults", () => {
	const { config, issues } = parseConfig(
		JSON.stringify({
			instances: [
				{ id: "home", baseUrl: "127.0.0.1:8317/v1", fastModels: { a: true, b: false } },
				{ id: "backup", name: "Backup", baseUrl: "http://10.0.0.2:8317", apiKeyEnv: "CPA_BACKUP" },
			],
		}),
	);
	assert.deepEqual(issues, []);
	assert.deepEqual(config.instances[0], { id: "home", name: "home", baseUrl: "http://127.0.0.1:8317", fastModels: { a: true } });
	assert.equal(config.instances[1].apiKeyEnv, "CPA_BACKUP");
});

test("keys, bad IDs, duplicates, and unknown fields skip only the affected instance", () => {
	const { config, issues } = parseConfig(
		JSON.stringify({
			instances: [
				{ id: "ok", baseUrl: "http://a" },
				{ id: "leak", baseUrl: "http://b", apiKey: "sk-secret" },
				{ id: "../evil", baseUrl: "http://c" },
				{ id: "ok", baseUrl: "http://d" },
				{ id: "extra", baseUrl: "http://e", color: "red" },
				{ id: "env", baseUrl: "http://f", apiKeyEnv: "1BAD" },
			],
		}),
	);
	assert.deepEqual(
		config.instances.map((i) => i.id),
		["ok"],
	);
	assert.equal(issues.length, 5);
	assert.match(issues[0], /contains an API key/);
	assert.doesNotMatch(issues.join("\n"), /sk-secret/);
});

test("a malformed file throws; a missing file is empty", () => {
	assert.throws(() => parseConfig("{"), /not valid JSON/);
	assert.throws(() => parseConfig("[]"), /JSON object/);
	assert.deepEqual(loadConfig(tempPaths()), { config: { instances: [] }, issues: [] });
});

test("updateConfig writes atomically, releases its lock, and never stores keys", () => {
	const paths = tempPaths();
	updateConfig(paths, () => ({ instances: [{ id: "home", name: "Home", baseUrl: "http://h", fastModels: { m: true } }] }));
	const text = readFileSync(paths.configPath, "utf8");
	assert.deepEqual(JSON.parse(text), {
		instances: [{ id: "home", name: "Home", baseUrl: "http://h", fastModels: { m: true } }],
	});
	assert.equal(existsSync(`${paths.configPath}.lock`), false);
	assert.equal(loadConfig(paths).config.instances[0].fastModels.m, true);
});

test("updateConfig refuses to rewrite a file with invalid instances", () => {
	const paths = tempPaths();
	updateConfig(paths, (config) => config);
	writeFileSync(paths.configPath, JSON.stringify({ instances: [{ id: "BAD", baseUrl: "http://x" }] }));
	assert.throws(() => updateConfig(paths, (config) => config), /invalid instances/);
	assert.match(readFileSync(paths.configPath, "utf8"), /BAD/);
});
