/**
 * Instance registry: one Pi provider per configured CPA instance, each with
 * its own catalog, cache, refresh state, and stream handler. A failing
 * instance never blocks or clears another.
 */

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	type CatalogModel,
	type CatalogSnapshot,
	deleteCatalogCache,
	fetchCatalog,
	isAuthError,
	loadCatalogCache,
	saveCatalogCache,
	toProviderModel,
} from "./catalog.ts";
import { type CpaConfig, type CpaPaths, type InstanceConfig, loadConfig, providerIdFor } from "./config.ts";
import { resolveKeySync } from "./credentials.ts";
import { type CpaEndpoints, resolveEndpoints } from "./endpoints.ts";
import { CPA_API, type CodexSessionTracker, createCpaStreamSimple, type StreamSimpleFn } from "./stream.ts";

/** Startup waits this long for an instance with no cache before registering it empty. */
export const STARTUP_FETCH_TIMEOUT_MS = 15_000;
export const REFRESH_TIMEOUT_MS = 60_000;

export interface ProviderHost {
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
}

export interface InstanceState {
	config: InstanceConfig;
	providerId: string;
	endpoints: CpaEndpoints;
	/** Last successful catalog; kept when a refresh fails. */
	catalog?: CatalogSnapshot;
	/** Registered from the disk cache and not yet refreshed in this process. */
	fromCacheOnly: boolean;
	refreshing: boolean;
	lastError?: string;
	lastErrorIsAuth?: boolean;
	generation: number;
	controller?: AbortController;
	streamSimple: StreamSimpleFn;
	registeredEnvKey?: string;
}

export type RefreshOutcome =
	| { status: "ok"; modelCount: number }
	| { status: "superseded" }
	| { status: "no-key" };

