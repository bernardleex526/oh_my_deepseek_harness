/**
 * OrchestrationBroker: the process-local mechanical state of the multi-agent
 * runtime, wired into the real execution path by `orchestration.mjs`.
 *
 * What the broker enforces (none of it is prompt discipline):
 * - **Writer serialization per WORKSPACE** (not per caller): the fixer
 *   delegation lock is keyed by the caller's normalized session cwd, so two
 *   root sessions opened on the same project serialize their writes, while
 *   disjoint projects never block each other. The lock is taken at
 *   `tools/pre-execute` and — unlike the old guard — HELD through an `ask`
 *   approval: dsh-tools does not re-run pre-execute after approval, so
 *   releasing on `ask` let an approved fixer run without the lock.
 * - **Task-keyed budgets**: every delegation prompt must declare
 *   `TASK_ID: <id>`; per (session, task) the broker caps total delegations,
 *   attempts per specialist (initial + retries), and consecutive
 *   non-SUCCESS results. A new TASK_ID resets the counters — the id is the
 *   mechanical "task boundary".
 * - **Envelope gate**: after every delegation dispatch, the returned text is
 *   parsed (multi-line aware) and validated; malformed envelopes (missing or
 *   unknown STATUS, missing SUMMARY, bad/missing TASK_ID, TASK_ID mismatch,
 *   duplicate sections, or SUCCESS without the role's required evidence
 *   sections) are BLOCKED via the post-execute `block` decision, so a bad
 *   result is never handed to the model as success.
 * - **Result store**: every dispatched attempt is recorded per (session,
 *   task) with status, summary, protocol errors/warnings, and the envelope
 *   sections; `report()` renders it for the `broker_status` tool.
 *
 * IMPORT-FREE except for the sibling `./protocol.mjs` (both are copied into
 * the preset directory, which has no node_modules).
 *
 * @module multi-agent-orchestrator/orchestration/broker
 */

import { extractTaskId, parseEnvelope, ROLE_REQUIRED_ON_SUCCESS, KNOWN_STATUSES } from "./protocol.mjs";

/** Default mechanical budgets (mirror the Orchestrator prompt limits). */
export const DEFAULT_BUDGETS = {
	/** Max specialist delegations per TASK_ID. */
	maxDelegationsPerTask: 12,
	/** Max attempts of one specialist on one task (1 initial + 2 retries). */
	maxAttemptsPerSpecialist: 3,
	/** Consecutive non-SUCCESS results per task before the gate hard-stops. */
	maxConsecutiveFailures: 3
};

/** The single write-capable delegation tool (the executor sibling). */
export const FIXER_DELEGATION = "subagent_fixer";

/** Delegation tools are exactly the `subagent_*` family. */
export function isDelegationTool(name) {
	return typeof name === "string" && name.startsWith("subagent_");
}

/** Map a specialist tool name back to its role id. */
export function specialistId(toolName) {
	return toolName.startsWith("subagent_") ? toolName.slice("subagent_".length) : toolName;
}

/**
 * Normalize a workspace path so two spellings of the same directory collide:
 * forward slashes, no trailing separators, and full case-folding. Case-folding
 * is the SAFE direction for a serialization lock key: on case-insensitive
 * filesystems two spellings of one directory must collide, and on
 * case-sensitive ones the worst case is harmless over-serialization of two
 * directories that differ only by case.
 * @param {string} cwd - the raw session cwd.
 * @returns {string | null} the normalized path (null when empty).
 */
export function normalizeWorkspace(cwd) {
	const raw = String(cwd ?? "");
	let p = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (p === "") return null;
	return p;
}

/**
 * The writer-lock key for one execution: the caller's normalized workspace
 * (session cwd), falling back to the caller's agent id, then "unknown".
 * Two sessions on the same project → same key → serialized writes.
 * @param {object} exec - the pending tool execution.
 * @returns {string} the workspace key.
 */
export function callerWorkspace(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	const ws = cwd ? normalizeWorkspace(cwd) : null;
	return ws ?? exec?.agent?.id ?? "unknown";
}

/** The session key separating broker state (the root session id). */
export function sessionKey(exec) {
	return exec?.agent?.id ?? "unknown";
}

/**
 * Create one broker instance (process-local state).
 * @param {Partial<typeof DEFAULT_BUDGETS>} [budgets] - budget overrides.
 * @returns {object} the broker API.
 */
