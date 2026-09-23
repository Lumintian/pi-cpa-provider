import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { type CpaPaths, resolvePaths } from "../src/config.ts";

/** Fresh agent directory, removed after the test file finishes. */
export function tempPaths(): CpaPaths {
	const dir = mkdtempSync(join(tmpdir(), "pi-cpa-provider-test-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	return resolvePaths(dir);
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export const RAW_CATALOG = {
	models: [
		{
			slug: "gpt-example",
			display_name: "GPT Example",
			context_window: 272000,
			max_output_tokens: 64000,
			input_modalities: ["text", "image"],
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, "none"],
			service_tiers: [{ id: "priority", name: "Fast" }],
		},
		{ slug: "flex-only", service_tiers: [{ id: "flex" }] },
		{ id: "hidden", visibility: "hide" },
	],
};
