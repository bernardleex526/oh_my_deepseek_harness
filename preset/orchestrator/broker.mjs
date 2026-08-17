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
 *   mechanical "task boundary". Caps can be overridden via
 *   `$DSH_ORCHESTRATION_BUDGETS` (JSON).
 * - **Envelope gate**: after every delegation dispatch, the returned text is
 *   parsed (multi-line aware) and validated; malformed envelopes (missing or
 *   unknown STATUS, missing SUMMARY, bad/missing TASK_ID, TASK_ID mismatch,
 *   duplicate sections, or SUCCESS without the role's required evidence
 *   sections) are BLOCKED via the post-execute `block` decision, so a bad
 *   result is never handed to the model as success.
 * - **Result store + receipts**: every dispatched attempt is recorded per
 *   (session, task) with status, summary, protocol errors/warnings, the
 *   envelope sections, and mechanically extracted TEST RECEIPTS
 *   (`<command>: <result>` lines from VERIFICATION/OBSERVED). `report()`
 *   renders it for the `broker_status` tool — a Fixer/Observer can query
 *   earlier receipts and skip re-running an identical command (P1 test-run
 *   dedupe).
 * - **Persistence / crash recovery / replay** (opt-in via
 *   `$DSH_ORCHESTRATION_HOME`): every settled attempt is written to the
 *   ArtifactStore (raw text + parsed meta) and the session state is
 *   snapshotted, so a restarted process reloads budgets and full result
 *   history, and the CLI tools can render state and quality metrics.
 * - **Workspace fingerprint**: for fixer runs, a best-effort git fingerprint
 *   (HEAD + porcelain status hash) is captured before and after dispatch and
 *   stored with the result, giving keep-vs-revert decisions mechanical
 *   evidence of what changed in the workspace.
 *
 * IMPORT-FREE except for sibling files of the preset directory
 * (`./protocol.mjs`, `./artifacts.mjs`) and node builtins — the preset dir
 * has no node_modules.
 *
 * @module multi-agent-orchestrator/orchestration/broker
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extractTaskId, parseEnvelope, ROLE_REQUIRED_ON_SUCCESS } from "./protocol.mjs";
import { createArtifactStore } from "./artifacts.mjs";

/** Default mechanical budgets (mirror the Orchestrator prompt limits). */
export const DEFAULT_BUDGETS = {
	/** Max specialist delegations per TASK_ID. */
	maxDelegationsPerTask: 12,
	/** Max attempts of one specialist on one task (1 initial + 2 retries). */
	maxAttemptsPerSpecialist: 3,
	/** Consecutive non-SUCCESS results per task before the gate hard-stops. */
	maxConsecutiveFailures: 3,
	/**
	 * REPORT-ONLY receipt budget: VERIFICATION/OBSERVED entries reported per
	 * task. Not a mechanical gate (the broker cannot see commands the
	 * specialists run internally), but broker_status warns once exceeded so
	 * runaway test commands become visible.
	 */
	maxReceiptsPerTask: 12
};

/** Env var carrying a JSON budget override (e.g. {"maxDelegationsPerTask":20}). */
export const BUDGETS_ENV = "DSH_ORCHESTRATION_BUDGETS";

/**
 * Read budget overrides from `$DSH_ORCHESTRATION_BUDGETS`. Invalid values are
 * ignored (defaults stand); only known positive-integer keys are accepted.
 * @returns {Partial<typeof DEFAULT_BUDGETS>} the overrides.
 */
