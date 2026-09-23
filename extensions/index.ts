/**
 * pi-cpa-provider: serve models from one or more CLIProxyAPI (CPA) instances.
 *
 * Each instance registers as its own Pi provider (`cpa-<id>`) with its own
 * catalog, cache, key, and Fast preferences. Requests go to the instance's
 * `/backend-api/codex/responses` endpoint through Pi AI's Codex transport
 * (WebSocket with SSE fallback). Manage instances with the `/cpa-*` commands.
 */

import { cleanupSessionResources, isRetryableAssistantError, openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands, resolveInstanceKey, updateFastStatus } from "../src/commands.ts";
import { resolvePaths } from "../src/config.ts";
import { normalizeTransientError } from "../src/retry.ts";
import { CpaRuntime } from "../src/runtime.ts";
import { CodexSessionTracker } from "../src/stream.ts";

/** Cached catalogs younger than this are not refetched when a session starts. */
const BACKGROUND_REFRESH_MIN_AGE_MS = 5 * 60_000;

function reportStartupProblems(ctx: ExtensionContext, runtime: CpaRuntime): void {
	const problems = [...runtime.configIssues.map((issue) => `config.json: ${issue}`)];
	for (const state of runtime.list()) {
		if (state.lastError && !state.catalog) {
			const hint = state.lastErrorIsAuth ? ` Run /cpa-edit ${state.config.id} to update the key.` : "";
			problems.push(`CPA "${state.config.name}" has no models: ${state.lastError}.${hint}`);
		}
	}
	if (problems.length > 0) ctx.ui.notify(problems.join("\n"), "warning");
}

async function refreshCachedCatalogs(ctx: ExtensionContext, runtime: CpaRuntime): Promise<void> {
	const stale = runtime
		.list()
		.filter((state) => state.fromCacheOnly && Date.now() - (state.catalog?.fetchedAt ?? 0) >= BACKGROUND_REFRESH_MIN_AGE_MS);
	await Promise.all(
		stale.map(async (state) => {
			try {
				await runtime.refresh(state.config.id, await resolveInstanceKey(ctx, runtime, state));
			} catch (error) {
				// The cached catalog stays registered; only an auth failure needs the user.
				if (state.lastErrorIsAuth) {
					ctx.ui.notify(
						`CPA "${state.config.name}" rejected its key (${error instanceof Error ? error.message : String(error)}). Run /cpa-edit ${state.config.id}.`,
						"warning",
					);
				}
			}
		}),
	);
	updateFastStatus(ctx, runtime);
}

export default async function piCpaProvider(pi: ExtensionAPI): Promise<void> {
	const paths = resolvePaths(getAgentDir());
	const sessions = new CodexSessionTracker((codexSessionId) => cleanupSessionResources(codexSessionId));
	const runtime = new CpaRuntime({
		host: pi,
		paths,
		codexStreamSimple: openAICodexResponsesApi().streamSimple,
		sessions,
		offline: process.env.PI_OFFLINE !== undefined,
	});
	registerCommands(pi, runtime);
	await runtime.init();

	pi.on("session_start", (event, ctx) => {
		updateFastStatus(ctx, runtime);
		if (event.reason === "startup" || event.reason === "reload") reportStartupProblems(ctx, runtime);
		if (process.env.PI_OFFLINE === undefined) void refreshCachedCatalogs(ctx, runtime);
	});

	pi.on("model_select", (_event, ctx) => updateFastStatus(ctx, runtime));

	pi.on("session_compact", (_event, ctx) => {
		sessions.markCompacted(ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", () => {
		// The extension runtime ends with the session; /new and /resume load a fresh one.
		runtime.stop();
		sessions.closeAll();
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !runtime.findByProvider(message.provider)) return;
		const normalized = normalizeTransientError(message, isRetryableAssistantError);
		return normalized ? { message: normalized } : undefined;
	});
}
