/**
 * `/cpa-*` management commands. Instance setup lives here rather than in
 * `/login`, which only handles a single key prompt per provider.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CatalogModel, fetchCatalog } from "./catalog.ts";
import { assertEnvName, assertInstanceId, type InstanceConfig, loadConfig, providerIdFor, updateConfig } from "./config.ts";
import { deleteCredential, describeKeySource, resolveKeySync, storeApiKey } from "./credentials.ts";
import { resolveEndpoints } from "./endpoints.ts";
import { type CpaRuntime, type InstanceState, REFRESH_TIMEOUT_MS } from "./runtime.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
const STATUS_KEY = "pi-cpa-provider";
const KEY_FROM_AUTH = "Store the key in Pi auth.json";
const KEY_FROM_ENV = "Read the key from an environment variable";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Resolve a key through Pi (covers `!command` values), falling back to a direct read. */
export async function resolveInstanceKey(ctx: ExtensionContext, runtime: CpaRuntime, state: InstanceState): Promise<string | undefined> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(state.providerId);
		if (key) return key;
	} catch {
		// Fall through to the direct read.
	}
	return resolveKeySync(runtime.paths.authPath, state.providerId, state.config.apiKeyEnv);
}

export function updateFastStatus(ctx: ExtensionContext, runtime: CpaRuntime): void {
	if (!ctx.hasUI) return;
	const model = ctx.model;
	const state = model ? runtime.findByProvider(model.provider) : undefined;
	const active = model && state ? runtime.isFastEffective(state.config.id, model.id) : false;
	ctx.ui.setStatus(STATUS_KEY, active ? "fast" : undefined);
}

function instanceCompletions(runtime: CpaRuntime) {
	return (prefix: string) => {
		const items = runtime
			.list()
			.filter((state) => state.config.id.startsWith(prefix.trim()))
			.map((state) => ({ value: state.config.id, label: state.config.id, description: state.config.name }));
		return items.length > 0 ? items : null;
	};
}

async function pickInstance(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string, usage: string): Promise<InstanceState | undefined> {
	const id = args.trim();
	if (id) {
		const state = runtime.get(id);
		if (!state) ctx.ui.notify(`Unknown CPA instance "${id}". Run /cpa-list to see configured instances.`, "error");
		return state;
	}
	const states = runtime.list();
	if (states.length === 0) {
		ctx.ui.notify("No CPA instances configured. Run /cpa-add first.", "error");
		return undefined;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(`Usage: ${usage}`, "error");
		return undefined;
	}
	const labels = states.map((state) => `${state.config.id} — ${state.config.name}`);
	const choice = await ctx.ui.select("Choose a CPA instance", labels);
	return choice ? states[labels.indexOf(choice)] : undefined;
}

async function validateCatalog(ctx: ExtensionContext, baseUrl: string, apiKey: string): Promise<CatalogModel[] | undefined> {
	const { modelsUrl } = resolveEndpoints(baseUrl);
	ctx.ui.notify(`Checking ${modelsUrl} ...`, "info");
	try {
		return await fetchCatalog(modelsUrl, apiKey, { timeoutMs: REFRESH_TIMEOUT_MS });
	} catch (error) {
		ctx.ui.notify(`CPA check failed: ${errorMessage(error)}`, "error");
		return undefined;
	}
}

function formatAge(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 90) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function describeInstance(runtime: CpaRuntime, state: InstanceState): string {
	const source = describeKeySource(runtime.paths.authPath, state.providerId, state.config.apiKeyEnv);
	const key =
		source.kind === "auth"
			? "key: auth.json"
			: source.kind === "env"
				? `key: $${source.name}${process.env[source.name] ? "" : " (not set)"}`
				: "key: missing";
	const catalog = state.catalog
		? `${state.catalog.models.length} models, fetched ${formatAge(state.catalog.fetchedAt)}${state.fromCacheOnly ? " (cached)" : ""}`
		: "no models";
	const fast = Object.keys(state.config.fastModels);
	const lines = [
		`${state.config.id} — ${state.config.name}  [provider ${state.providerId}]`,
		`  ${state.config.baseUrl}  ·  ${key}  ·  ${catalog}${state.refreshing ? "  ·  refreshing" : ""}`,
	];
	if (fast.length > 0) lines.push(`  fast: ${fast.join(", ")}`);
	if (state.lastError) lines.push(`  last error: ${state.lastError}`);
	return lines.join("\n");
}

