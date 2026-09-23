import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { mapCatalog, saveCatalogCache } from "../src/catalog.ts";
import { type CpaConfig, type CpaPaths, updateConfig } from "../src/config.ts";
import { storeApiKey } from "../src/credentials.ts";
import { resolveEndpoints } from "../src/endpoints.ts";
import { CpaRuntime } from "../src/runtime.ts";
import { CodexSessionTracker } from "../src/stream.ts";
import { jsonResponse, RAW_CATALOG, tempPaths } from "./helpers.ts";

type HostEvent = { op: "register"; id: string; config: ProviderConfig } | { op: "unregister"; id: string };

function setup(paths: CpaPaths, config: CpaConfig, fetchImpl: typeof fetch) {
	updateConfig(paths, () => config);
	const events: HostEvent[] = [];
	const closed: string[] = [];
	const runtime = new CpaRuntime({
		host: {
			registerProvider: (id, providerConfig) => events.push({ op: "register", id, config: providerConfig }),
			unregisterProvider: (id) => events.push({ op: "unregister", id }),
		},
		paths,
		codexStreamSimple: () => {
			throw new Error("not used");
		},
		sessions: new CodexSessionTracker((id) => closed.push(id)),
		fetch: fetchImpl,
	});
	const latest = (id: string) =>
		events.filter((event): event is Extract<HostEvent, { op: "register" }> => event.op === "register" && event.id === id).at(-1)?.config;
	return { runtime, events, closed, latest };
}

const TWO_INSTANCES: CpaConfig = {
	instances: [
		{ id: "home", name: "Home", baseUrl: "http://home:8317", fastModels: { "gpt-example": true, "flex-only": true } },
		{ id: "backup", name: "Backup", baseUrl: "http://backup:8317", fastModels: {} },
	],
};

test("startup fetches each instance independently; one failure does not affect the other", async () => {
	const paths = tempPaths();
	storeApiKey(paths.authPath, "cpa-home", "k-home");
	storeApiKey(paths.authPath, "cpa-backup", "k-backup");
	const { runtime, latest } = setup(paths, TWO_INSTANCES, async (url, init) => {
		if (String(url).startsWith("http://backup")) return jsonResponse({ error: "bad key" }, 401);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer k-home");
		return jsonResponse(RAW_CATALOG);
	});
	await runtime.init();

	const home = latest("cpa-home")!;
	assert.equal(home.api, "cpa-codex-responses");
	assert.equal(home.baseUrl, "http://home:8317/backend-api");
	assert.equal(home.apiKey, undefined);
	assert.deepEqual(
		home.models?.map((m) => [m.id, m.name]),
		[
			["gpt-example", "GPT Example (Home)"],
			["flex-only", "flex-only (Home)"],
		],
	);
	assert.deepEqual(latest("cpa-backup")?.models, []);
	assert.equal(runtime.get("backup")?.lastErrorIsAuth, true);
	assert.equal(runtime.get("home")?.lastError, undefined);
});

test("same model ID on two instances stays separate, with Fast keyed by instance", async () => {
	const paths = tempPaths();
	storeApiKey(paths.authPath, "cpa-home", "k");
	storeApiKey(paths.authPath, "cpa-backup", "k");
	const { runtime, latest } = setup(paths, TWO_INSTANCES, async () => jsonResponse(RAW_CATALOG));
	await runtime.init();
	assert.equal(latest("cpa-home")?.models?.[0].id, latest("cpa-backup")?.models?.[0].id);
	assert.notEqual(latest("cpa-home")?.streamSimple, latest("cpa-backup")?.streamSimple);
	assert.equal(runtime.isFastEffective("home", "gpt-example"), true);
	assert.equal(runtime.isFastEffective("backup", "gpt-example"), false);
	// Enabled in config but the catalog lists no priority tier.
	assert.equal(runtime.isFastEffective("home", "flex-only"), false);
});

test("a matching cache registers without network; a failed refresh keeps it", async () => {
	const paths = tempPaths();
	const models = mapCatalog(RAW_CATALOG.models);
	saveCatalogCache(paths.cacheDir, "home", { modelsUrl: resolveEndpoints("http://home:8317").modelsUrl, fetchedAt: 1, models });
	let calls = 0;
	const { runtime, latest } = setup(paths, { instances: [TWO_INSTANCES.instances[0]] }, async () => {
		calls++;
		throw new Error("connection refused");
	});
	await runtime.init();
	assert.equal(calls, 0);
	assert.equal(runtime.get("home")?.fromCacheOnly, true);
	assert.equal(latest("cpa-home")?.models?.length, 2);

	await assert.rejects(runtime.refresh("home", "k"), /connection refused/);
	assert.equal(runtime.get("home")?.catalog?.models.length, 2);
	assert.equal(runtime.get("home")?.lastError, "connection refused");
});

