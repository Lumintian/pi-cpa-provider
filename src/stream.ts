/**
 * CPA Codex Responses transport built on Pi AI's stock Codex implementation.
 *
 * The stock implementation targets ChatGPT and insists that the API key is a
 * JWT carrying `chatgpt_account_id`; it always sends that token as
 * `Authorization: Bearer`. CPA accepts its key in `X-Api-Key` as well, so this
 * adapter passes an unsigned per-instance placeholder token to satisfy the
 * stock check and sends the real key in `X-Api-Key`. No upstream source is
 * patched; WebSocket reuse, SSE fallback, tool calls, usage, and abort
 * handling all come from Pi AI.
 */

import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export const CPA_API = "cpa-codex-responses";

export type StreamSimpleFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function base64Url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Unsigned token the stock Codex module can parse. It carries no secret; its
 * account ID keeps each instance's pooled WebSocket separate.
 */
export function placeholderCodexToken(instanceId: string): string {
	return [
		base64Url({ alg: "none", typ: "JWT" }),
		base64Url({ [JWT_CLAIM_PATH]: { chatgpt_account_id: `cpa-${instanceId}` } }),
		"cpa",
	].join(".");
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Per-instance Codex session IDs and their WebSocket lifecycle.
 *
 * Pi passes the same session ID to every provider, and the stock module pools
 * WebSockets by session ID. Namespacing the ID per instance lets this plugin
 * close exactly one instance's socket for one session. Pi's own session
 * cleanup only knows the raw ID, so the namespaced sockets are closed here.
 */
export class CodexSessionTracker {
	private readonly compactions = new Map<string, number>();
	private readonly seen = new Map<string, { sessionId: string; compaction: number }>();
	private readonly closeSession: (codexSessionId: string) => void;

	constructor(closeSession: (codexSessionId: string) => void) {
		this.closeSession = closeSession;
	}

	codexSessionId(instanceId: string, sessionId: string): string {
		return `cpa:${shortHash(instanceId)}:${sessionId}`;
	}

	/**
	 * Return the namespaced ID for a request. If the session was compacted since
	 * this instance last used it, close the old socket first: CPA ties server
	 * context to the connection, and compaction only rewrites the client side.
	 */
	prepare(instanceId: string, sessionId: string): string {
		const id = this.codexSessionId(instanceId, sessionId);
		const compaction = this.compactions.get(sessionId) ?? 0;
		const previous = this.seen.get(id);
		if (previous && previous.compaction !== compaction) this.close(id);
		this.seen.set(id, { sessionId, compaction });
		return id;
	}

	markCompacted(sessionId: string): void {
		this.compactions.set(sessionId, (this.compactions.get(sessionId) ?? 0) + 1);
	}

	/** Close every instance's socket for one Pi session. */
	closeForSession(sessionId: string): void {
		for (const [id, entry] of this.seen) {
			if (entry.sessionId === sessionId) {
				this.close(id);
				this.seen.delete(id);
			}
		}
		this.compactions.delete(sessionId);
	}

	/** Close one instance's sockets across all sessions (instance removed or re-pointed). */
	closeForInstance(instanceId: string): void {
		const prefix = `cpa:${shortHash(instanceId)}:`;
		for (const id of [...this.seen.keys()]) {
			if (id.startsWith(prefix)) {
				this.close(id);
				this.seen.delete(id);
			}
		}
	}

	closeAll(): void {
		for (const id of this.seen.keys()) this.close(id);
		this.seen.clear();
		this.compactions.clear();
	}

	private close(id: string): void {
		try {
			this.closeSession(id);
		} catch (error) {
			console.warn(`[pi-cpa-provider] failed to close Codex WebSocket: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** Add the priority tier before shared payload hooks so later extensions keep final control. */
export function withPriorityPayloadHook(onPayload: SimpleStreamOptions["onPayload"]): NonNullable<SimpleStreamOptions["onPayload"]> {
	return async (payload, model) => {
		const fast =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>), service_tier: "priority" }
				: payload;
		const next = await onPayload?.(fast, model);
		return next === undefined ? fast : next;
	};
}

function relabel(event: AssistantMessageEvent, api: Api): AssistantMessageEvent {
	// The stock module stamps its own API ID on messages. Pi compares
	// message.api with model.api to decide whether reasoning items and tool
	// call IDs can be replayed verbatim, so restore this provider's API ID.
	if ("partial" in event) event.partial.api = api;
	if (event.type === "done") event.message.api = api;
	if (event.type === "error") event.error.api = api;
	return event;
}

export interface CpaStreamDeps {
	instanceId: string;
	codexStreamSimple: StreamSimpleFn;
	sessions: CodexSessionTracker;
	isFast: (modelId: string) => boolean;
}

export function createCpaStreamSimple(deps: CpaStreamDeps): StreamSimpleFn {
	return (model, context, options) => {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}. Run /cpa-edit ${deps.instanceId} to set one.`);
		}
		const sessionId = options?.sessionId ? deps.sessions.prepare(deps.instanceId, options.sessionId) : undefined;
		const inner = deps.codexStreamSimple(model, context, {
			...options,
			apiKey: placeholderCodexToken(deps.instanceId),
			headers: { ...options?.headers, "X-Api-Key": apiKey },
			...(sessionId ? { sessionId } : {}),
			...(deps.isFast(model.id) ? { onPayload: withPriorityPayloadHook(options?.onPayload) } : {}),
		});

		const outer = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of inner) outer.push(relabel(event, model.api));
			outer.end();
		})().catch((error: unknown) => {
			outer.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			outer.end();
		});
		return outer;
	};
}
