import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	deleteCredential,
	describeKeySource,
	escapeConfigValue,
	resolveKeySync,
	resolveStoredKey,
	storeApiKey,
} from "../src/credentials.ts";
import { tempPaths } from "./helpers.ts";

test("escaped keys resolve back to the literal key", () => {
	for (const key of ["sk-plain", "sk-$HOME-x", "!not-a-command", "a$$b", "${X}", "$!"]) {
		assert.equal(resolveStoredKey(escapeConfigValue(key), {}), key, key);
	}
});

test("stored templates follow Pi semantics", () => {
	assert.equal(resolveStoredKey("$CPA_KEY", { CPA_KEY: "k1" }), "k1");
	assert.equal(resolveStoredKey("pre-${CPA_KEY}-post", { CPA_KEY: "k1" }), "pre-k1-post");
	assert.equal(resolveStoredKey("$MISSING", {}), undefined);
	assert.equal(resolveStoredKey("!echo hi", {}), undefined);
});

test("store/delete touch only the instance entry and keep other credentials", () => {
	const paths = tempPaths();
	writeFileSync(paths.authPath, JSON.stringify({ other: { type: "oauth", access: "x", refresh: "y", expires: 1 } }));
	storeApiKey(paths.authPath, "cpa-home", "sk-$ecret");
	const data = JSON.parse(readFileSync(paths.authPath, "utf8"));
	assert.deepEqual(data["cpa-home"], { type: "api_key", key: "sk-$$ecret" });
	assert.equal(data.other.access, "x");
	assert.equal(existsSync(`${paths.authPath}.lock`), false);
	assert.equal(resolveKeySync(paths.authPath, "cpa-home"), "sk-$ecret");

	assert.equal(deleteCredential(paths.authPath, "cpa-home"), true);
	assert.equal(deleteCredential(paths.authPath, "cpa-home"), false);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(paths.authPath, "utf8"))), ["other"]);
});

test("a new auth.json is created owner-only", () => {
	const paths = tempPaths();
	storeApiKey(paths.authPath, "cpa-home", "k");
	assert.equal(statSync(paths.authPath).mode & 0o777, 0o600);
});

test("auth.json takes precedence over apiKeyEnv", () => {
	const paths = tempPaths();
	process.env.PI_CPA_TEST_KEY = "from-env";
	try {
		assert.equal(resolveKeySync(paths.authPath, "cpa-home", "PI_CPA_TEST_KEY"), "from-env");
		assert.deepEqual(describeKeySource(paths.authPath, "cpa-home", "PI_CPA_TEST_KEY"), { kind: "env", name: "PI_CPA_TEST_KEY" });
		storeApiKey(paths.authPath, "cpa-home", "from-auth");
		assert.equal(resolveKeySync(paths.authPath, "cpa-home", "PI_CPA_TEST_KEY"), "from-auth");
		assert.deepEqual(describeKeySource(paths.authPath, "cpa-home", "PI_CPA_TEST_KEY"), { kind: "auth" });
	} finally {
		delete process.env.PI_CPA_TEST_KEY;
	}
	assert.deepEqual(describeKeySource(paths.authPath, "cpa-none"), { kind: "none" });
});