export function readBudgetsFromEnv() {
	const raw = process.env[BUDGETS_ENV];
	if (raw === void 0 || raw.trim() === "") return {};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const out = {};
	for (const key of Object.keys(DEFAULT_BUDGETS)) {
		const value = parsed[key];
		if (Number.isSafeInteger(value) && value > 0) out[key] = value;
	}
	return out;
}

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
 * Derive a task's mechanical state from its recorded results.
 *
 * PLANNED → RUNNING → IMPLEMENTED → VERIFIED → COMPLETE, with the audit's
 * review loop closed mechanically:
 * - a task becomes IMPLEMENTED once a Fixer SUCCESS is recorded;
 * - VERIFIED once an Observer SUCCESS is also recorded;
 * - COMPLETE when verified AND (no Oracle was consulted OR the latest Oracle
 *   result is SUCCESS);
 * - **BLOCKED when the latest Oracle result is BLOCKED** — the review
 *   failure closes the loop: further delegations on that TASK_ID are denied
 *   by the gate until the Orchestrator reopens the problem under a new id.
 *
 * @param {object} task - a task state (results, attempts, …).
 * @returns {"PLANNED" | "RUNNING" | "IMPLEMENTED" | "VERIFIED" | "REVIEWED" | "COMPLETE" | "BLOCKED"}
 */
export function deriveTaskState(task, { writerTools = [FIXER_DELEGATION] } = {}) {
	const writers = new Set(writerTools);
	const results = task.results ?? [];
	if (results.length === 0) return "PLANNED";
	const implementation = results.map((r, index) => ({ ...r, index })).filter((r) => writers.has(r.tool) && r.status === "SUCCESS").at(-1);
	const verification = results.map((r, index) => ({ ...r, index })).filter((r) => r.tool === "subagent_observer" && r.status === "SUCCESS").at(-1);
	const oracleResults = results.map((r, index) => ({ ...r, index })).filter((r) => r.tool === "subagent_oracle");
	const latestOracle = oracleResults.at(-1);
	if (latestOracle !== void 0 && latestOracle.status === "BLOCKED") return "BLOCKED";
	if (implementation !== void 0 && verification !== void 0) {
		// A review must be the LATEST Oracle result and must come AFTER the
		// implementation it reviews; a pre-fix Oracle consultation does not
		// satisfy the post-change review gate.
		if (latestOracle !== void 0 && latestOracle.status === "SUCCESS" && latestOracle.index > implementation.index) return "COMPLETE";
		if (latestOracle === void 0) return "COMPLETE";
		return "VERIFIED"; // review required but not (yet) passed
	}
	if (implementation !== void 0) return "IMPLEMENTED";
	return "RUNNING";
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
 * The ROOT session key for one execution: walk the durable `parentSession`
 * chain up to the top. Children (specialists) querying `broker_status` must
 * see their ROOT session's state, not their own empty one. With the preset's
 * maxDepth 1 every child is exactly one level below its root, so the first
 * parent id IS the root; deeper chains (never produced here) degrade to the
 * immediate parent.
 * @param {object} exec - an execution (or the broker_status caller).
 * @returns {string} the root session key.
 */
export function rootSessionKey(exec) {
	const agent = exec?.agent;
	const parent = agent?.session?.header?.parentSession;
	return parent ?? agent?.id ?? "unknown";
}

/**
 * Best-effort git fingerprint of a workspace: sha of `HEAD` + the porcelain
 * status output. Returns null when git is unavailable, the directory is not
 * a repository, or the call fails/times out (never throws).
 * @param {string} cwd - the workspace directory.
 * @returns {string | null} the fingerprint.
 */
export function gitFingerprint(cwd) {
	try {
		const opts = { cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" };
		const head = execSync("git rev-parse HEAD", opts).trim();
		let status = "";
		try {
			status = execSync("git status --porcelain", opts);
		} catch {
			status = ""; // dirty/unknown status still yields a head-based fingerprint
		}
		// Hash the actual porcelain text, not its length: same-length but
		// different workspace states must never collide for receipt dedupe.
		const statusHash = createHash("sha256").update(status).digest("hex");
		return `${head}:${statusHash}`;
	} catch {
		return null;
	}
}

/**
 * Parse ONE receipt line into a structured receipt.
 *
 * Format: `<command> [key=value,key=value]: <result>` where the bracket
 * annotation is optional and holds machine-readable fields:
 * - `risk=R0|R1|R2|R3`  the risk tier the command belongs to (pytest
 *   layering: R0 docs/none, R1 targeted unit, R2 contract, R3 integration);
 * - `exit=<code>`        the process exit code;
 * - `counts=<n>`         e.g. number of tests in the run;
 * - `fail=a::b;c::d`     failing nodeids, `;`-separated.
 *
 * Plain `<command>: <result>` lines (no annotation) still parse — the
 * annotation is an opt-in extension.
 * @param {string} line - one line of a VERIFICATION/OBSERVED body.
 * @returns {{command: string, result: string, risk?: string, exit?: number,
 *   counts?: number, fail?: string[]} | null}
 */
export function parseReceiptLine(line) {
	const text = String(line);
	// 1) annotation-anchored: `<command> [k=v,…]: <result>` — the bracket is
	//    the anchor, so commands containing `::` (pytest nodeids) survive.
	let m = text.match(/^([^\n]+?)\s*\[([^\]]*)\]\s*:\s*(.*)$/);
	// 2) plain: `<command>: <result>` (command must not contain a colon).
	if (m === null) m = text.match(/^([^:]+?):\s*(.*)$/);
	if (m === null) return null;
	const command = m[1].trim();
	if (command === "" || /^[A-Z_]+$/.test(command)) return null; // section headers, not commands
	const receipt = { command, result: m[m.length - 1].trim() };
	const annotation = m[2] ?? "";
	for (const pair of annotation.split(",")) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (key === "risk" && /^R[0-3]$/i.test(value)) receipt.risk = value.toUpperCase();
		else if (key === "exit" && /^-?\d+$/.test(value)) receipt.exit = Number(value);
		else if (key === "counts" && /^\d+$/.test(value)) receipt.counts = Number(value);
		else if (key === "fail" && value !== "") receipt.fail = value.split(";").map((s) => s.trim()).filter(Boolean);
	}
	return receipt;
}

