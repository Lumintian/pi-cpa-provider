/**
 * CPA base URL normalization.
 *
 * Preferred input is a plain origin such as `http://127.0.0.1:8317`. A path
 * prefix is kept (`/proxy` → `/proxy/backend-api`), `/v1` is rewritten to
 * `/backend-api`, and an explicit `/backend-api` is kept. Query and hash are
 * rejected rather than silently dropped.
 */

export const CLIENT_VERSION = "pi";

export interface CpaEndpoints {
	/** Normalized input, stored back into config so equal URLs compare equal. */
	baseUrl: string;
	/** Codex base passed to the model; Pi AI appends `/codex/responses`. */
	inferenceBaseUrl: string;
	/** Catalog endpoint, `{root}/v1/models?client_version=pi`. */
	modelsUrl: string;
}

export function resolveEndpoints(input: string): CpaEndpoints {
	let raw = input.trim();
	if (!raw) throw new Error("CPA base URL is empty");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid CPA base URL: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`CPA base URL must use http or https: ${input}`);
	}
	if (url.search || url.hash) {
		throw new Error(`CPA base URL must not contain a query or fragment: ${input}`);
	}
	if (url.username || url.password) {
		throw new Error("CPA base URL must not embed credentials; store the API key separately");
	}

	let root = url.pathname.replace(/\/+$/, "");
	if (root.endsWith("/backend-api")) root = root.slice(0, -"/backend-api".length);
	else if (root.endsWith("/v1")) root = root.slice(0, -"/v1".length);

	return {
		baseUrl: `${url.origin}${root}`,
		inferenceBaseUrl: `${url.origin}${root}/backend-api`,
		modelsUrl: `${url.origin}${root}/v1/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
	};
}
