/**
 * The orchestration preset row: enforces the control-plane permission boundary
 * and the mechanical multi-agent runtime guard.
 *
 * Mounted by the `orchestrator` agent preset (agent.cordis.yml row
 * `- id: orchestration / name: ./orchestration.mjs`). It:
 * - listens for `agent/created` and narrows each ROOT agent's tool surface to
 *   the Orchestrator allow-list (children are filtered per-role by the
 *   delegation tools' `toolFilter` instead);
 * - installs the `tools/pre-execute` + `tools/execute` (+ `tools/post-execute`)
 *   chain that drives the OrchestrationBroker (`./broker.mjs`): workspace-keyed
 *   single-writer serialization, per-task delegation/retry/failure budgets,
 *   and the mechanical envelope gate that BLOCKS malformed specialist results
 *   instead of handing them to the model as success;
 * - registers the read-only `broker_status` tool so the Orchestrator can see
 *   the broker's per-task state.
 *
 * The lock semantics differ from the original guard in one crucial way: the
 * writer lock is now HELD through an `ask` approval decision. dsh-tools runs
 * `tools/pre-execute` exactly once per execution and does NOT re-run it after
 * an approval upgrades `ask` → `allow` (dsh-tools lib/index.js:3098-3130), so
 * releasing on `ask` let an approved fixer dispatch without the lock. Because
 * every non-throw outcome (allow-dispatch, deny, ask-cancelled) reaches
 * `tools/post-execute` (lib/index.js:2995-3001), the ownership-scoped release
 * in post-execute (plus the execute `finally`) guarantees the lock is always
 * cleared exactly once; only a downstream pre-execute THROW bypasses
 * post-execute, and that path releases in the catch below.
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
 * This file may only import SIBLING files of the preset directory
 * (`./broker.mjs`, `./protocol.mjs` — no node_modules needed); it never
 * imports harness packages.
 *
 * @module multi-agent-orchestrator/orchestration
 */

import { createBroker, isDelegationTool, rootSessionKey, readBudgetsFromEnv } from "./broker.mjs";
import { createArtifactStore } from "./artifacts.mjs";

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
 * web search, child catalog, the broker report, and delegation. NO write/edit,
 * NO shell, NO background-job tools. Platform-independent: no shell tool is
 * named here.
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
	"broker_status",
	...SUBAGENT_TOOLS
];

/** Stable Cordis plugin name for this row. */
export const name = "orchestration";

/**
 * Process-local broker instance for this preset load.
 *
 * Budget caps come from `$DSH_ORCHESTRATION_BUDGETS` (JSON) when set;
 * persistence/artifacts turn on when `$DSH_ORCHESTRATION_HOME` is set.
 * Exported so tests can reset it between cases; the runtime only ever uses
 * the module singleton.
 */
export const broker = createBroker(readBudgetsFromEnv(), createArtifactStore());

