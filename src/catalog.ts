/**
 * CPA model catalog: fetch `/v1/models`, map entries to Pi models, and keep a
 * per-instance snapshot on disk.
 *
 * No local pricing: CPA bills upstream, so cost fields are zero placeholders
 * meaning "unknown", not "free".
 */

import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { assertInstanceId } from "./config.ts";
import { parseJsonText, readTextIfExists, removeFileIfExists, writeFileAtomic } from "./fs-utils.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
const CACHE_VERSION = 1;
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

interface RawReasoningLevel {
	effort?: unknown;
}

interface RawServiceTier {
	id?: unknown;
}

/** Subset of a Codex-style `/v1/models` entry that CPA returns. */
export interface RawCatalogModel {
	slug?: unknown;
	id?: unknown;
	display_name?: unknown;
	name?: unknown;
	context_window?: unknown;
	max_context_window?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	max_completion_tokens?: unknown;
	input_modalities?: unknown;
	supported_reasoning_levels?: unknown;
	service_tiers?: unknown;
	visibility?: unknown;
}

/** Instance-independent model entry stored in the cache. */
export interface CatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	/** The catalog explicitly lists the `priority` service tier. */
	supportsPriority: boolean;
}

export interface CatalogSnapshot {
	modelsUrl: string;
	fetchedAt: number;
	models: CatalogModel[];
}

export class CatalogHttpError extends Error {
	readonly status: number;

	constructor(status: number, statusText: string, body: string) {
		const detail = body.trim() ? `: ${body.trim().slice(0, 200)}` : "";
		super(`models request failed with HTTP ${status} ${statusText}${detail}`);
		this.name = "CatalogHttpError";
		this.status = status;
	}
}

export function isAuthError(error: unknown): boolean {
	return error instanceof CatalogHttpError && (error.status === 401 || error.status === 403);
}

function positiveInt(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function reasoningEfforts(raw: RawCatalogModel): string[] {
	if (!Array.isArray(raw.supported_reasoning_levels)) return [];
	const efforts: string[] = [];
	for (const entry of raw.supported_reasoning_levels as Array<string | RawReasoningLevel>) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (normalized && !efforts.includes(normalized)) efforts.push(normalized);
	}
	return efforts;
}

export function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap | undefined {
	if (efforts.length === 0) return undefined;
	const supported = new Set(efforts);
	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") map.off = supported.has("none") ? "none" : null;
		else map[level] = supported.has(level) ? level : null;
	}
	return map;
}

function inputModalities(raw: RawCatalogModel): Array<"text" | "image"> {
	const input: Array<"text" | "image"> = ["text"];
	if (Array.isArray(raw.input_modalities)) {
		for (const modality of raw.input_modalities) {
			if (String(modality).trim().toLowerCase() === "image" && !input.includes("image")) input.push("image");
		}
	}
	return input;
}

/** Fast requires an explicit `priority` tier; a non-empty tier list alone is not enough. */
export function supportsPriorityTier(raw: RawCatalogModel): boolean {
	if (!Array.isArray(raw.service_tiers)) return false;
	return (raw.service_tiers as Array<string | RawServiceTier>).some((tier) => {
		const id = typeof tier === "string" ? tier : typeof tier?.id === "string" ? tier.id : "";
		return id.trim().toLowerCase() === "priority";
	});
}

export function toCatalogModel(raw: RawCatalogModel): CatalogModel | undefined {
	const id = nonEmptyString(raw.slug, raw.id);
	if (!id) return undefined;
	if (String(raw.visibility ?? "").toLowerCase() === "hide") return undefined;
	const efforts = reasoningEfforts(raw);
	const thinkingLevelMap = buildThinkingLevelMap(efforts);
	return {
		id,
		name: nonEmptyString(raw.display_name, raw.name) ?? id,
		reasoning: efforts.some((effort) => effort !== "none"),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: inputModalities(raw),
		contextWindow: positiveInt(raw.context_window, raw.max_context_window) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveInt(raw.max_tokens, raw.max_output_tokens, raw.max_completion_tokens) ?? DEFAULT_MAX_TOKENS,
		supportsPriority: supportsPriorityTier(raw),
	};
}

/** Map a raw catalog, dropping unusable entries and duplicate IDs (first wins). */
export function mapCatalog(rawModels: RawCatalogModel[]): CatalogModel[] {
	const models: CatalogModel[] = [];
	const seen = new Set<string>();
	for (const raw of rawModels) {
		const model = raw && typeof raw === "object" ? toCatalogModel(raw) : undefined;
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export function extractCatalogEntries(payload: unknown): RawCatalogModel[] {
	if (Array.isArray(payload)) return payload as RawCatalogModel[];
	if (payload && typeof payload === "object") {
		const obj = payload as { models?: unknown; data?: unknown };
		if (Array.isArray(obj.models)) return obj.models as RawCatalogModel[];
		if (Array.isArray(obj.data)) return obj.data as RawCatalogModel[];
	}
	throw new Error("models response is not a model list (expected an array, {models: [...]}, or {data: [...]})");
}

export interface FetchCatalogOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export async function fetchCatalog(modelsUrl: string, apiKey: string, options: FetchCatalogOptions): Promise<CatalogModel[]> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(modelsUrl, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal,
		});
	} catch (error) {
		if (timeout.aborted && !options.signal?.aborted) {
			throw new Error(`models request timed out after ${options.timeoutMs} ms`);
		}
		throw error;
	}
	if (!response.ok) {
		throw new CatalogHttpError(response.status, response.statusText, await response.text().catch(() => ""));
	}
	const text = await response.text();
	return mapCatalog(extractCatalogEntries(parseJsonText(text, "models response")));
}

/** Pi model definition for one instance; the instance name disambiguates same-ID models. */
export function toProviderModel(model: CatalogModel, instanceName: string): ProviderModelConfig {
	return {
		id: model.id,
		name: `${model.name} (${instanceName})`,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function cachePathFor(cacheDir: string, instanceId: string): string {
	assertInstanceId(instanceId);
	return join(cacheDir, `${instanceId}.json`);
}

function isCatalogModel(value: unknown): value is CatalogModel {
	if (!value || typeof value !== "object") return false;
	const model = value as Partial<CatalogModel>;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		typeof model.contextWindow === "number" &&
		typeof model.maxTokens === "number" &&
		typeof model.supportsPriority === "boolean"
	);
}

/** Load a snapshot only if it was fetched from the instance's current catalog URL. */
export function loadCatalogCache(cacheDir: string, instanceId: string, modelsUrl: string): CatalogSnapshot | undefined {
	try {
		const text = readTextIfExists(cachePathFor(cacheDir, instanceId));
		if (!text) return undefined;
		const data = parseJsonText(text, "catalog cache") as Partial<CatalogSnapshot> & { version?: unknown };
		if (
			data.version !== CACHE_VERSION ||
			data.modelsUrl !== modelsUrl ||
			typeof data.fetchedAt !== "number" ||
			!Array.isArray(data.models) ||
			!data.models.every(isCatalogModel)
		) {
			return undefined;
		}
		return { modelsUrl: data.modelsUrl, fetchedAt: data.fetchedAt, models: data.models };
	} catch {
		return undefined;
	}
}

export function saveCatalogCache(cacheDir: string, instanceId: string, snapshot: CatalogSnapshot): void {
	writeFileAtomic(cachePathFor(cacheDir, instanceId), `${JSON.stringify({ version: CACHE_VERSION, ...snapshot }, null, 2)}\n`);
}

export function deleteCatalogCache(cacheDir: string, instanceId: string): void {
	removeFileIfExists(cachePathFor(cacheDir, instanceId));
}
