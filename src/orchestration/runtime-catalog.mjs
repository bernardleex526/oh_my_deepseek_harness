/**
 * Runtime delegation catalog for the orchestration preset.
 *
 * This file is the runtime half of "which delegation tools exist". The BUILD
 * script writes a generated copy into `preset/orchestrator/` for dist builds
 * and (for `--local` builds with custom roles) regenerates it with the custom
 * `subagent_*` tools included. `orchestration.mjs` imports the preset-local
 * copy, so the Orchestrator allow-list always matches the delegation rows that
 * were actually compiled into the composition.
 *
 * IMPORT-FREE: copied into the preset directory (no node_modules).
 *
 * @module multi-agent-orchestrator/orchestration/runtime-catalog
 */

/** Every delegation tool registered by this build. */
export const DELEGATION_TOOLS = [
"subagent_explorer",
"subagent_librarian",
"subagent_observer",
"subagent_oracle",
"subagent_designer",
"subagent_fixer"
];

/** Delegation tools whose child may modify the workspace (single-writer set). */
export const WRITER_DELEGATION_TOOLS = [
"subagent_fixer"
];
