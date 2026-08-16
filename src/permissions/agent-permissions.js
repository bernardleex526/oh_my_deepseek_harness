/**
 * Per-agent permission model: which model-facing tools each role may see.
 *
 * The harness enforces these mechanically: every specialist is spawned through
 * a delegation tool whose `toolFilter` is compiled into `tools.restrict()` on
 * the child's own scope layer, and the Orchestrator's own surface is narrowed
 * by the `orchestration.mjs` preset row at agent creation. Prompts explain the
 * boundaries; these filters are what make them unbreakable.
 *
 * Tool names must match the tools this preset actually registers (see
 * `src/agents/catalog.js` and the generated `agent.cordis.yml`). Naming an
 * unregistered tool makes `tools.restrict()` throw, so shell tools are
 * platform-conditional: `bash` exists only on POSIX, `pwsh` only on Windows.
 *
 * @module multi-agent-orchestrator/permissions/agent-permissions
 */

/** Tool names registered by the preset's filesystem rows. */
export const FS_TOOLS = ["read", "read_image", "write", "edit"];
/** Tool names registered by the preset's search row. */
export const SEARCH_TOOLS = ["grep", "glob"];
/** Shell tool name for the current platform. */
export function shellTool(platform = process.platform) {
	return platform === "win32" ? "pwsh" : "bash";
}
/** All shell tool names across platforms (for tests/validation). */
export const SHELL_TOOLS = ["bash", "pwsh"];
/** The web_search tool. */
export const WEB_SEARCH_TOOL = "web_search";
/** The user-facing question tool. */
export const ASK_USER_TOOL = "ask_user_question";
/** The task-tracking tool. */
export const TODO_TOOL = "todo_write";
/** Background job tools. */
export const JOB_TOOLS = ["job_list", "job_output", "job_kill"];
/** The child-catalog tool. */
export const LIST_AGENTS_TOOL = "list_agents";
/** The broker report tool (registered by the orchestration row). */
export const BROKER_STATUS_TOOL = "broker_status";
/** Delegation tool names, one per specialist. */
export const SUBAGENT_TOOLS = [
	"subagent_explorer",
	"subagent_librarian",
	"subagent_observer",
	"subagent_oracle",
	"subagent_designer",
	"subagent_fixer"
];

/**
 * Allow-list for the Orchestrator root agent (installed by orchestration.mjs).
 *
 * Control plane: limited read/search/web, the user channel, task tracking,
 * child catalog, the broker report, and the six delegation tools. Deliberately
 * NO write/edit, NO shell, NO job tools — the Orchestrator routes work; it
 * does not execute it. Platform-independent (no shell tool named here).
 *
 * NOTE: keep this list in sync with ORCHESTRATOR_ALLOW in
 * src/orchestration/orchestration.mjs (both are asserted by tests).
 */
export const ORCHESTRATOR_ALLOW = [
	"read",
	"read_image",
	"grep",
	"glob",
	ASK_USER_TOOL,
	TODO_TOOL,
	WEB_SEARCH_TOOL,
	LIST_AGENTS_TOOL,
	BROKER_STATUS_TOOL,
	...SUBAGENT_TOOLS
];

/**
 * Build the toolFilter config for one specialist.
 *
 * @param {object} spec - specialist permission spec.
 * @param {string[]} spec.read - read-tool subset to admit.
 * @param {string[]} spec.search - search-tool subset to admit.
 * @param {boolean} [spec.shell] - admit the platform shell tool.
 * @param {boolean} [spec.web] - admit web_search.
 * @param {boolean} [spec.todo] - admit todo_write.
 * @param {boolean} [spec.jobs] - admit job_* tools.
 * @param {boolean} [spec.askUser] - admit ask_user_question.
 * @param {boolean} [spec.broker] - admit broker_status (read-only report:
 *   lets Fixer/Observer query earlier test receipts and skip re-runs).
 * @param {string} [platform] - platform to resolve shell for (tests).
 * @returns {{allow: string[]}} the toolFilter for the delegation tool.
 */
export function specialistFilter(spec, platform = process.platform) {
	const allow = [];
	allow.push(...spec.read);
	allow.push(...spec.search);
	if (spec.shell) allow.push(shellTool(platform));
	if (spec.web) allow.push(WEB_SEARCH_TOOL);
	if (spec.todo) allow.push(TODO_TOOL);
	if (spec.jobs) allow.push(...JOB_TOOLS);
	if (spec.askUser) allow.push(ASK_USER_TOOL);
	if (spec.broker) allow.push(BROKER_STATUS_TOOL);
	return { allow };
}

/**
 * The six specialists' permission specs, keyed by agent id.
 *
 * Mapping to the design-doc permission table (§19), adapted to the tools this
 * preset registers:
 *
 * | Agent     | Read | Search | Web | Shell | Edit | Jobs | Ask | Broker |
 * |-----------|------|--------|-----|-------|------|------|-----|--------|
 * | Explorer  | fs   | search | no  | ro*   | no   | no   | no  | no     |
 * | Librarian | no   | no     | yes | no    | no    | no   | no  | no     |
 * | Observer  | fs   | search | lim | yes*  | no    | yes  | no  | yes    |
 * | Oracle    | ro   | search | lim | no    | no    | no   | no  | no     |
 * | Designer  | ro   | search | lim | no    | no    | no   | no  | no     |
 * | Fixer     | fs   | search | lim | yes   | yes   | yes  | no  | yes    |
 *
 * *Explorer's and Observer's shell access is read-only by prompt discipline
 * only; DSH cannot express a read-only shell at the permission layer, so their
 * prompts hard-restrict shell use to non-mutating (observational) commands.
 * Design/decision makers (Oracle, Designer) have no shell at all.
 * Fixer/Observer additionally get the read-only `broker_status` report so
 * they can query earlier test receipts and avoid re-running identical
 * commands (P1 test-run dedupe).
 *
 * @type {Record<string, object>}
 */
export const SPECIALIST_PERMISSIONS = {
	explorer: {
		read: ["read", "read_image"],
		search: SEARCH_TOOLS,
		shell: true
	},
	librarian: {
		read: [],
		search: [],
		web: true
	},
	observer: {
		read: ["read", "read_image"],
		search: SEARCH_TOOLS,
		shell: true,
		web: true,
		jobs: true,
		broker: true
	},
	oracle: {
		read: ["read", "read_image"],
		search: SEARCH_TOOLS,
		web: true
	},
	designer: {
		read: ["read", "read_image"],
		search: SEARCH_TOOLS,
		web: true
		// No shell: Designer is a decision-maker that produces specifications,
		// not an executor. It has no shell, write, or edit tools.
	},
	fixer: {
		read: FS_TOOLS,
		search: SEARCH_TOOLS,
		shell: true,
		web: true,
		todo: true,
		jobs: true,
		broker: true
	}
};

/**
 * Resolve the toolFilter for one specialist on the given platform.
 * @param {string} agentId - specialist id.
 * @param {string} [platform] - platform to resolve shell for.
 * @returns {{allow: string[]}} the toolFilter.
 */
export function filterForAgent(agentId, platform = process.platform) {
	const spec = SPECIALIST_PERMISSIONS[agentId];
	if (spec === void 0) throw new Error(`unknown specialist "${agentId}"`);
	return specialistFilter(spec, platform);
}