/**
 * Whether a receipt counts as a SUCCESSFUL verification (for dedupe):
 * an explicit `exit=0`, or a result text that reads as a pass.
 * @param {object} receipt - a parsed receipt.
 * @returns {boolean}
 */
export function receiptSucceeded(receipt) {
	if (receipt.exit !== void 0) return receipt.exit === 0;
	return /pass|clean|ok|success/i.test(receipt.result);
}

/**
 * Mechanically extract test receipts from a multi-line section body.
 * @param {string} sectionText - the raw section body (VERIFICATION/OBSERVED).
 * @returns {Array<object>} parsed receipts.
 */
export function extractReceipts(sectionText) {
	const text = String(sectionText ?? "");
	const receipts = [];
	for (const line of text.split(/\r?\n/)) {
		const receipt = parseReceiptLine(line);
		if (receipt !== null) receipts.push(receipt);
	}
	return receipts;
}

/**
 * Create one broker instance (process-local state, optionally persisted).
 * @param {Partial<typeof DEFAULT_BUDGETS>} [budgets] - budget overrides.
 * @param {object} [store] - the ArtifactStore (default: env-enabled store).
 * @param {{writerTools?: string[]}} [options] - writer-capable delegation
 *   tool names (the single-writer set).
 * @returns {object} the broker API.
 */
