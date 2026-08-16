/**
 * Custom role registration (P2): users can add their own specialists by
 * placing a `roles.json` beside `model-routing.json` in the project root:
 *
 * ```json
 * {
 *   "penetration-tester": {
 *     "role": "information-producer",
 *     "personaFile": "prompts/penetration-tester.md",
 *     "description": "安全审计：攻击面、漏洞与缓解建议",
 *     "permissions": { "read": ["read"], "search": ["grep", "glob"], "web": true, "shell": true }
 *   }
 * }
 * ```
 *
 * A local build (`npm run build:local`, which also reads `model-routing.json`)
 * merges these into the generated preset as additional
 * `@deepseek-ai/dsh-tool-subagent` delegation rows with the same isolation
 * guarantees as the six builtins (own persona, own toolFilter, maxDepth 1,
 * one-shot). Dist builds NEVER read roles.json, so published presets stay
 * deterministic.
 *
 * Validation rules:
 * - id matches the agent-id rule and must not collide with a builtin;
 * - `toolName` is auto-derived as `subagent_<id>` (a different explicit
 *   toolName is rejected — delegation gating keys on the `subagent_` prefix);
 * - `role` is one of the catalog's role vocabulary
 *   (information-producer | decision-maker | executor);
 * - `permissions` is a subset of the specialist permission spec; unknown
 *   keys are rejected.
 *
 * @module multi-agent-orchestrator/config/roles
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertAgentDefinition, TOOL_NAME } from "./schema.js";
import { DEFAULT_BACKGROUND_MODE, DEFAULT_ENABLE_RUN_IN_BACKGROUND, DEFAULT_MAX_DEPTH, DEFAULT_PROVIDER } from "./defaults.js";
import { specialistFilter } from "../permissions/agent-permissions.js";
import { SPECIALIST_IDS } from "../agents/catalog.js";

/** Default file name beside package.json (same convention as model-routing). */
export const CUSTOM_ROLES_FILE = "roles.json";

/** Role vocabulary shared with the builtin catalog. */
export const KNOWN_ROLES = ["information-producer", "decision-maker", "executor"];

/** Permission keys a custom role may declare (subset of the builtin spec). */
export const CUSTOM_PERMISSION_KEYS = ["read", "search", "shell", "web", "todo", "jobs", "askUser", "broker"];

/**
 * Build a full specialist definition from a custom role entry, mirroring the
 * builtin catalog's shape (provider/backgroundMode/maxDepth/filterFor).
 * @param {string} id - the custom role id.
 * @param {object} entry - the roles.json entry.
 * @returns {object} the specialist definition.
 */
export function customSpecialist(id, entry) {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new TypeError(`roles: "${id}" must be an object`);
	}
	// The delegation tool name is `subagent_<id>` and must be lowercase
	// snake (TOOL_NAME): hyphens or uppercase would produce an
	// unregisterable tool name.
	if (typeof id !== "string" || !TOOL_NAME.test(id)) {
		throw new TypeError(`roles: id "${String(id)}" must be lowercase snake_case (the delegation tool name is "subagent_${String(id)}" and must match ${String(TOOL_NAME)})`);
	}
	if (!KNOWN_ROLES.includes(entry.role)) {
		throw new TypeError(`roles: "${id}".role must be one of ${KNOWN_ROLES.join(" | ")}`);
	}
	if (typeof entry.personaFile !== "string" || entry.personaFile.length === 0) {
		throw new TypeError(`roles: "${id}".personaFile is required`);
	}
	if (typeof entry.description !== "string" || entry.description.length === 0) {
		throw new TypeError(`roles: "${id}".description is required`);
	}
	if (entry.toolName !== void 0 && entry.toolName !== `subagent_${id}`) {
		throw new TypeError(`roles: "${id}".toolName must be "subagent_${id}" (delegation gating keys on the subagent_ prefix)`);
	}
	if (entry.maxDepth !== void 0 && (!Number.isSafeInteger(entry.maxDepth) || entry.maxDepth < 1)) {
		throw new TypeError(`roles: "${id}".maxDepth must be a positive safe integer`);
	}
	const permissions = entry.permissions ?? {};
	if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
		throw new TypeError(`roles: "${id}".permissions must be an object`);
	}
	for (const key of Object.keys(permissions)) {
		if (!CUSTOM_PERMISSION_KEYS.includes(key)) {
			throw new TypeError(`roles: "${id}".permissions has unknown key "${key}" (known: ${CUSTOM_PERMISSION_KEYS.join(", ")})`);
		}
	}
	for (const key of ["read", "search"]) {
		const list = permissions[key];
		if (list !== void 0 && (!Array.isArray(list) || list.some((n) => typeof n !== "string" || n.length === 0))) {
			throw new TypeError(`roles: "${id}".permissions.${key} must be an array of tool names`);
		}
	}
	for (const key of ["shell", "web", "todo", "jobs", "askUser", "broker"]) {
		const flag = permissions[key];
		if (flag !== void 0 && typeof flag !== "boolean") {
			throw new TypeError(`roles: "${id}".permissions.${key} must be a boolean`);
		}
	}
	const def = {
		id,
		toolName: `subagent_${id}`,
		role: entry.role,
		personaFile: entry.personaFile,
		description: entry.description,
		permissions,
		provider: DEFAULT_PROVIDER,
		backgroundMode: DEFAULT_BACKGROUND_MODE,
		enableRunInBackground: DEFAULT_ENABLE_RUN_IN_BACKGROUND,
		maxDepth: typeof entry.maxDepth === "number" ? entry.maxDepth : DEFAULT_MAX_DEPTH,
		filterFor(platform) {
			return specialistFilter(permissions, platform);
		},
		get filter() {
			return this.filterFor(process.platform);
		}
	};
	assertAgentDefinition(def, `roles:${id}`);
	return def;
}

/**
 * Load custom roles from the project root.
 * @param {string} root - project root directory.
 * @returns {Array<object>} custom specialist definitions (empty when absent).
 */
export function loadCustomRoles(root) {
	const path = join(root, CUSTOM_ROLES_FILE);
	if (!existsSync(path)) return [];
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`roles: cannot parse ${CUSTOM_ROLES_FILE}: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`roles: ${CUSTOM_ROLES_FILE} must be a JSON object keyed by role id`);
	}
	const out = [];
	for (const [id, entry] of Object.entries(parsed)) {
		if (SPECIALIST_IDS.includes(id)) {
			throw new Error(`roles: "${id}" collides with a builtin specialist — custom roles cannot shadow builtins`);
		}
		out.push(customSpecialist(id, entry));
	}
	return out;
}
