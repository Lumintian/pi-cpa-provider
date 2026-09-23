/**
 * Per-instance API keys in Pi's auth.json.
 *
 * Each instance owns exactly one entry, keyed by its provider ID, of type
 * `api_key`. Pi resolves `$NAME` templates and leading `!command` values in
 * stored keys, so literal keys are escaped on write.
 */

import { writeFileSync } from "node:fs";
import { parseJsonText, readTextIfExists, withFileLock } from "./fs-utils.ts";

export type KeySource = { kind: "auth" } | { kind: "env"; name: string } | { kind: "none" };

interface StoredCredential {
	type?: unknown;
	key?: unknown;
	env?: unknown;
}

/** Escape a literal key so Pi's config-value resolver returns it unchanged. */
export function escapeConfigValue(value: string): string {
	const escaped = value.replaceAll("$", "$$$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/**
 * Resolve a stored api_key value the way Pi does, for use before a session
 * context exists. Shell-command values (`!cmd`) are not executed here; the
 * caller falls back to Pi's own resolution once a context is available.
 */
export function resolveStoredKey(value: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (value.startsWith("!")) return undefined;
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch !== "$") {
			out += ch;
			continue;
		}
		const next = value[i + 1];
		if (next === "$" || next === "!") {
			out += next;
			i++;
			continue;
		}
		const braced = next === "{" ? value.slice(i + 2).match(/^([A-Za-z_][A-Za-z0-9_]*)\}/) : null;
		const bare = braced ? null : value.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
		const name = braced?.[1] ?? bare?.[0];
		if (!name) {
			out += ch;
			continue;
		}
		const resolved = env[name];
		if (resolved === undefined || resolved === "") return undefined;
		out += resolved;
		i += braced ? name.length + 2 : name.length;
	}
	return out || undefined;
}

function readAuthData(authPath: string): Record<string, unknown> {
	const text = readTextIfExists(authPath);
	if (text === undefined || !text.trim()) return {};
	const data = parseJsonText(text, "auth.json");
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("auth.json must contain an object");
	return data as Record<string, unknown>;
}

export function readStoredCredential(authPath: string, providerId: string): StoredCredential | undefined {
	const entry = readAuthData(authPath)[providerId];
	return typeof entry === "object" && entry !== null ? (entry as StoredCredential) : undefined;
}

export function hasStoredKey(authPath: string, providerId: string): boolean {
	try {
		const entry = readStoredCredential(authPath, providerId);
		return entry?.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0;
	} catch {
		return false;
	}
}

/** Resolve an instance key without a Pi context: auth.json first, then `apiKeyEnv`. */
export function resolveKeySync(authPath: string, providerId: string, apiKeyEnv?: string): string | undefined {
	try {
		const entry = readStoredCredential(authPath, providerId);
		if (entry?.type === "api_key" && typeof entry.key === "string") {
			const env = typeof entry.env === "object" && entry.env !== null ? (entry.env as Record<string, string>) : {};
			return resolveStoredKey(entry.key, { ...process.env, ...env });
		}
	} catch {
		// Unreadable auth.json: fall through to the environment.
	}
	return apiKeyEnv ? process.env[apiKeyEnv] || undefined : undefined;
}

export function describeKeySource(authPath: string, providerId: string, apiKeyEnv?: string): KeySource {
	if (hasStoredKey(authPath, providerId)) return { kind: "auth" };
	if (apiKeyEnv) return { kind: "env", name: apiKeyEnv };
	return { kind: "none" };
}

function writeAuthData(authPath: string, data: Record<string, unknown>): void {
	// Match Pi: in-place write under the lock, 0600 only when creating the file.
	writeFileSync(authPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function storeApiKey(authPath: string, providerId: string, key: string): void {
	withFileLock(authPath, () => {
		const data = readAuthData(authPath);
		data[providerId] = { type: "api_key", key: escapeConfigValue(key) };
		writeAuthData(authPath, data);
	});
}

export function deleteCredential(authPath: string, providerId: string): boolean {
	return withFileLock(authPath, () => {
		const data = readAuthData(authPath);
		if (!(providerId in data)) return false;
		delete data[providerId];
		writeAuthData(authPath, data);
		return true;
	});
}
