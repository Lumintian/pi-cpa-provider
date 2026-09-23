/**
 * Non-secret plugin configuration: `<agentDir>/extensions/pi-cpa-provider/config.json`.
 *
 * API keys never live here. Each instance's key is either the Pi auth.json
 * credential of its provider ID, or an environment variable named by
 * `apiKeyEnv`.
 */

import { join } from "node:path";
import { resolveEndpoints } from "./endpoints.ts";
import { parseJsonText, readTextIfExists, withFileLock, writeFileAtomic } from "./fs-utils.ts";

export const PLUGIN_DIR_NAME = "pi-cpa-provider";
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INSTANCE_KEYS = new Set(["id", "name", "baseUrl", "apiKeyEnv", "fastModels"]);

export interface InstanceConfig {
	/** Stable, path-safe ID. The Pi provider ID is `cpa-<id>`. */
	id: string;
	name: string;
	baseUrl: string;
	/** Read the key from this environment variable when auth.json has no credential. */
	apiKeyEnv?: string;
	/** Model IDs with Fast (priority service tier) enabled. Absent means off. */
	fastModels: Record<string, true>;
}

export interface CpaConfig {
	instances: InstanceConfig[];
}

export interface LoadedConfig {
	config: CpaConfig;
	/** Per-instance problems; the affected instances are skipped. */
	issues: string[];
}

export interface CpaPaths {
	agentDir: string;
	dataDir: string;
	configPath: string;
	cacheDir: string;
	authPath: string;
}

export function resolvePaths(agentDir: string): CpaPaths {
	const dataDir = join(agentDir, "extensions", PLUGIN_DIR_NAME);
	return {
		agentDir,
		dataDir,
		configPath: join(dataDir, "config.json"),
		cacheDir: join(dataDir, "cache"),
		authPath: join(agentDir, "auth.json"),
	};
}

export function providerIdFor(instanceId: string): string {
	return `cpa-${instanceId}`;
}

export function assertInstanceId(id: string): void {
	if (!INSTANCE_ID_PATTERN.test(id)) {
		throw new Error(
			`Invalid instance ID "${id}": use 1-32 lowercase letters, digits, "-" or "_", starting with a letter or digit`,
		);
	}
}

export function assertEnvName(name: string): void {
	if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment variable name "${name}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstance(raw: unknown, index: number): InstanceConfig {
	if (!isRecord(raw)) throw new Error(`instances[${index}] must be an object`);
	if ("apiKey" in raw || "key" in raw) {
		throw new Error(
			`instances[${index}] contains an API key; keys belong in Pi auth.json (use /cpa-edit) or an environment variable named by "apiKeyEnv"`,
		);
	}
	const unknown = Object.keys(raw).filter((key) => !INSTANCE_KEYS.has(key));
	if (unknown.length > 0) throw new Error(`instances[${index}] has unknown field(s): ${unknown.join(", ")}`);

	if (typeof raw.id !== "string") throw new Error(`instances[${index}].id must be a string`);
	assertInstanceId(raw.id);
	if (typeof raw.baseUrl !== "string") throw new Error(`instance "${raw.id}": baseUrl must be a string`);
	const { baseUrl } = resolveEndpoints(raw.baseUrl);
	if (raw.name !== undefined && (typeof raw.name !== "string" || !raw.name.trim())) {
		throw new Error(`instance "${raw.id}": name must be a non-empty string`);
	}
	if (raw.apiKeyEnv !== undefined) {
		if (typeof raw.apiKeyEnv !== "string") throw new Error(`instance "${raw.id}": apiKeyEnv must be a string`);
		assertEnvName(raw.apiKeyEnv);
	}
	const fastModels: Record<string, true> = {};
	if (raw.fastModels !== undefined) {
		if (!isRecord(raw.fastModels)) throw new Error(`instance "${raw.id}": fastModels must be an object`);
		for (const [modelId, enabled] of Object.entries(raw.fastModels)) {
			if (typeof enabled !== "boolean") {
				throw new Error(`instance "${raw.id}": fastModels["${modelId}"] must be a boolean`);
			}
			if (enabled) fastModels[modelId] = true;
		}
	}
	return {
		id: raw.id,
		name: typeof raw.name === "string" ? raw.name.trim() : raw.id,
		baseUrl,
		...(raw.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv } : {}),
		fastModels,
	};
}

/** Parse config text. A malformed file throws; a malformed instance is reported and skipped. */
export function parseConfig(text: string | undefined): LoadedConfig {
	if (text === undefined || !text.trim()) return { config: { instances: [] }, issues: [] };
	const raw = parseJsonText(text, "config.json");
	if (!isRecord(raw)) throw new Error("config.json must contain a JSON object");
	if (raw.instances === undefined) return { config: { instances: [] }, issues: [] };
	if (!Array.isArray(raw.instances)) throw new Error("config.json field \"instances\" must be an array");

	const instances: InstanceConfig[] = [];
	const issues: string[] = [];
	const seen = new Set<string>();
	raw.instances.forEach((entry, index) => {
		try {
			const instance = parseInstance(entry, index);
			if (seen.has(instance.id)) throw new Error(`duplicate instance ID "${instance.id}"`);
			seen.add(instance.id);
			instances.push(instance);
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	});
	return { config: { instances }, issues };
}

export function serializeConfig(config: CpaConfig): string {
	const instances = config.instances.map((instance) => ({
		id: instance.id,
		name: instance.name,
		baseUrl: instance.baseUrl,
		...(instance.apiKeyEnv ? { apiKeyEnv: instance.apiKeyEnv } : {}),
		fastModels: Object.fromEntries(Object.keys(instance.fastModels).sort().map((id) => [id, true])),
	}));
	return `${JSON.stringify({ instances }, null, 2)}\n`;
}

export function loadConfig(paths: CpaPaths): LoadedConfig {
	return parseConfig(readTextIfExists(paths.configPath));
}

/**
 * Read-modify-write the config under a lock so concurrent Pi processes do not
 * drop each other's changes. Refuses to write while any instance on disk is
 * invalid, because rewriting would silently delete it.
 */
export function updateConfig(paths: CpaPaths, mutate: (config: CpaConfig) => CpaConfig): CpaConfig {
	return withFileLock(paths.configPath, () => {
		const text = readTextIfExists(paths.configPath);
		const { config, issues } = parseConfig(text);
		if (issues.length > 0) {
			throw new Error(`config.json has invalid instances; fix them before editing: ${issues.join("; ")}`);
		}
		const next = mutate(config);
		writeFileAtomic(paths.configPath, serializeConfig(next));
		return next;
	});
}