async function applyUpdate(
	ctx: ExtensionContext,
	runtime: CpaRuntime,
	mutate: (instances: InstanceConfig[]) => InstanceConfig[],
): Promise<boolean> {
	try {
		const next = updateConfig(runtime.paths, (config) => ({ instances: mutate(config.instances) }));
		runtime.applyConfig(next);
		updateFastStatus(ctx, runtime);
		return true;
	} catch (error) {
		ctx.ui.notify(`Failed to save CPA config: ${errorMessage(error)}`, "error");
		return false;
	}
}

async function promptKeySource(
	ctx: ExtensionCommandContext,
	instanceId: string,
): Promise<{ kind: "auth"; key: string } | { kind: "env"; name: string } | undefined> {
	const mode = await ctx.ui.select("Where should the API key come from?", [KEY_FROM_AUTH, KEY_FROM_ENV]);
	if (mode === KEY_FROM_AUTH) {
		const key = (await ctx.ui.input("CPA API key (stored only in Pi auth.json)", "sk-..."))?.trim();
		return key ? { kind: "auth", key } : undefined;
	}
	if (mode === KEY_FROM_ENV) {
		const suggestion = `CPA_${instanceId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		const name = (await ctx.ui.input("Environment variable name", suggestion))?.trim() || undefined;
		if (!name) return undefined;
		assertEnvName(name);
		return { kind: "env", name };
	}
	return undefined;
}

async function addInstance(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`/cpa-add needs an interactive UI; edit ${runtime.paths.configPath} instead.`, "error");
		return;
	}
	try {
		const id = (args.trim() || (await ctx.ui.input("Instance ID (lowercase, e.g. home)", "home"))?.trim()) ?? "";
		if (!id) return;
		assertInstanceId(id);
		if (runtime.get(id) || loadConfig(runtime.paths).config.instances.some((instance) => instance.id === id)) {
			ctx.ui.notify(`CPA instance "${id}" already exists. Use /cpa-edit ${id}.`, "error");
			return;
		}
		const name = (await ctx.ui.input("Display name", id))?.trim() || id;
		const baseUrlInput = (await ctx.ui.input("CPA base URL", DEFAULT_BASE_URL))?.trim() || DEFAULT_BASE_URL;
		const { baseUrl } = resolveEndpoints(baseUrlInput);
		const source = await promptKeySource(ctx, id);
		if (!source) return;

		const apiKey = source.kind === "auth" ? source.key : process.env[source.name];
		let models: CatalogModel[] | undefined;
		if (apiKey) {
			models = await validateCatalog(ctx, baseUrl, apiKey);
			if (!models) return;
		} else {
			const envName = source.kind === "env" ? source.name : "";
			const proceed = await ctx.ui.confirm(
				"Environment variable not set",
				`$${envName} is not set in this Pi process. Save the instance without checking it?`,
			);
			if (!proceed) return;
		}

		const providerId = providerIdFor(id);
		if (source.kind === "auth") storeApiKey(runtime.paths.authPath, providerId, source.key);
		else deleteCredential(runtime.paths.authPath, providerId);
		const instance: InstanceConfig = {
			id,
			name,
			baseUrl,
			...(source.kind === "env" ? { apiKeyEnv: source.name } : {}),
			fastModels: {},
		};
		if (!(await applyUpdate(ctx, runtime, (instances) => [...instances, instance]))) {
			if (source.kind === "auth") deleteCredential(runtime.paths.authPath, providerId);
			return;
		}
		const state = runtime.get(id);
		if (state && models) runtime.commitCatalog(state, models);
		ctx.ui.notify(
			`Added CPA "${name}" as provider ${providerId}${models ? ` with ${models.length} models` : ""}. Pick a model with /model.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Failed to add CPA instance: ${errorMessage(error)}`, "error");
	}
}

async function editInstance(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`/cpa-edit needs an interactive UI; edit ${runtime.paths.configPath} instead.`, "error");
		return;
	}
	const state = await pickInstance(ctx, runtime, args, "/cpa-edit <id>");
	if (!state) return;
	const { id } = state.config;
	const EDIT_NAME = "Display name";
	const EDIT_URL = "Base URL";
	const EDIT_KEY = "API key";
	try {
		const field = await ctx.ui.select(`Edit CPA "${state.config.name}" (${id})`, [EDIT_NAME, EDIT_URL, EDIT_KEY]);
		if (field === EDIT_NAME) {
			const name = (await ctx.ui.input("Display name", state.config.name))?.trim();
			if (!name || name === state.config.name) return;
			if (await applyUpdate(ctx, runtime, (instances) => instances.map((i) => (i.id === id ? { ...i, name } : i)))) {
				ctx.ui.notify(`Renamed CPA "${id}" to "${name}".`, "info");
			}
			return;
		}
		if (field === EDIT_URL) {
			const input = (await ctx.ui.input("CPA base URL", state.config.baseUrl))?.trim();
			if (!input) return;
			const { baseUrl } = resolveEndpoints(input);
			if (baseUrl === state.config.baseUrl) return;
			const apiKey = await resolveInstanceKey(ctx, runtime, state);
			const models = apiKey ? await validateCatalog(ctx, baseUrl, apiKey) : undefined;
			if (!models && !(await ctx.ui.confirm("Save unchecked URL?", `${baseUrl} could not be checked. Save it anyway?`))) return;
			if (!(await applyUpdate(ctx, runtime, (instances) => instances.map((i) => (i.id === id ? { ...i, baseUrl } : i))))) return;
			const updated = runtime.get(id);
			if (updated && models) runtime.commitCatalog(updated, models);
			ctx.ui.notify(`CPA "${id}" now uses ${baseUrl}${models ? ` (${models.length} models)` : ""}.`, "info");
			return;
		}
		if (field === EDIT_KEY) {
			const source = await promptKeySource(ctx, id);
			if (!source) return;
			const apiKey = source.kind === "auth" ? source.key : process.env[source.name];
			const models = apiKey ? await validateCatalog(ctx, state.config.baseUrl, apiKey) : undefined;
			if (apiKey && !models) return;
			if (!apiKey && !(await ctx.ui.confirm("Environment variable not set", "It is not set in this Pi process. Save anyway?"))) return;
			if (source.kind === "auth") storeApiKey(runtime.paths.authPath, state.providerId, source.key);
			else deleteCredential(runtime.paths.authPath, state.providerId);
			const saved = await applyUpdate(ctx, runtime, (instances) =>
				instances.map((i) => {
					if (i.id !== id) return i;
					const { apiKeyEnv: _previous, ...rest } = i;
					return source.kind === "env" ? { ...rest, apiKeyEnv: source.name } : rest;
				}),
			);
			if (!saved) return;
			const updated = runtime.get(id);
			if (updated && models) runtime.commitCatalog(updated, models);
			ctx.ui.notify(
				source.kind === "auth"
					? `Stored a new key for CPA "${id}" in auth.json.`
					: `CPA "${id}" now reads its key from $${source.name}.`,
				"info",
			);
		}
	} catch (error) {
		ctx.ui.notify(`Failed to edit CPA instance: ${errorMessage(error)}`, "error");
	}
}

async function removeInstance(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string): Promise<void> {
	const state = await pickInstance(ctx, runtime, args, "/cpa-remove <id>");
	if (!state) return;
	const { id, name, apiKeyEnv } = state.config;
	if (ctx.hasUI && !(await ctx.ui.confirm(`Remove CPA "${name}"?`, `Deletes its config entry, its auth.json key (${state.providerId}), and its model cache.`))) {
		return;
	}
	try {
		updateConfig(runtime.paths, (config) => ({ instances: config.instances.filter((i) => i.id !== id) }));
	} catch (error) {
		ctx.ui.notify(`Failed to save CPA config: ${errorMessage(error)}`, "error");
		return;
	}
	runtime.remove(id, { deleteCache: true });
	const notes: string[] = [];
	try {
		deleteCredential(runtime.paths.authPath, state.providerId);
	} catch (error) {
		notes.push(`could not delete its auth.json entry: ${errorMessage(error)}`);
	}
	if (apiKeyEnv) notes.push(`$${apiKeyEnv} is still set in your environment`);
	if (ctx.model?.provider === state.providerId) notes.push("the current model belonged to it; pick another with /model");
	updateFastStatus(ctx, runtime);
	ctx.ui.notify(`Removed CPA "${name}".${notes.length > 0 ? ` Note: ${notes.join("; ")}.` : ""}`, notes.length > 0 ? "warning" : "info");
}

async function refreshInstances(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string): Promise<void> {
	const id = args.trim();
	const targets = id ? [runtime.get(id)] : runtime.list();
	if (id && !targets[0]) {
		ctx.ui.notify(`Unknown CPA instance "${id}".`, "error");
		return;
	}
	if (targets.length === 0) {
		ctx.ui.notify("No CPA instances configured. Run /cpa-add first.", "error");
		return;
	}
	const results = await Promise.all(
		(targets as InstanceState[]).map(async (state) => {
			try {
				const outcome = await runtime.refresh(state.config.id, await resolveInstanceKey(ctx, runtime, state));
				if (outcome.status === "ok") return { ok: true, line: `${state.config.id}: ${outcome.modelCount} models` };
				if (outcome.status === "no-key") return { ok: false, line: `${state.config.id}: no API key (run /cpa-edit ${state.config.id})` };
				return { ok: true, line: `${state.config.id}: superseded by a newer refresh` };
			} catch (error) {
				const kept = state.catalog ? `; kept ${state.catalog.models.length} cached models` : "";
				return { ok: false, line: `${state.config.id}: ${errorMessage(error)}${kept}` };
			}
		}),
	);
	updateFastStatus(ctx, runtime);
	const failed = results.some((result) => !result.ok);
	ctx.ui.notify(`CPA refresh:\n${results.map((result) => result.line).join("\n")}`, failed ? "warning" : "info");
}

async function fastCommand(ctx: ExtensionCommandContext, runtime: CpaRuntime, args: string): Promise<void> {
	const model = ctx.model;
	const state = model ? runtime.findByProvider(model.provider) : undefined;
	if (!model || !state) {
		ctx.ui.notify("Fast applies to CPA models; the current model is not one.", "error");
		return;
	}
	const { id } = state.config;
	const supported = runtime.supportsPriority(id, model.id);
	const enabled = state.config.fastModels[model.id] === true;
	const label = `${state.providerId}/${model.id}`;
	const describe = () =>
		`Fast for ${label}: ${enabled ? "on" : "off"}${supported ? "" : " (catalog does not list the priority tier)"}`;

	let action = args.trim().toLowerCase();
	if (!action) {
		if (!ctx.hasUI) action = "status";
		else {
			const ON = "Turn Fast on";
			const OFF = "Turn Fast off";
			const choice = await ctx.ui.select(describe(), [ON, OFF]);
			if (!choice) return;
			action = choice === ON ? "on" : "off";
		}
	}
	if (action === "status") {
		ctx.ui.notify(describe(), "info");
		return;
	}
	if (action !== "on" && action !== "off") {
		ctx.ui.notify("Usage: /cpa-fast [on|off|status]", "error");
		return;
	}
	const next = action === "on";
	if (next && !supported) {
		ctx.ui.notify(`${label} does not advertise the priority service tier; Fast was not enabled.`, "error");
		return;
	}
	if (next === enabled) {
		ctx.ui.notify(describe(), "info");
		return;
	}
	const saved = await applyUpdate(ctx, runtime, (instances) =>
		instances.map((instance) => {
			if (instance.id !== id) return instance;
			const fastModels = { ...instance.fastModels };
			if (next) fastModels[model.id] = true;
			else delete fastModels[model.id];
			return { ...instance, fastModels };
		}),
	);
	if (saved) ctx.ui.notify(`Fast ${next ? "on" : "off"} for ${label}.`, "info");
}

export function registerCommands(pi: ExtensionAPI, runtime: CpaRuntime): void {
	const complete = instanceCompletions(runtime);

	pi.registerCommand("cpa-list", {
		description: "List configured CPA instances, key sources, and catalog status",
		handler: async (_args, ctx) => {
			const states = runtime.list();
			const lines = states.map((state) => describeInstance(runtime, state));
			if (runtime.configIssues.length > 0) lines.push(`config.json problems:\n  ${runtime.configIssues.join("\n  ")}`);
			if (lines.length === 0) lines.push("No CPA instances configured. Run /cpa-add.");
			lines.push(`Config: ${runtime.paths.configPath}`, "Model prices are not tracked locally; $0 means unknown, not free.");
			ctx.ui.notify(lines.join("\n"), runtime.configIssues.length > 0 ? "warning" : "info");
		},
	});
	pi.registerCommand("cpa-add", {
		description: "Add a CPA instance (ID, name, URL, key) and fetch its models",
		handler: (args, ctx) => addInstance(ctx, runtime, args),
	});
	pi.registerCommand("cpa-edit", {
		description: "Change a CPA instance's name, URL, or API key",
		getArgumentCompletions: complete,
		handler: (args, ctx) => editInstance(ctx, runtime, args),
	});
	pi.registerCommand("cpa-remove", {
		description: "Remove a CPA instance with its key and model cache",
		getArgumentCompletions: complete,
		handler: (args, ctx) => removeInstance(ctx, runtime, args),
	});
	pi.registerCommand("cpa-refresh", {
		description: "Refresh model catalogs: /cpa-refresh [id] (all instances when omitted)",
		getArgumentCompletions: complete,
		handler: (args, ctx) => refreshInstances(ctx, runtime, args),
	});
	pi.registerCommand("cpa-fast", {
		description: "Show or set Fast (priority tier) for the current CPA model: /cpa-fast [on|off|status]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: (args, ctx) => fastCommand(ctx, runtime, args),
	});
}
