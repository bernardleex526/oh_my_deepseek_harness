/**
 * Deployment defaults for the multi-agent orchestration mode.
 *
 * Every value here is also carried in the generated `agent.cordis.yml`; these
 * constants are the single source the build script and the tests share.
 *
 * @module multi-agent-orchestrator/config/defaults
 */

/** The delegation tool's provider: in-process spawn (fresh child context). */
export const DEFAULT_PROVIDER = "spawn";

/** Delegation is foreground-first: the orchestrator awaits specialist results. */
export const DEFAULT_BACKGROUND_MODE = "one-shot";

/** No background jobs surface on the delegation tools. */
export const DEFAULT_ENABLE_RUN_IN_BACKGROUND = false;

/**
 * Absolute delegation-depth cap for every specialist tool.
 *
 * The Orchestrator (depth 0) may spawn specialists (depth 1); a specialist
 * (depth 1) attempting to delegate would need depth 2, which exceeds this cap.
 * This is the runtime half of "specialists cannot spawn other specialists";
 * the tool-filter half is that specialist filters never admit `subagent_*`
 * tools at all.
 */
export const DEFAULT_MAX_DEPTH = 1;

/** Prompt-order slot for the routing-policy section (after tool guidance). */
export const ROUTING_SECTION_ORDER = 150;

/** Agent-instructions budget for AGENTS.md-style files. */
export const AGENT_INSTRUCTIONS_MAX_BYTES = 65536;

/** The preset id (directory name under `.agent-presets`). */
export const PRESET_ID = "orchestrator";

/** Display metadata written into `preset.yml`. */
export const PRESET_METADATA = {
	name: "多智能体编排",
	description: "Orchestrator 控制平面 + Explorer / Librarian / Observer / Oracle / Designer / Fixer 六个职责隔离的专职子代理，调查→决策→执行→验证。",
	order: 5
};
