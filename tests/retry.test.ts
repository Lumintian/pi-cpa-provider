import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeTransientError } from "../src/retry.ts";

function failed(errorMessage: string, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cpa-codex-responses",
		provider: "cpa-home",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

const notRetryable = () => false;

test("known transient failures before any output become retryable", () => {
	for (const text of ["read: closed network connection", "stream disconnected before completion: eof", "Invalid Codex SSE JSON: x"]) {
		assert.equal(normalizeTransientError(failed(text), notRetryable)?.errorMessage, `network error: ${text}`);
	}
});

test("failures after streamed output are left alone to avoid duplicate work", () => {
	const partial = failed("closed network connection", [{ type: "text", text: "Hello" }]);
	assert.equal(normalizeTransientError(partial, notRetryable), undefined);
	const toolCall = failed("closed network connection", [{ type: "toolCall", id: "c", name: "t", arguments: {} }]);
	assert.equal(normalizeTransientError(toolCall, notRetryable), undefined);
	assert.ok(normalizeTransientError(failed("closed network connection", [{ type: "text", text: "" }]), notRetryable));
});

test("unrelated, already-retryable, and successful messages pass through", () => {
	assert.equal(normalizeTransientError(failed("invalid api key"), notRetryable), undefined);
	assert.equal(normalizeTransientError(failed("closed network connection"), () => true), undefined);
	assert.equal(normalizeTransientError({ ...failed("closed network connection"), stopReason: "stop" }, notRetryable), undefined);
});