/** Join the text blocks of a normalized tool result into one string. */
function resultText(result) {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Plugin entry: register the root-agent boundary listener, the broker-driven
 * tool chain, and the read-only broker_status tool.
 * @param {object} ctx - the preset standing scope's Cordis context.
 */
export function apply(ctx) {
	ctx.on("agent/created", ({ agent }) => {
		if (agent.session.header.parentSession !== void 0) return;
		const tools = agent.ctx.get("tools");
		// FAIL-CLOSED: a synchronous throw inside an `agent/created` listener
		// vetoes publication — the agent is rolled back and never published
		// (a returned-promise rejection is only logged, non-vetoing). So we
		// throw synchronously rather than warn+return, to refuse to run a root
		// agent whose boundary could not be installed.
		if (tools === void 0) {
			ctx.logger?.error("orchestration: tools registry unavailable at agent/created — refusing to run the root agent without the boundary");
			throw new Error("orchestration: tools registry unavailable; orchestrator boundary cannot be installed (fail-closed)");
		}
		tools.restrict({ allow: [...ORCHESTRATOR_ALLOW] });
	});

	// ── mechanical delegation chain ────────────────────────────────────────
	//
	// `tools/pre-execute` is the reorderable allow/deny gate. We run the
	// broker gate HERE — before dispatch — so protocol violations (missing
	// TASK_ID), exhausted budgets, and concurrent fixer delegations are
	// rejected at the gate with a deniable reason rather than being allowed
	// to start. All non-delegation tools pass through untouched.
	//
	// Lock lifecycle (fixer only): acquired in the gate; released exactly once
	// by whichever of these runs first — the `tools/execute` finally (dispatch
	// path), the `tools/post-execute` settle (deny / ask-cancelled /
	// pre-dispatch cancellation paths), or the catch below (a downstream
	// pre-execute listener throwing, which bypasses BOTH execute and
	// post-execute). Every release is ownership-scoped to the exact token
	// that took the lock, so a denied concurrent call can never clear the
	// owner's lock.
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (!isDelegationTool(exec.name)) return next();
		const gate = broker.gate(exec);
		if (!gate.ok) {
			return {
				kind: "deny",
				reason: gate.reason
			};
		}
		try {
			return await next();
		} catch (error) {
			// A later listener in the pre-execute chain threw. That becomes a
			// `final-result` in dsh-tools and never reaches execute/post-execute.
			broker.releaseWriter(exec);
			throw error;
		}
	});

	// Clear the lock on completion OR error, and record that dispatch started.
	//
	// Mechanism choice: `tools/execute` is the around-dispatch waterfall
	// (dsh-tools lib/index.js:3195). Wrapping `next()` in a `try/finally` is
	// the ONLY seam whose cleanup is guaranteed to fire on BOTH the success
	// path and the error path — a thrown `next()` (pipeline error) still runs
	// the `finally`, which clears the lock before the error propagates.
	ctx.on("tools/execute", async (exec, next) => {
		try {
			broker.markDispatched(exec);
			return await next();
		} finally {
			broker.releaseWriter(exec);
		}
	});

	// Settle every delegation after dispatch: parse + validate the envelope,
	// record the attempt, and BLOCK malformed results with corrective
	// feedback so the model never sees a broken envelope as success. The
	// handler always delegates to `next()` on the accept path (preserving the
	// default `{ kind: "accept" }` semantics and any later listeners); only a
	// rejected envelope short-circuits with the block decision.
	ctx.on("tools/post-execute", (exec, result, next) => {
		if (!isDelegationTool(exec.name)) return next();
		const outcome = broker.settle(exec, {
			text: resultText(result),
			isError: result?.isError === true
		});
		return outcome.decision.kind === "block" ? outcome.decision : next();
	});

	// Read-only broker report tool. Registered on the standing scope so every
	// agent composed from this preset could technically see it, but only the
	// Orchestrator's allow-list and the specialist filters that admit it
	// (Fixer/Observer, for test-receipt dedupe) can call it. The report is
	// keyed on the caller's ROOT session, so a specialist querying it sees
	// the delegation state its delegator owns. Non-fatal if the tools
	// registry is unavailable on this scope.
	try {
		const tools = ctx.get("tools");
		if (tools?.register !== void 0) {
			tools.register({
				name: "broker_status",
				description: "Read the orchestration broker state for this session: per-task delegation budgets, specialist attempt counts, consecutive failures, test receipts (for skipping re-runs of identical commands), and optional artifact paths. Pass taskId to focus on one task, includeArtifacts to list stored artifacts.",
				parameters: {
					type: "object",
					properties: {
						taskId: { type: "string" },
						includeArtifacts: { type: "boolean" }
					},
					additionalProperties: false
				},
				isConcurrencySafe: () => true,
				output: {
					schema: {
						type: "object",
						properties: { report: { type: "string" } },
						required: ["report"],
						additionalProperties: false
					},
					render: (_args, value) => [{ type: "text", text: value.report }]
				},
				execute: (args, exec) => ({
					report: broker.report(rootSessionKey(exec), {
						taskId: args.taskId,
						includeArtifacts: args.includeArtifacts === true
					})
				})
			});
		}
	} catch (error) {
		ctx.logger?.warn?.(`orchestration: broker_status tool registration failed: ${String(error)}`);
	}
}
