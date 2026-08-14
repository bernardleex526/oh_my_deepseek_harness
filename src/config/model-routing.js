/**
 * Per-specialist model routing configuration.
 *
 * Users can give each specialist its own provider/model/maxTokens by placing
 * a `model-routing.json` file in the project root:
 *
 * ```json
 * {
 *   "explorer":  { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 8000 },
 *   "oracle":    { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 16000 },
 *   "fixer":     { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 12000 }
 * }
 * ```
 *
 * The build script merges these into each delegation tool's `agentOptions`,
 * which the harness applies at spawn time (`resolveChildAgentOptions`): the
 * child's provider/model/maxTokens override the parent Orchestrator's route.
 * Unknown specialists and incomplete entries fail the build loudly.
 *
 * @module multi-agent-orchestrator/config/model-routing
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertAgentOptions } from "../agents/catalog.js";
import { SPECIALIST_IDS } from "../agents/catalog.js";

/** Default file name beside package.json. */
export const MODEL_ROUTING_FILE = "model-routing.json";

/**
 * Load per-specialist model routes.
 * @param {string} root - project root directory.
 * @returns {Record<string, {provider: string, model: string, maxTokens: number}>}
 *   routes keyed by specialist id; empty when no file exists.
 */
export function loadModelRouting(root) {
	const path = join(root, MODEL_ROUTING_FILE);
	if (!existsSync(path)) return {};
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`model-routing: cannot parse ${MODEL_ROUTING_FILE}: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`model-routing: ${MODEL_ROUTING_FILE} must be a JSON object keyed by specialist id`);
	}
	const routes = {};
	for (const [id, value] of Object.entries(parsed)) {
		if (!SPECIALIST_IDS.includes(id)) {
			throw new Error(`model-routing: unknown specialist "${id}" (known: ${SPECIALIST_IDS.join(", ")})`);
		}
		assertAgentOptions(value, `model-routing:${id}`);
		routes[id] = { ...value };
	}
	return routes;
}
