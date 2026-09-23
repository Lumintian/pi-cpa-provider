import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CodexSessionTracker, CPA_API, createCpaStreamSimple, placeholderCodexToken, type StreamSimpleFn } from "../src/stream.ts";

const EMPTY_CONTEXT = normalizeContext({ messages: [] });

const MODEL = {
	id: "gpt-example",
	name: "GPT Example",
	api: CPA_API,
	provider: "cpa-home",
	baseUrl: "http://cpa/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as Model<Api>;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** Fake stock Codex stream that records its options and emits start + done. */
function fakeCodex(calls: SimpleStreamOptions[]): StreamSimpleFn {
	return (_model, _context, options) => {
		calls.push(options ?? {});
		const stream = createAssistantMessageEventStream();
		const output = assistant();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		});
		return stream;
	};
}

function decodeClaims(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

test("placeholder token satisfies the Codex account-id check without carrying the key", () => {
	const token = placeholderCodexToken("home");
	assert.equal(token.split(".").length, 3);
	assert.deepEqual(decodeClaims(token), { "https://api.openai.com/auth": { chatgpt_account_id: "cpa-home" } });
});

test("requests carry the real key in X-Api-Key, a namespaced session, and this provider's API ID", async () => {
	const calls: SimpleStreamOptions[] = [];
	const closed: string[] = [];
	const sessions = new CodexSessionTracker((id) => closed.push(id));
	const stream = createCpaStreamSimple({ instanceId: "home", codexStreamSimple: fakeCodex(calls), sessions, isFast: () => false });
	const userHook: SimpleStreamOptions["onPayload"] = async (payload) => payload;

	const result = stream(MODEL, EMPTY_CONTEXT, { apiKey: "sk-real", sessionId: "s1", headers: { "X-Extra": "1" }, onPayload: userHook });
	const events = [];
	for await (const event of result) events.push(event);

	const [options] = calls;
	assert.notEqual(options.apiKey, "sk-real");
	assert.equal(decodeClaims(options.apiKey!)["https://api.openai.com/auth"] !== undefined, true);
	assert.deepEqual(options.headers, { "X-Extra": "1", "X-Api-Key": "sk-real" });
	assert.equal(options.sessionId, sessions.codexSessionId("home", "s1"));
	assert.notEqual(options.sessionId, sessions.codexSessionId("backup", "s1"));
	assert.equal(options.onPayload, userHook);
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "done"],
	);
	assert.equal((await result.result()).api, CPA_API);
	assert.deepEqual(closed, []);
});

test("Fast adds service_tier before the caller's payload hook", async () => {
	const calls: SimpleStreamOptions[] = [];
	const sessions = new CodexSessionTracker(() => {});
	const stream = createCpaStreamSimple({ instanceId: "home", codexStreamSimple: fakeCodex(calls), sessions, isFast: (id) => id === MODEL.id });
	const seen: unknown[] = [];
	await stream(MODEL, EMPTY_CONTEXT, { apiKey: "k", onPayload: async (payload) => void seen.push(payload) }).result();
	const out = await calls[0].onPayload!({ model: "m", input: [] }, MODEL);
	assert.deepEqual(seen, [{ model: "m", input: [], service_tier: "priority" }]);
	assert.deepEqual(out, { model: "m", input: [], service_tier: "priority" });
});

test("a missing key fails before any request", () => {
	const calls: SimpleStreamOptions[] = [];
	const stream = createCpaStreamSimple({ instanceId: "home", codexStreamSimple: fakeCodex(calls), sessions: new CodexSessionTracker(() => {}), isFast: () => false });
	assert.throws(() => stream(MODEL, EMPTY_CONTEXT, {}), /No API key/);
	assert.equal(calls.length, 0);
});

test("compaction resets only the compacted session, lazily per instance", () => {
	const closed: string[] = [];
	const sessions = new CodexSessionTracker((id) => closed.push(id));
	const home1 = sessions.prepare("home", "s1");
	const backup1 = sessions.prepare("backup", "s1");
	const home2 = sessions.prepare("home", "s2");

	sessions.markCompacted("s1");
	assert.deepEqual(closed, []);
	sessions.prepare("home", "s1");
	assert.deepEqual(closed, [home1]);
	sessions.prepare("home", "s1");
	sessions.prepare("home", "s2");
	assert.deepEqual(closed, [home1]);
	sessions.prepare("backup", "s1");
	assert.deepEqual(closed, [home1, backup1]);

	closed.length = 0;
	sessions.closeForInstance("home");
	assert.deepEqual(closed.sort(), [home1, home2].sort());
	closed.length = 0;
	sessions.closeAll();
	assert.deepEqual(closed, [backup1]);
});