export function createBroker(budgets = {}, store = createArtifactStore(), { writerTools = [FIXER_DELEGATION] } = {}) {
	const cap = { ...DEFAULT_BUDGETS, ...budgets };
	const writerToolSet = new Set(writerTools);
	/** workspace -> { token, session } — the single-writer guard. */
	const writerLocks = new Map();
	/** execution token -> true once dispatch actually started (tools/execute). */
	const dispatched = new Map();
	/** execution token -> reservation metadata for in-flight budget accounting. */
	const reservations = new Map();
	/** session -> { tasks: Map<taskId, TaskState>, writerTools: Set<string> } */
	const sessions = new Map();
	/** sessions already merged from disk (avoid repeated reads). */
	const loadedSessions = new Set();

	/** Load one session's persisted state at most once per process. */
	function ensureSessionLoaded(session) {
		if (loadedSessions.has(session)) return sessions.get(session);
		loadedSessions.add(session);
		const persisted = store.readSessionState(session);
		if (persisted?.tasks !== void 0 && Array.isArray(persisted.tasks)) {
			const tasks = new Map();
			for (const t of persisted.tasks) {
				if (typeof t.taskId !== "string") continue;
				tasks.set(t.taskId, {
					taskId: t.taskId,
					delegationsUsed: Number.isSafeInteger(t.delegationsUsed) ? t.delegationsUsed : 0,
					attempts: new Map(Object.entries(t.attempts ?? {})),
					consecutiveFailures: Number.isSafeInteger(t.consecutiveFailures) ? t.consecutiveFailures : 0,
					results: Array.isArray(t.results) ? t.results : [],
					receipts: Array.isArray(t.receipts) ? t.receipts : [],
					workspaceFingerprint: typeof t.workspaceFingerprint === "string" ? t.workspaceFingerprint : null,
					duplicateReceipts: Number.isSafeInteger(t.duplicateReceipts) ? t.duplicateReceipts : 0,
					pendingDelegations: 0,
					pendingAttempts: new Map()
				});
			}
			const persistedWriters = Array.isArray(persisted.writerTools)
				? persisted.writerTools.filter((name) => typeof name === "string")
				: [...writerToolSet];
			const s = { tasks, writerTools: new Set(persistedWriters) };
			sessions.set(session, s);
			return s;
		}
		return void 0;
	}

	/** Ensure a session state exists. */
	function sessionState(session) {
		const loaded = ensureSessionLoaded(session);
		if (loaded !== void 0) return loaded;
		let s = sessions.get(session);
		if (s === void 0) {
			s = { tasks: new Map(), writerTools: new Set(writerToolSet) };
			sessions.set(session, s);
		}
		return s;
	}

	/** Ensure a task state exists for (session, taskId). */
	function taskState(session, taskId) {
		const s = sessionState(session);
		let task = s.tasks.get(taskId);
		if (task === void 0) {
			task = {
				taskId,
				delegationsUsed: 0,
				attempts: new Map(), // toolName -> completed attempts
				consecutiveFailures: 0,
				results: [], // { at, tool, status, summary, errors, warnings, receipts?, fingerprint? }
				receipts: [], // accumulated receipts across the task (dedupe/replay)
				workspaceFingerprint: null, // last known workspace fingerprint
				duplicateReceipts: 0,
				pendingDelegations: 0,
				pendingAttempts: new Map() // toolName -> in-flight reservations
			};
			s.tasks.set(taskId, task);
		}
		return task;
	}

	/** Persist one session's state (no-op when the store is disabled). */
	function persist(session) {
		const s = sessions.get(session);
		if (s === void 0) return;
		store.writeSessionState(session, {
			writerTools: [...s.writerTools],
			tasks: [...s.tasks.values()].map((t) => ({
				taskId: t.taskId,
				delegationsUsed: t.delegationsUsed,
				attempts: Object.fromEntries(t.attempts),
				consecutiveFailures: t.consecutiveFailures,
				results: t.results,
				receipts: t.receipts,
				workspaceFingerprint: t.workspaceFingerprint,
				duplicateReceipts: t.duplicateReceipts
			}))
		});
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
			const s = sessionState(session);
			const task = taskState(session, taskId);
			const pendingDelegations = task.pendingDelegations;
			const pendingAttempts = task.pendingAttempts.get(exec.name) ?? 0;
			// Review-failure loop closure: an Oracle BLOCKED result blocks ALL
			// further delegations on this TASK_ID until the Orchestrator
			// reopens the problem under a NEW id with the corrected approach.
			if (deriveTaskState(task, { writerTools: [...s.writerTools] }) === "BLOCKED") {
				return {
					ok: false,
					kind: "review",
					reason: `review blocked: Oracle returned BLOCKED on task "${taskId}" — do NOT keep delegating on this id; open a NEW TASK_ID with the corrected approach, or stop and report.`
				};
			}
			// In-flight reservations count against the caps so parallel
			// delegation calls cannot all pass the gate before any settles.
			if (task.delegationsUsed + pendingDelegations >= cap.maxDelegationsPerTask) {
				return {
					ok: false,
					kind: "budget",
					reason: `task budget exhausted: task "${taskId}" has ${task.delegationsUsed + pendingDelegations}/${cap.maxDelegationsPerTask} delegations used or in flight — open a new TASK_ID for a new subproblem, or stop and report to the user.`
				};
			}
			const attempts = task.attempts.get(exec.name) ?? 0;
			if (attempts + pendingAttempts >= cap.maxAttemptsPerSpecialist) {
				return {
					ok: false,
					kind: "budget",
					reason: `retry budget exhausted: ${exec.name} has ${attempts + pendingAttempts}/${cap.maxAttemptsPerSpecialist} attempts used or in flight on task "${taskId}" — re-frame it as a NEW TASK_ID with a materially narrower question, or stop.`
				};
			}
			// Conservative consecutive-failure gate: every in-flight call may
			// fail, so reserve capacity for the worst case before admitting it.
			if (task.consecutiveFailures + pendingDelegations + 1 > cap.maxConsecutiveFailures) {
				return {
					ok: false,
					kind: "budget",
					reason: `hard stop: ${task.consecutiveFailures} consecutive non-SUCCESS results with ${pendingDelegations} delegation(s) in flight on task "${taskId}" — report to the user instead of retrying.`
				};
			}
			if (writerToolSet.has(exec.name)) {
				const ws = callerWorkspace(exec);
				if (writerLocks.has(ws)) {
					return {
						ok: false,
						kind: "writer",
						reason: `single-writer: a writer delegation is already in progress for workspace "${ws}" — writes are serialized; wait for it to finish.`
					};
				}
				writerLocks.set(ws, { token: exec.token, session, baseline: gitFingerprint(exec?.agent?.session?.header?.cwd ?? process.cwd()) });
			}
			// Reserve budget slots at the gate so parallel calls observe them.
			task.pendingDelegations += 1;
			task.pendingAttempts.set(exec.name, pendingAttempts + 1);
			reservations.set(exec.token, { session, taskId, tool: exec.name });
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
		 * Release one gate-time budget reservation (no completed attempt is
		 * recorded). Called by pre-execute/execute error paths and by
		 * `settle()` for denials/cancellations that never dispatched.
		 * @param {object} exec - the execution that owns the reservation.
		 * @returns {object | null} the released reservation metadata.
		 */
		releaseReservation(exec) {
			const reservation = reservations.get(exec.token);
			if (reservation === void 0) return null;
			reservations.delete(exec.token);
			const task = sessions.get(reservation.session)?.tasks.get(reservation.taskId);
			if (task !== void 0) {
				task.pendingDelegations = Math.max(0, task.pendingDelegations - 1);
				const pending = task.pendingAttempts.get(reservation.tool) ?? 0;
				if (pending <= 1) task.pendingAttempts.delete(reservation.tool);
				else task.pendingAttempts.set(reservation.tool, pending - 1);
			}
			return reservation;
		},

		/**
		 * Release the writer lock, but only for the exact call that holds it.
		 * @param {object} exec - the completing execution.
		 */
		releaseWriter(exec) {
			if (!writerToolSet.has(exec.name)) return;
			const ws = callerWorkspace(exec);
			const held = writerLocks.get(ws);
			if (held !== void 0 && held.token === exec.token) writerLocks.delete(ws);
		},

		/**
		 * Settle one delegation after dispatch (from `tools/post-execute`):
		 * release the writer lock, record the attempt (with receipts and
		 * workspace fingerprint), persist the artifact, validate the envelope,
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
			// Capture the writer's baseline fingerprint BEFORE releasing the
			// writer lock (the lock entry carries it and is deleted on release).
			const ws = callerWorkspace(exec);
			const baseline = writerLocks.get(ws)?.baseline ?? null;
			this.releaseWriter(exec);
			// Release the gate-time budget reservation on every settle path.
			// For a real dispatch the completed counters are incremented below;
			// for denials/cancellations this is the only accounting step.
			this.releaseReservation(exec);
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
			const callIndex = task.results.length;
			const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();

			// Real tool failures: pass through, count as a failed attempt.
			if (result.isError) {
				const record = {
					at: Date.now(),
					tool,
					status: "ERROR",
					summary: null,
					errors: ["tool dispatch failed"],
					warnings: [],
					callIndex
				};
				task.attempts.set(tool, (task.attempts.get(tool) ?? 0) + 1);
				task.delegationsUsed += 1;
				task.consecutiveFailures += 1;
				task.results.push(record);
				store.writeArtifact({ session, taskId, callIndex, tool, status: record.status }, result.text);
				persist(session);
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
			// Mechanical test receipts from the role evidence sections.
			const receipts = [];
			for (const section of ["VERIFICATION", "OBSERVED"]) {
				for (const receipt of extractReceipts(parsed.sections[section] ?? "")) {
					receipts.push({ ...receipt, section });
				}
			}
			const record = {
				at: Date.now(),
				tool,
				status,
				summary: parsed.summary,
				taskId: envelopeTask,
				errors,
				warnings: [...parsed.warnings],
				receipts,
				callIndex
			};
			const fingerprintNow = gitFingerprint(cwd);
			if (writerToolSet.has(tool)) {
				record.fingerprint = {
					before: baseline,
					after: fingerprintNow
				};
				if (typeof record.fingerprint.after === "string") {
					task.workspaceFingerprint = record.fingerprint.after;
				}
			} else if (typeof fingerprintNow === "string") {
				// Re-sample at every settle so changes made outside a writer
				// run are visible before receipt dedupe decides.
				task.workspaceFingerprint = fingerprintNow;
			}
			// Duplicate-verification detection (pytest dedupe): a receipt whose
			// command already has a SUCCESS receipt on this task, recorded at
			// the SAME workspace fingerprint, is a re-run we flag so the
			// Orchestrator can see verification was repeated, not added.
			const fpNow = fingerprintNow ?? task.workspaceFingerprint;
			for (const receipt of receipts) {
				const prior = task.receipts.find((p) => p.command === receipt.command && p.success === true);
				if (prior !== void 0 && prior.fingerprint !== null && fpNow !== null && prior.fingerprint === fpNow) {
					receipt.duplicate = true;
					task.duplicateReceipts += 1;
					record.warnings.push(`duplicate verification: "${receipt.command}" was already verified at this workspace fingerprint (receipt #${prior.index}) — cite it instead of re-running`);
				}
				task.receipts.push({
					...receipt,
					tool,
					at: record.at,
					fingerprint: fpNow,
					success: receiptSucceeded(receipt),
					index: task.receipts.length
				});
			}
			if (task.receipts.length > cap.maxReceiptsPerTask) {
				record.warnings.push(`receipt budget exceeded: ${task.receipts.length}/${cap.maxReceiptsPerTask} commands reported on task "${taskId}" — prefer citing existing receipts over re-running`);
			}
			task.attempts.set(tool, (task.attempts.get(tool) ?? 0) + 1);
			task.delegationsUsed += 1;
			task.consecutiveFailures = status === "SUCCESS" ? 0 : task.consecutiveFailures + 1;
			task.results.push(record);
			store.writeArtifact({ session, taskId, callIndex, tool, status, summary: record.summary, errors, warnings: record.warnings, receipts }, result.text);
			persist(session);
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
		 * Render a human-readable broker report for one ROOT session
		 * (broker_status tool). Supports optional task filtering, receipt
		 * detail (for test-run dedupe) and artifact listing.
		 * @param {string} session - the root session key.
		 * @param {{taskId?: string, includeArtifacts?: boolean}} [opts]
		 * @returns {string} the report text.
		 */
		report(session, { taskId, includeArtifacts = false } = {}) {
			const lines = ["Orchestration broker state:"];
			lines.push(`- budgets: ${cap.maxDelegationsPerTask} delegations/task, ${cap.maxAttemptsPerSpecialist} attempts/specialist/task, ${cap.maxConsecutiveFailures} consecutive failures, ${cap.maxReceiptsPerTask} receipts/task (report-only)`);
			const s = sessionState(session);
			const tasks = [...s.tasks.values()].filter((t) => taskId === void 0 || t.taskId === taskId);
			if (tasks.length === 0) {
				lines.push("- no delegations recorded yet");
			} else {
				for (const task of tasks) {
					const state = deriveTaskState(task, { writerTools: [...s.writerTools] });
					const pending = task.pendingDelegations > 0 ? `, ${task.pendingDelegations} in flight` : "";
					const dup = task.duplicateReceipts > 0 ? `, ${task.duplicateReceipts} duplicate verification(s)` : "";
					lines.push(`- task "${task.taskId}" [${state}]: ${task.delegationsUsed}/${cap.maxDelegationsPerTask} delegations${pending}, ${task.consecutiveFailures} consecutive non-SUCCESS, ${task.receipts.length}/${cap.maxReceiptsPerTask} receipts${dup}`);
					if (state === "COMPLETE") {
						lines.push("  - COMPLETE: implementation verified and the post-change review passed — reporting completion is now allowed");
					} else if (state === "BLOCKED") {
						lines.push("  - BLOCKED: the latest Oracle review returned BLOCKED — do NOT keep delegating on this TASK_ID; reopen under a NEW id");
					} else if (state === "VERIFIED") {
						lines.push("  - VERIFIED: an Oracle review after the latest implementation is required but not passed yet — completion must wait");
					}
					for (const [tool, count] of task.attempts) {
						lines.push(`  - ${tool}: ${count}/${cap.maxAttemptsPerSpecialist} attempts`);
					}
					for (const r of task.results) {
						const extra = r.receipts?.length
							? `, receipts: ${r.receipts.map((x) => x.command).join(" | ")}`
							: "";
						lines.push(`  - #${r.callIndex} ${r.tool}: ${r.status}${extra}`);
						if (r.fingerprint?.after !== void 0) {
							lines.push(`    workspace fingerprint after: ${r.fingerprint.after}`);
						}
					}
					// Receipt detail is what lets a specialist decide BEFORE running
					// a command whether an identical successful run already exists.
					for (const receipt of task.receipts) {
						const risk = receipt.risk ?? "R?";
						const exit = receipt.exit === void 0 ? "?" : String(receipt.exit);
						const success = receipt.success === true ? "success" : "not-success";
						const fingerprint = typeof receipt.fingerprint === "string" ? ` @ ${receipt.fingerprint.slice(0, 24)}` : "";
						const result = String(receipt.result ?? "").slice(0, 80);
						lines.push(`  - receipt #${receipt.index} ${receipt.command} [${risk}, exit=${exit}, ${success}]${fingerprint}: ${result}`);
					}
				}
			}
			if (includeArtifacts && store.enabled) {
				const artifacts = store.listArtifacts(session).filter((a) => taskId === void 0 || a.taskId === taskId);
				lines.push(`- artifacts (${artifacts.length}):`);
				for (const a of artifacts.slice(0, 20)) {
					lines.push(`  ${a.taskId}/${String(a.callIndex).padStart(3, "0")}-${a.tool}: ${a.size} bytes`);
				}
			}
			return lines.join("\n");
		},

		/** Deep-enough snapshot of one session's state (tests/persistence). */
		snapshot(session) {
			const s = sessionState(session);
			return {
				writerTools: [...s.writerTools],
				tasks: [...s.tasks.values()].map((t) => ({
					taskId: t.taskId,
					delegationsUsed: t.delegationsUsed,
					attempts: Object.fromEntries(t.attempts),
					consecutiveFailures: t.consecutiveFailures,
					results: t.results.map((r) => ({ ...r })),
					receipts: t.receipts.map((r) => ({ ...r })),
					workspaceFingerprint: t.workspaceFingerprint,
					duplicateReceipts: t.duplicateReceipts,
					pendingDelegations: t.pendingDelegations,
					state: deriveTaskState(t, { writerTools: [...s.writerTools] })
				}))
			};
		},

		/**
		 * Clear in-memory broker state (locks, dispatch markers, sessions).
		 * Used by tests between cases; disk state is untouched.
		 */
		reset() {
			writerLocks.clear();
			dispatched.clear();
			reservations.clear();
			sessions.clear();
			loadedSessions.clear();
		}
	};
}
