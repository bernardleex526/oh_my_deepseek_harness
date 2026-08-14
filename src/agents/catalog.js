/**
 * The specialist catalog: one entry per delegation tool the Orchestrator sees.
 *
 * The build script (`scripts/build.mjs`) turns this catalog into six
 * `@deepseek-ai/dsh-tool-subagent` rows in the generated `agent.cordis.yml`.
 * Tests validate the catalog against the permission model and the design-doc
 * role boundaries.
 *
 * @module multi-agent-orchestrator/agents/catalog
 */

import { assertAgentDefinition } from "../config/schema.js";
import { DEFAULT_BACKGROUND_MODE, DEFAULT_ENABLE_RUN_IN_BACKGROUND, DEFAULT_MAX_DEPTH, DEFAULT_PROVIDER } from "../config/defaults.js";
import { specialistFilter, SPECIALIST_PERMISSIONS } from "../permissions/agent-permissions.js";

/**
 * Base definition of one specialist.
 * @param {object} spec - specialist fields (id, toolName, role, personaFile,
 *   description, permissions key).
 * @param {object} [spec.agentOptions] - optional per-specialist model route
 *   `{ provider, model, maxTokens }`. When set, every delegation to this
 *   specialist overrides the parent agent's route (see
 *   `resolveChildAgentOptions` in dsh-subagent).
 * @returns {object} the validated definition with a `filterFor(platform)`.
 */
function specialist(spec) {
	const def = {
		...spec,
		provider: DEFAULT_PROVIDER,
		backgroundMode: DEFAULT_BACKGROUND_MODE,
		enableRunInBackground: DEFAULT_ENABLE_RUN_IN_BACKGROUND,
		maxDepth: DEFAULT_MAX_DEPTH,
		/** Resolve this specialist's toolFilter for one platform. */
		filterFor(platform) {
			return specialistFilter(spec.permissions, platform);
		},
		get filter() {
			return this.filterFor(process.platform);
		}
	};
	if (spec.agentOptions !== void 0) {
		assertAgentOptions(spec.agentOptions, `specialist:${spec.id}`);
		def.agentOptions = { ...spec.agentOptions };
	}
	assertAgentDefinition(def, `specialist:${spec.id}`);
	return def;
}

/**
 * Assert a per-specialist model route. The harness schema requires ALL three
 * fields when `agentOptions` is present.
 * @param {unknown} value - the candidate agentOptions.
 * @param {string} label - diagnostic label.
 * @returns {void}
 */
export function assertAgentOptions(value, label = "agentOptions") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label}: agentOptions must be an object`);
	}
	for (const key of ["provider", "model", "maxTokens"]) {
		if (typeof value[key] !== "string" && key !== "maxTokens") {
			throw new TypeError(`${label}: agentOptions.${key} is required`);
		}
	}
	if (typeof value.provider !== "string" || value.provider.length === 0) {
		throw new TypeError(`${label}: agentOptions.provider must be a non-empty string`);
	}
	if (typeof value.model !== "string" || value.model.length === 0) {
		throw new TypeError(`${label}: agentOptions.model must be a non-empty string`);
	}
	if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1) {
		throw new TypeError(`${label}: agentOptions.maxTokens must be a positive safe integer`);
	}
}

/**
 * The six specialists.
 *
 * @type {Array<{id: string, toolName: string, role: string, personaFile: string, permissions: object, provider: string, backgroundMode: string, enableRunInBackground: boolean, maxDepth: number, filterFor: (platform?: string) => {allow: string[]}}>}
 */
export const SPECIALISTS = [
	specialist({
		id: "explorer",
		toolName: "subagent_explorer",
		role: "information-producer",
		personaFile: "prompts/explorer.md",
		permissions: SPECIALIST_PERMISSIONS.explorer,
		description: "静态仓库事实：文件、符号、调用关系、结构与已有模式"
	}),
	specialist({
		id: "librarian",
		toolName: "subagent_librarian",
		role: "information-producer",
		personaFile: "prompts/librarian.md",
		permissions: SPECIALIST_PERMISSIONS.librarian,
		description: "外部知识：官方文档、第三方库、API、版本与标准"
	}),
	specialist({
		id: "observer",
		toolName: "subagent_observer",
		role: "information-producer",
		personaFile: "prompts/observer.md",
		permissions: SPECIALIST_PERMISSIONS.observer,
		description: "运行事实：测试输出、日志、截图、UI 与运行时行为"
	}),
	specialist({
		id: "oracle",
		toolName: "subagent_oracle",
		role: "decision-maker",
		personaFile: "prompts/oracle.md",
		permissions: SPECIALIST_PERMISSIONS.oracle,
		description: "深度技术推理：根因、架构权衡、并发、安全、性能"
	}),
	specialist({
		id: "designer",
		toolName: "subagent_designer",
		role: "decision-maker",
		personaFile: "prompts/designer.md",
		permissions: SPECIALIST_PERMISSIONS.designer,
		description: "视觉与交互判断：UI/UX、布局、可访问性、规范输出"
	}),
	specialist({
		id: "fixer",
		toolName: "subagent_fixer",
		role: "executor",
		personaFile: "prompts/fixer.md",
		permissions: SPECIALIST_PERMISSIONS.fixer,
		description: "执行修改：按明确目标实现、重构、修复并做局部验证"
	})
];

/** Agent ids in delegation order. */
export const SPECIALIST_IDS = SPECIALISTS.map((s) => s.id);

/**
 * Look up one specialist by id.
 * @param {string} id - specialist id.
 * @returns {object} the specialist definition.
 */
export function specialistById(id) {
	const found = SPECIALISTS.find((s) => s.id === id);
	if (found === void 0) throw new Error(`unknown specialist "${id}"`);
	return found;
}
