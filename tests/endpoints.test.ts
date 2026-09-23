import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEndpoints } from "../src/endpoints.ts";

test("plain origin maps to backend-api and v1/models", () => {
	assert.deepEqual(resolveEndpoints("http://127.0.0.1:8317"), {
		baseUrl: "http://127.0.0.1:8317",
		inferenceBaseUrl: "http://127.0.0.1:8317/backend-api",
		modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=pi",
	});
});

test("missing scheme, trailing slash, /v1 and /backend-api normalize to the same root", () => {
	for (const input of ["127.0.0.1:8317", "http://127.0.0.1:8317/", "http://127.0.0.1:8317/v1", "http://127.0.0.1:8317/backend-api/"]) {
		assert.equal(resolveEndpoints(input).baseUrl, "http://127.0.0.1:8317", input);
	}
});

test("path prefixes are kept", () => {
	const endpoints = resolveEndpoints("https://example.com/proxy/v1");
	assert.equal(endpoints.inferenceBaseUrl, "https://example.com/proxy/backend-api");
	assert.equal(endpoints.modelsUrl, "https://example.com/proxy/v1/models?client_version=pi");
});

test("query, fragment, credentials, and other schemes are rejected", () => {
	assert.throws(() => resolveEndpoints("http://host/?x=1"), /query/);
	assert.throws(() => resolveEndpoints("http://host/#a"), /query or fragment/);
	assert.throws(() => resolveEndpoints("http://user:pw@host"), /credentials/);
	assert.throws(() => resolveEndpoints("ftp://host"), /http or https/);
	assert.throws(() => resolveEndpoints("  "), /empty/);
});