export function createBroker(budgets = {}) {
	const cap = { ...DEFAULT_BUDGETS, ...budgets };
	/** workspace -> { token, session } — the single-writer guard. */
	const writerLocks = new Map();
	/** execution token -> true once dispatch actually started (tools/execute). */
	const dispatched = new Map();
	/** session -> { tasks: Map<taskId, TaskState> } */
	const sessions = new Map();

	/** Ensure a task state exists for (session, taskId). */
	function taskState(session, taskId) {
		let s = sessions.get(session);
		if (s === void 0) {
			s = { tasks: new Map() };
			sessions.set(session, s);
		}
		let task = s.tasks.get(taskId);
		if (task === void 0) {
			task = {
				taskId,
				delegationsUsed: 0,
				attempts: new Map(), // toolName -> completed attempts
				consecutiveFailures: 0,
				results: [] // { at, tool, status, summary, errors, warnings }
			};
			s.tasks.set(taskId, task);
		}
		return task;
	}

	return {
		/**
		 * Pre-execute gate for one delegation call.
		 * @param {object} exec - the pending execution (name/arguments/agent/token).
		 * @returns {{ok: true} | {ok: false, reason: string, kind: string}}
		 */
		gate(exec) {
			if (!isDelegationTool(exec.name)) return { ok: true };
			const session = sessionKey(exec);
			const prompt = String(exec.arguments?.prompt ?? "");
			const taskId = extractTaskId(prompt);
			if (taskId === null) {
				return {
					ok: false,
					kind: "protocol",
					reason: "delegation prompt must declare a `TASK_ID: <id>` line — budgets and envelope linkage are keyed by it; re-send the delegation with TASK_ID as the first line."
				};
			}
			const task = taskState(session, taskId);
			if (task.delegationsUsed >= cap.maxDelegationsPerTask) {
				return {
					ok: false,
					kind: "budget",
					reason: `task budget exhausted: task "${taskId}" has used ${task.delegationsUsed}/${cap.maxDelegationsPerTask} delegations — open a new TASK_ID for a new subproblem, or stop and report to the user.`
				};
			}
			const attempts = task.attempts.get(exec.name) ?? 0;
			if (attempts >= cap.maxAttemptsPerSpecialist) {
				return {
					ok: false,
					kind: "budget",
					reason: `retry budget exhausted: ${exec.name} has ${attempts}/${cap.maxAttemptsPerSpecialist} completed attempts on task "${taskId}" — re-frame it as a NEW TASK_ID with a materially narrower question, or stop.`
				};
			}
			if (task.consecutiveFailures >= cap.maxConsecutiveFailures) {
				return {
					ok: false,
					kind: "budget",
					reason: `hard stop: ${task.consecutiveFailures} consecutive non-SUCCESS results on task "${taskId}" — report to the user instead of retrying.`
				};
			}
			if (exec.name === FIXER_DELEGATION) {
				const ws = callerWorkspace(exec);
				if (writerLocks.has(ws)) {
					return {
						ok: false,
						kind: "writer",
						reason: `single-writer: a fixer delegation is already in progress for workspace "${ws}" — writes are serialized; wait for it to finish.`
					};
				}
				writerLocks.set(ws, { token: exec.token, session });
			}
			return { ok: true };
		},

		/** Whether a workspace currently holds the writer lock (tests/report). */
		isWriterLocked(workspace) {
			return writerLocks.has(workspace);
		},

		/**
		 * Mark an execution as actually dispatched. Called from the
		 * `tools/execute` around-dispatch listener, so only real dispatches
		 * are counted and settled; denials and pre-dispatch cancellations
		 * never record an attempt.
		 * @param {object} exec - the dispatched execution.
		 */
		markDispatched(exec) {
			if (isDelegationTool(exec.name)) dispatched.set(exec.token, true);
		},

		/**
		 * Release the writer lock, but only for the exact call that holds it.
		 * @param {object} exec - the completing execution.
		 */
		releaseWriter(exec) {
			if (exec.name !== FIXER_DELEGATION) return;
			const ws = callerWorkspace(exec);
			const held = writerLocks.get(ws);
			if (held !== void 0 && held.token === exec.token) writerLocks.delete(ws);
		},

		/**
		 * Settle one delegation after dispatch (from `tools/post-execute`):
		 * release the writer lock, record the attempt, validate the envelope,
		 * and decide accept vs block.
		 *
		 * Real tool errors (provider failures, aborts) pass through untouched
		 * (they are already visible to the model) but still count as a
		 * non-SUCCESS attempt. Calls that never dispatched (denied at the
		 * gate, approval-cancelled) record nothing.
		 *
		 * @param {object} exec - the settled execution.
		 * @param {{text: string, isError: boolean}} result - the rendered
		 *   result text and whether the dispatch failed.
		 * @returns {{decision: {kind: "accept"} | {kind: "block", feedback: Array<{type: "text", text: string}>}, recorded: object | null}}
		 */
		settle(exec, result) {
			if (!isDelegationTool(exec.name)) return { decision: { kind: "accept" }, recorded: null };
			this.releaseWriter(exec);
			const wasDispatched = dispatched.get(exec.token) === true;
			dispatched.delete(exec.token);
			if (!wasDispatched) return { decision: { kind: "accept" }, recorded: null };
			const session = sessionKey(exec);
			const taskId = extractTaskId(String(exec.arguments?.prompt ?? ""));
			const tool = exec.name;
			const role = specialistId(tool);
			if (taskId === null) {
				// Unreachable through the gate; keep a defensive record.
				return {
					decision: {
						kind: "block",
						feedback: [{ type: "text", text: "Error: delegation prompt carried no TASK_ID, so the result cannot be recorded. Re-run the delegation with a TASK_ID line." }]
					},
					recorded: null
				};
			}
			const task = taskState(session, taskId);

			// Real tool failures: pass through, count as a failed attempt.
			if (result.isError) {
				task.attempts.set(tool, (task.attempts.get(tool) ?? 0) + 1);
				task.delegationsUsed += 1;
				task.consecutiveFailures += 1;
				task.results.push({ at: Date.now(), tool, status: "ERROR", summary: null, errors: ["tool dispatch failed"], warnings: [] });
				return { decision: { kind: "accept" }, recorded: { status: "ERROR" } };
			}

			const parsed = parseEnvelope(result.text);
			const errors = [...parsed.errors];
			const envelopeTask = parsed.taskId;
			if (envelopeTask === null) {
				errors.push("missing TASK_ID section in envelope");
			} else if (envelopeTask !== taskId) {
				errors.push(`TASK_ID mismatch: prompt declares "${taskId}", envelope echoes "${envelopeTask}"`);
			}
			if (parsed.status === "SUCCESS") {
				const required = ROLE_REQUIRED_ON_SUCCESS[role] ?? [];
				for (const section of required) {
					if (!String(parsed.sections[section] ?? "").trim()) {
						errors.push(`STATUS: SUCCESS without a ${section} section (required for ${role})`);
					}
				}
			}
			const status = parsed.status ?? "PROTOCOL_ERROR";
			task.attempts.set(tool, (task.attempts.get(tool) ?? 0) + 1);
			task.delegationsUsed += 1;
			task.consecutiveFailures = status === "SUCCESS" ? 0 : task.consecutiveFailures + 1;
			task.results.push({
				at: Date.now(),
				tool,
				status,
				summary: parsed.summary,
				taskId: envelopeTask,
				errors,
				warnings: parsed.warnings
			});
			if (errors.length > 0) {
				return {
					decision: {
						kind: "block",
						feedback: [{
							type: "text",
							text: `Error: delegation envelope rejected by the orchestration broker:\n- ${errors.join("\n- ")}\n\nThis attempt consumed 1 delegation on task "${taskId}" (${task.delegationsUsed}/${cap.maxDelegationsPerTask}). Re-run the delegation with a corrected envelope (echo TASK_ID and STATUS/SUMMARY at minimum), or change strategy.`
						}]
					},
					recorded: { status, errors }
				};
			}
			return { decision: { kind: "accept" }, recorded: { status, taskId: envelopeTask } };
		},

		/**
		 * Render a human-readable broker report for one session (broker_status).
		 * @param {string} session - the session key.
		 * @returns {string} the report text.
		 */
		report(session) {
			const s = sessions.get(session);
			const lines = ["Orchestration broker state:"];
			if (s === void 0 || s.tasks.size === 0) {
				lines.push("- no delegations recorded yet");
			} else {
				for (const task of s.tasks.values()) {
					lines.push(`- task "${task.taskId}": ${task.delegationsUsed}/${cap.maxDelegationsPerTask} delegations, ${task.consecutiveFailures} consecutive non-SUCCESS, last result: ${task.results.at(-1)?.status ?? "none"}`);
					for (const [tool, count] of task.attempts) {
						lines.push(`  - ${tool}: ${count}/${cap.maxAttemptsPerSpecialist} attempts`);
					}
				}
			}
			return lines.join("\n");
		},

		/** Deep-enough snapshot of one session's state (tests). */
		snapshot(session) {
			const s = sessions.get(session);
			if (s === void 0) return { tasks: [] };
			return {
				tasks: [...s.tasks.values()].map((t) => ({
					taskId: t.taskId,
					delegationsUsed: t.delegationsUsed,
					attempts: Object.fromEntries(t.attempts),
					consecutiveFailures: t.consecutiveFailures,
					results: t.results.map((r) => ({ ...r }))
				}))
			};
		},

		/**
		 * Clear ALL broker state (locks, dispatch markers, sessions).
		 * Used by tests between cases; also safe for preset reloads.
		 */
		reset() {
			writerLocks.clear();
			dispatched.clear();
			sessions.clear();
		}
	};
}
