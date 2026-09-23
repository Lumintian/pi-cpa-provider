import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CatalogHttpError,
	cachePathFor,
	fetchCatalog,
	isAuthError,
	loadCatalogCache,
	mapCatalog,
	saveCatalogCache,
	toProviderModel,
} from "../src/catalog.ts";
import { jsonResponse, RAW_CATALOG, tempPaths } from "./helpers.ts";

test("catalog entries map to Pi models; hidden and duplicate entries drop", () => {
	const models = mapCatalog([...RAW_CATALOG.models, { slug: "gpt-example" }]);
	assert.deepEqual(
		models.map((m) => m.id),
		["gpt-example", "flex-only"],
	);
	const [gpt, flex] = models;
	assert.equal(gpt.name, "GPT Example");
	assert.equal(gpt.contextWindow, 272000);
	assert.equal(gpt.maxTokens, 64000);
	assert.deepEqual(gpt.input, ["text", "image"]);
	assert.equal(gpt.reasoning, true);
	assert.deepEqual(gpt.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
	assert.equal(flex.contextWindow, 128000);
	assert.equal(flex.maxTokens, 16384);
	assert.equal(flex.reasoning, false);
	assert.equal(flex.thinkingLevelMap, undefined);
});

test("Fast needs an explicit priority tier", () => {
	const [gpt, flex] = mapCatalog(RAW_CATALOG.models);
	assert.equal(gpt.supportsPriority, true);
	assert.equal(flex.supportsPriority, false);
	assert.equal(mapCatalog([{ id: "s", service_tiers: ["Priority"] }])[0].supportsPriority, true);
});

test("provider models carry the instance name and placeholder zero cost", () => {
	const model = toProviderModel(mapCatalog(RAW_CATALOG.models)[0], "Home CPA");
	assert.equal(model.name, "GPT Example (Home CPA)");
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal("supportsPriority" in model, false);
});

test("fetchCatalog sends the key and accepts array, models, and data shapes", async () => {
	for (const body of [RAW_CATALOG.models, RAW_CATALOG, { data: RAW_CATALOG.models }]) {
		let auth: string | null = null;
		const models = await fetchCatalog("http://cpa/v1/models", "sk-1", {
			timeoutMs: 1000,
			fetch: async (_url, init) => {
				auth = new Headers(init?.headers).get("authorization");
				return jsonResponse(body);
			},
		});
		assert.equal(models.length, 2);
		assert.equal(auth, "Bearer sk-1");
	}
	assert.deepEqual(await fetchCatalog("u", "k", { timeoutMs: 1000, fetch: async () => jsonResponse({ models: [] }) }), []);
});

test("fetchCatalog rejects HTTP errors, non-JSON bodies, and unknown shapes", async () => {
	const unauthorized = fetchCatalog("u", "k", { timeoutMs: 1000, fetch: async () => jsonResponse({ error: "no" }, 401) });
	await assert.rejects(unauthorized, (error: unknown) => error instanceof CatalogHttpError && isAuthError(error));
	await assert.rejects(fetchCatalog("u", "k", { timeoutMs: 1000, fetch: async () => jsonResponse("<html>") }), /not valid JSON/);
	await assert.rejects(fetchCatalog("u", "k", { timeoutMs: 1000, fetch: async () => jsonResponse({ ok: true }) }), /not a model list/);
});

test("fetchCatalog times out", async () => {
	const hang: typeof fetch = (_url, init) =>
		new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
	await assert.rejects(fetchCatalog("u", "k", { timeoutMs: 20, fetch: hang }), /timed out after 20 ms/);
});

test("cache round-trips per instance and is ignored for another URL", () => {
	const paths = tempPaths();
	const models = mapCatalog(RAW_CATALOG.models);
	saveCatalogCache(paths.cacheDir, "home", { modelsUrl: "http://a/v1/models", fetchedAt: 5, models });
	assert.deepEqual(loadCatalogCache(paths.cacheDir, "home", "http://a/v1/models"), {
		modelsUrl: "http://a/v1/models",
		fetchedAt: 5,
		models,
	});
	assert.equal(loadCatalogCache(paths.cacheDir, "home", "http://b/v1/models"), undefined);
	assert.equal(loadCatalogCache(paths.cacheDir, "backup", "http://a/v1/models"), undefined);
	assert.throws(() => cachePathFor(paths.cacheDir, "../x"), /Invalid instance ID/);
});
