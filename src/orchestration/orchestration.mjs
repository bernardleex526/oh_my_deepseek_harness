/**
 * The orchestration preset row: enforces the control-plane permission boundary.
 *
 * Mounted by the `orchestrator` agent preset (agent.cordis.yml row
 * `- id: orchestration / name: ./orchestration.mjs`). It listens for
 * `agent/created` in the preset's standing scope and narrows each ROOT agent's
 * tool surface to the Orchestrator allow-list. Specialist children are
 * untouched here: their surfaces are already narrowed by the delegation
 * tool's `toolFilter`, which is compiled into `tools.restrict()` on the
 * child's own scope layer during setup.
 *
 * Why a root-only restriction:
 * - The preset composition registers the FULL tool union (specialists need
 *   write/edit/shell/web), so the session agent would otherwise see
 *   everything. Prompt-only discipline is not a boundary; this restriction
 *   makes "Orchestrator does not execute" mechanically true.
 * - Children must NOT inherit it: they are filtered per-role by the
 *   delegation tools instead. The check below keys on the absence of a
 *   durable `parentSession` header, which is exactly what distinguishes a
 *   top-level session agent from a spawned child.
 *
 * Timing: `agent/created` fires after scoped setup and registry entry, before
 * the first model request, so the catalog is narrowed before any request is
 * composed — the KV-cache prefix stays stable from request one.
 *
 * This file is intentionally IMPORT-FREE: it is loaded from the preset
 * directory (a user-writable location with no node_modules), so it may only
 * use the `ctx` API, the `agent` payload, and globals.
 *
 * @module multi-agent-orchestrator/orchestration
 */

/** Delegation tool names the Orchestrator may invoke. */
const SUBAGENT_TOOLS = [
	"subagent_explorer",
	"subagent_librarian",
	"subagent_observer",
	"subagent_oracle",
	"subagent_designer",
	"subagent_fixer"
];

/**
 * The Orchestrator's own tool surface (allow list).
 *
 * Control plane: limited read/search, the user channel, task tracking,
 * web search, child catalog, and delegation. NO write/edit, NO shell, NO
 * background-job tools. Platform-independent: no shell tool is named here.
 */
export const ORCHESTRATOR_ALLOW = [
	"read",
	"read_image",
	"grep",
	"glob",
	"ask_user_question",
	"todo_write",
	"web_search",
	"list_agents",
	...SUBAGENT_TOOLS
];

/** Stable Cordis plugin name for this row. */
export const name = "orchestration";

/**
 * Plugin entry: register the root-agent boundary listener.
 * @param {object} ctx - the preset standing scope's Cordis context.
 */
export function apply(ctx) {
	ctx.on("agent/created", ({ agent }) => {
		if (agent.session.header.parentSession !== void 0) return;
		const tools = agent.ctx.get("tools");
		if (tools === void 0) {
			ctx.logger?.warn("orchestration: tools registry unavailable at agent/created; orchestrator boundary not installed");
			return;
		}
		tools.restrict({ allow: [...ORCHESTRATOR_ALLOW] });
	});
}