export interface RuntimeOptions {
	host: ProviderHost;
	paths: CpaPaths;
	codexStreamSimple: StreamSimpleFn;
	sessions: CodexSessionTracker;
	fetch?: typeof globalThis.fetch;
	offline?: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class CpaRuntime {
	private readonly states = new Map<string, InstanceState>();
	private stopped = false;
	/** Problems found while loading config.json. */
	configIssues: string[] = [];
	private readonly options: RuntimeOptions;

	constructor(options: RuntimeOptions) {
		this.options = options;
	}

	get paths(): CpaPaths {
		return this.options.paths;
	}

	list(): InstanceState[] {
		return [...this.states.values()];
	}

	get(instanceId: string): InstanceState | undefined {
		return this.states.get(instanceId);
	}

	findByProvider(providerId: string): InstanceState | undefined {
		return this.list().find((state) => state.providerId === providerId);
	}

	/** Load config and caches, register every instance, and fetch catalogs that have no cache. */
	async init(): Promise<void> {
		let config: CpaConfig = { instances: [] };
		try {
			const loaded = loadConfig(this.paths);
			config = loaded.config;
			this.configIssues = loaded.issues;
		} catch (error) {
			this.configIssues = [errorMessage(error)];
		}
		this.applyConfig(config);
		if (this.options.offline) return;

		await Promise.allSettled(
			this.list()
				.filter((state) => !state.catalog)
				.map(async (state) => {
					const apiKey = resolveKeySync(this.paths.authPath, state.providerId, state.config.apiKeyEnv);
					if (!apiKey) return;
					try {
						await this.refresh(state.config.id, apiKey, STARTUP_FETCH_TIMEOUT_MS);
					} catch {
						// Recorded in lastError; reported at session start.
					}
				}),
		);
	}

	/** Reconcile running instances with a config: add, update, and remove providers. */
	applyConfig(config: CpaConfig): void {
		const wanted = new Set(config.instances.map((instance) => instance.id));
		for (const id of [...this.states.keys()]) {
			if (!wanted.has(id)) this.remove(id);
		}
		for (const instance of config.instances) {
			const existing = this.states.get(instance.id);
			const endpoints = resolveEndpoints(instance.baseUrl);
			if (!existing) {
				const catalog = loadCatalogCache(this.paths.cacheDir, instance.id, endpoints.modelsUrl);
				const state: InstanceState = {
					config: instance,
					providerId: providerIdFor(instance.id),
					endpoints,
					catalog,
					fromCacheOnly: catalog !== undefined,
					refreshing: false,
					generation: 0,
					streamSimple: createCpaStreamSimple({
						instanceId: instance.id,
						codexStreamSimple: this.options.codexStreamSimple,
						sessions: this.options.sessions,
						isFast: (modelId) => this.isFastEffective(instance.id, modelId),
					}),
				};
				this.states.set(instance.id, state);
				this.register(state);
				continue;
			}
			const urlChanged = existing.endpoints.modelsUrl !== endpoints.modelsUrl;
			existing.config = instance;
			if (urlChanged) {
				this.cancelRefresh(existing);
				this.options.sessions.closeForInstance(instance.id);
				existing.endpoints = endpoints;
				existing.catalog = loadCatalogCache(this.paths.cacheDir, instance.id, endpoints.modelsUrl);
				existing.fromCacheOnly = existing.catalog !== undefined;
				existing.lastError = undefined;
				existing.lastErrorIsAuth = undefined;
			}
			this.register(existing);
		}
	}

	/** Fetch one instance's catalog and re-register it. A failure keeps the previous catalog. */
	async refresh(instanceId: string, apiKey: string | undefined, timeoutMs = REFRESH_TIMEOUT_MS): Promise<RefreshOutcome> {
		const state = this.states.get(instanceId);
		if (!state) throw new Error(`Unknown CPA instance "${instanceId}"`);
		if (!apiKey) return { status: "no-key" };

		this.cancelRefresh(state);
		const generation = ++state.generation;
		const controller = new AbortController();
		state.controller = controller;
		state.refreshing = true;
		const isCurrent = () => !this.stopped && this.states.get(instanceId) === state && state.generation === generation;
		try {
			const models = await fetchCatalog(state.endpoints.modelsUrl, apiKey, {
				timeoutMs,
				signal: controller.signal,
				fetch: this.options.fetch,
			});
			if (!isCurrent()) return { status: "superseded" };
			this.commitCatalog(state, models);
			return { status: "ok", modelCount: models.length };
		} catch (error) {
			if (!isCurrent()) return { status: "superseded" };
			state.lastError = errorMessage(error);
			state.lastErrorIsAuth = isAuthError(error);
			throw error;
		} finally {
			if (state.generation === generation) {
				state.refreshing = false;
				state.controller = undefined;
			}
		}
	}

	/** Install a catalog fetched elsewhere (for example while validating a new key). */
	commitCatalog(state: InstanceState, models: CatalogModel[]): void {
		const snapshot: CatalogSnapshot = { modelsUrl: state.endpoints.modelsUrl, fetchedAt: Date.now(), models };
		try {
			saveCatalogCache(this.paths.cacheDir, state.config.id, snapshot);
		} catch (error) {
			console.warn(`[pi-cpa-provider] failed to write catalog cache for "${state.config.id}": ${errorMessage(error)}`);
		}
		state.catalog = snapshot;
		state.fromCacheOnly = false;
		state.lastError = undefined;
		state.lastErrorIsAuth = undefined;
		this.register(state);
	}

	/** Unregister an instance, close its sockets, and drop its cache file. */
	remove(instanceId: string, options: { deleteCache?: boolean } = {}): void {
		const state = this.states.get(instanceId);
		if (state) {
			this.cancelRefresh(state);
			state.generation++;
			this.states.delete(instanceId);
			this.options.sessions.closeForInstance(instanceId);
			this.options.host.unregisterProvider(state.providerId);
		}
		if (options.deleteCache) {
			try {
				deleteCatalogCache(this.paths.cacheDir, instanceId);
			} catch (error) {
				console.warn(`[pi-cpa-provider] failed to delete catalog cache for "${instanceId}": ${errorMessage(error)}`);
			}
		}
	}

	supportsPriority(instanceId: string, modelId: string): boolean {
		return this.states.get(instanceId)?.catalog?.models.some((model) => model.id === modelId && model.supportsPriority) ?? false;
	}

	isFastEffective(instanceId: string, modelId: string): boolean {
		const state = this.states.get(instanceId);
		return state?.config.fastModels[modelId] === true && this.supportsPriority(instanceId, modelId);
	}

	stop(): void {
		this.stopped = true;
		for (const state of this.states.values()) this.cancelRefresh(state);
	}

	private cancelRefresh(state: InstanceState): void {
		state.controller?.abort();
		state.controller = undefined;
		state.refreshing = false;
	}

	private register(state: InstanceState): void {
		const envKey = state.config.apiKeyEnv ? `$${state.config.apiKeyEnv}` : undefined;
		// Re-registration merges over the previous config and keeps omitted
		// fields, so a removed env reference needs a clean registration.
		if (state.registeredEnvKey !== undefined && envKey === undefined) {
			this.options.host.unregisterProvider(state.providerId);
		}
		this.options.host.registerProvider(state.providerId, {
			name: `CPA ${state.config.name}`,
			baseUrl: state.endpoints.inferenceBaseUrl,
			api: CPA_API,
			streamSimple: state.streamSimple,
			...(envKey ? { apiKey: envKey } : {}),
			models: (state.catalog?.models ?? []).map((model) => toProviderModel(model, state.config.name)),
		});
		state.registeredEnvKey = envKey;
	}
}