test("a successful refresh replaces the catalog without retaining removed models", async () => {
	const paths = tempPaths();
	let body: unknown = RAW_CATALOG;
	const { runtime, latest } = setup(paths, { instances: [TWO_INSTANCES.instances[0]] }, async () => jsonResponse(body));
	await runtime.init();
	assert.deepEqual(await runtime.refresh("home", "k"), { status: "ok", modelCount: 2 });
	body = { models: [{ slug: "new-model" }] };
	await runtime.refresh("home", "k");
	assert.deepEqual(
		latest("cpa-home")?.models?.map((m) => m.id),
		["new-model"],
	);
	body = { models: [] };
	await runtime.refresh("home", "k");
	assert.deepEqual(latest("cpa-home")?.models, []);
	assert.equal(runtime.isFastEffective("home", "gpt-example"), false);
});

test("without a key, refresh reports no-key and makes no request", async () => {
	const paths = tempPaths();
	let calls = 0;
	const { runtime } = setup(paths, { instances: [TWO_INSTANCES.instances[0]] }, async () => {
		calls++;
		return jsonResponse(RAW_CATALOG);
	});
	await runtime.init();
	assert.deepEqual(await runtime.refresh("home", undefined), { status: "no-key" });
	assert.equal(calls, 0);
});

test("a newer refresh supersedes an older in-flight one", async () => {
	const paths = tempPaths();
	const gates: Array<(response: Response) => void> = [];
	const { runtime, latest } = setup(paths, { instances: [TWO_INSTANCES.instances[0]] }, (_url, init) =>
		new Promise((resolve, reject) => {
			gates.push(resolve);
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		}),
	);
	await runtime.init();
	const first = runtime.refresh("home", "k");
	const second = runtime.refresh("home", "k");
	gates[1](jsonResponse({ models: [{ slug: "second" }] }));
	assert.deepEqual(await first, { status: "superseded" });
	assert.deepEqual(await second, { status: "ok", modelCount: 1 });
	assert.deepEqual(
		latest("cpa-home")?.models?.map((m) => m.id),
		["second"],
	);
});

test("env-key instances register the env reference; removing it re-registers cleanly", async () => {
	const paths = tempPaths();
	const { runtime, events, latest } = setup(
		paths,
		{ instances: [{ id: "home", name: "Home", baseUrl: "http://home", apiKeyEnv: "CPA_HOME_KEY", fastModels: {} }] },
		async () => jsonResponse(RAW_CATALOG),
	);
	await runtime.init();
	assert.equal(latest("cpa-home")?.apiKey, "$CPA_HOME_KEY");
	events.length = 0;
	runtime.applyConfig({ instances: [{ id: "home", name: "Home", baseUrl: "http://home", fastModels: {} }] });
	assert.deepEqual(
		events.map((event) => event.op),
		["unregister", "register"],
	);
	assert.equal(latest("cpa-home")?.apiKey, undefined);
});

test("removing an instance unregisters it and closes only its sockets", async () => {
	const paths = tempPaths();
	const { runtime, events, closed } = setup(paths, TWO_INSTANCES, async () => jsonResponse(RAW_CATALOG));
	await runtime.init();
	const sessions = (runtime as unknown as { options: { sessions: CodexSessionTracker } }).options.sessions;
	const homeSession = sessions.prepare("home", "s1");
	sessions.prepare("backup", "s1");
	runtime.applyConfig({ instances: [TWO_INSTANCES.instances[1]] });
	assert.deepEqual(events.at(-2), { op: "unregister", id: "cpa-home" });
	assert.equal(runtime.get("home"), undefined);
	assert.deepEqual(closed, [homeSession]);
});

test("changing the URL drops the old catalog and closes that instance's sockets", async () => {
	const paths = tempPaths();
	storeApiKey(paths.authPath, "cpa-home", "k");
	const { runtime, closed, latest } = setup(paths, { instances: [TWO_INSTANCES.instances[0]] }, async () => jsonResponse(RAW_CATALOG));
	await runtime.init();
	const sessions = (runtime as unknown as { options: { sessions: CodexSessionTracker } }).options.sessions;
	const id = sessions.prepare("home", "s1");
	runtime.applyConfig({ instances: [{ ...TWO_INSTANCES.instances[0], baseUrl: "http://moved:8317" }] });
	assert.deepEqual(closed, [id]);
	assert.equal(latest("cpa-home")?.baseUrl, "http://moved:8317/backend-api");
	assert.deepEqual(latest("cpa-home")?.models, []);
});
