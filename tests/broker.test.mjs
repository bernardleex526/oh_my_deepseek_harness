/**
 * Broker unit tests: the mechanical multi-agent runtime state
 * (workspace-keyed writer lock, per-task budgets, envelope gate, result
 * store) — all import-free, no harness packages needed.
 *
 * @module multi-agent-orchestrator/tests/broker
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBroker,
	normalizeWorkspace,
	callerWorkspace,
	sessionKey,
	rootSessionKey,
	isDelegationTool,
	specialistId,
	FIXER_DELEGATION,
	DEFAULT_BUDGETS,
	extractReceipts,
	parseReceiptLine,
	receiptSucceeded,
	deriveTaskState,
	readBudgetsFromEnv,
	BUDGETS_ENV
} from "../src/orchestration/broker.mjs";
import { createArtifactStore } from "../src/orchestration/artifacts.mjs";

const FIXER = FIXER_DELEGATION;
const EXPLORER = "subagent_explorer";

/** A minimal fake execution object. */
function exec(name, token, { caller = "session-A", cwd, prompt = "TASK_ID: t1\nDo it." } = {}) {
	const agent = { id: caller };
	if (cwd !== void 0) agent.session = { header: { cwd } };
	return { name, token, agent, arguments: { prompt } };
}

/** Run a full pre-execute gate → dispatch → settle round for one call. */
function roundTrip(broker, e, { isError = false, text = "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: done." } = {}) {
	const gate = broker.gate(e);
	if (!gate.ok) return { gate };
	broker.markDispatched(e);
	return { gate, settled: broker.settle(e, { text, isError }) };
}

/** A temp artifact store root (deleted after the test). */
function tempStore(t) {
	const root = mkdtempSync(join(tmpdir(), "mao-broker-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

// ── workspace normalization ────────────────────────────────────────────────

test("normalizeWorkspace collapses separators, case and trailing slashes", () => {
	assert.equal(normalizeWorkspace("C:\\Proj\\App\\"), "c:/proj/app");
	assert.equal(normalizeWorkspace("c:/proj/app"), "c:/proj/app");
	assert.equal(normalizeWorkspace("/proj/app///"), "/proj/app");
	assert.equal(normalizeWorkspace(""), null);
	assert.equal(normalizeWorkspace(undefined), null);
});

test("callerWorkspace prefers the session cwd, falls back to caller id, then unknown", () => {
	assert.equal(callerWorkspace(exec(FIXER, "t", { cwd: "C:\\Proj\\App\\" })), "c:/proj/app");
	assert.equal(callerWorkspace(exec(FIXER, "t", { caller: "sess-1" })), "sess-1");
	assert.equal(callerWorkspace({ name: FIXER, token: "t" }), "unknown");
});

test("sessionKey is the caller agent id", () => {
	assert.equal(sessionKey(exec(FIXER, "t")), "session-A");
	assert.equal(sessionKey({ name: FIXER, token: "t" }), "unknown");
});

test("isDelegationTool / specialistId classify the subagent family", () => {
	assert.ok(isDelegationTool(EXPLORER));
	assert.ok(isDelegationTool(FIXER));
	assert.ok(!isDelegationTool("read"));
	assert.equal(specialistId(FIXER), "fixer");
	assert.equal(specialistId("read"), "read");
});

// ── writer lock ────────────────────────────────────────────────────────────

test("writer lock is per workspace and ownership-scoped", () => {
	const broker = createBroker();
	const a = exec(FIXER, "token-A", { cwd: "/proj/app" });
	const b = exec(FIXER, "token-B", { cwd: "/proj/other" });
	const a2 = exec(FIXER, "token-A2", { cwd: "/proj/app" });

	assert.deepEqual(broker.gate(a), { ok: true });
	assert.ok(broker.isWriterLocked("/proj/app"));
	// same workspace, different token → denied
	assert.equal(broker.gate(a2).ok, false);
	assert.match(broker.gate(a2).reason, /single-writer/);
	// different workspace → allowed
	assert.deepEqual(broker.gate(b), { ok: true });
	// a non-owner completion cannot release the workspace lock
	broker.releaseWriter(a2);
	assert.ok(broker.isWriterLocked("/proj/app"), "non-owner must not release");
	broker.releaseWriter(a);
	assert.ok(!broker.isWriterLocked("/proj/app"), "owner releases");
});

// ── TASK_ID protocol gate ──────────────────────────────────────────────────

test("gate denies delegations whose prompt declares no TASK_ID", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t", { prompt: "Find the auth code." });
	const gate = broker.gate(e);
	assert.equal(gate.ok, false);
	assert.match(gate.reason, /TASK_ID/);
});

test("gate passes non-delegation tools untouched", () => {
	const broker = createBroker();
	assert.deepEqual(broker.gate({ name: "read", token: "t" }), { ok: true });
});

// ── budgets ────────────────────────────────────────────────────────────────

test("delegation budget caps total delegations per TASK_ID", () => {
	const broker = createBroker({ maxDelegationsPerTask: 2 });
	const e1 = roundTrip(broker, exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	const e2 = roundTrip(broker, exec(EXPLORER, "t2", { prompt: "TASK_ID: t1\nFind y." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	assert.equal(e1.gate.ok, true);
	assert.equal(e2.gate.ok, true);
	const third = broker.gate(exec(EXPLORER, "t3", { prompt: "TASK_ID: t1\nFind z." }));
	assert.equal(third.ok, false);
	assert.match(third.reason, /budget exhausted/);
	// a NEW task id resets the budget
	assert.equal(broker.gate(exec(EXPLORER, "t4", { prompt: "TASK_ID: t2\nFind z." })).ok, true);
});

test("a new TASK_ID resets per-task counters", () => {
	const broker = createBroker({ maxDelegationsPerTask: 1 });
	// consume t1's single delegation (budget counts at settle)
	const first = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nA" });
	assert.equal(broker.gate(first).ok, true);
	broker.markDispatched(first);
	broker.settle(first, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.", isError: false });
	assert.equal(broker.gate(exec(EXPLORER, "t2", { prompt: "TASK_ID: t1\nB" })).ok, false, "t1 exhausted");
	assert.equal(broker.gate(exec(EXPLORER, "t3", { prompt: "TASK_ID: t2\nC" })).ok, true, "t2 fresh");
});

test("retry budget caps attempts per specialist per task", () => {
	const broker = createBroker({ maxAttemptsPerSpecialist: 2 });
	const mk = (token) => exec(EXPLORER, token, { prompt: "TASK_ID: t1\nFind x." });
	const ok = (token) => roundTrip(broker, mk(token), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	assert.equal(ok("a1").gate.ok, true);
	assert.equal(ok("a2").gate.ok, true);
	const third = broker.gate(mk("a3"));
	assert.equal(third.ok, false);
	assert.match(third.reason, /retry budget exhausted/);
	// other specialists on the same task are unaffected
	assert.equal(broker.gate(exec("subagent_oracle", "a4", { prompt: "TASK_ID: t1\nWhy?" })).ok, true);
});

test("parallel non-writer delegations cannot overshoot task or specialist budgets", () => {
	const broker = createBroker({ maxDelegationsPerTask: 1, maxAttemptsPerSpecialist: 1, maxConsecutiveFailures: 1 });
	const mk = (token) => exec(EXPLORER, token, { prompt: "TASK_ID: t1\nFind x." });
	const first = mk("p1");
	const second = mk("p2");
	assert.equal(broker.gate(first).ok, true);
	// The first call is still in flight; the second gate must see its reservation.
	assert.equal(broker.gate(second).ok, false, "in-flight reservations must count against the caps");
	// Deny/cancel path: settle without dispatch releases the reservation.
	broker.settle(second, { text: "denied", isError: true });
	// The original call dispatches and settles normally.
	broker.markDispatched(first);
	broker.settle(first, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found.", isError: false });
	assert.equal(broker.snapshot("session-A").tasks[0].delegationsUsed, 1);
});

test("consecutive non-SUCCESS results hard-stop the task", () => {
	const broker = createBroker({ maxConsecutiveFailures: 2 });
	const mk = (token, prompt) => exec(EXPLORER, token, { prompt: `TASK_ID: t1\n${prompt}` });
	// two failures
	roundTrip(broker, mk("f1", "A"), { text: "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: nope." });
	roundTrip(broker, mk("f2", "B"), { text: "TASK_ID: t1\nSTATUS: PARTIAL\nSUMMARY: partly." });
	const gate = broker.gate(mk("f3", "C"));
	assert.equal(gate.ok, false);
	assert.match(gate.reason, /consecutive non-SUCCESS/);
});

test("a SUCCESS resets the consecutive-failure counter", () => {
	const broker = createBroker({ maxConsecutiveFailures: 2 });
	const mk = (token, prompt) => exec(EXPLORER, token, { prompt: `TASK_ID: t1\n${prompt}` });
	roundTrip(broker, mk("f1", "A"), { text: "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: nope." });
	roundTrip(broker, mk("s1", "B"), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok." });
	// counter reset → still allowed
	assert.equal(broker.gate(mk("f2", "C")).ok, true);
});

// ── settle / envelope gate ─────────────────────────────────────────────────

test("settle records dispatched attempts and stores results", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found it.\nFINDINGS: src/a.js:1", isError: false });
	assert.equal(outcome.decision.kind, "accept");
	assert.equal(outcome.recorded.status, "SUCCESS");
	const snap = broker.snapshot("session-A");
	assert.equal(snap.tasks.length, 1);
	assert.equal(snap.tasks[0].delegationsUsed, 1);
	assert.equal(snap.tasks[0].attempts[EXPLORER], 1);
	assert.equal(snap.tasks[0].results[0].summary, "found it.");
	assert.equal(snap.tasks[0].consecutiveFailures, 0);
});

test("settle ignores calls that never dispatched (gate denials)", () => {
	const broker = createBroker();
	// gate denies (no TASK_ID)
	const e = exec(EXPLORER, "t1", { prompt: "no id" });
	broker.gate(e);
	// a real pipeline still fires post-execute for the denied call
	const outcome = broker.settle(e, { text: "Error: denied", isError: true });
	assert.equal(outcome.decision.kind, "accept");
	assert.equal(outcome.recorded, null);
	assert.deepEqual(broker.snapshot("session-A").tasks, []);
});

test("settle passes real tool errors through but counts the attempt", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "Error: provider timeout", isError: true });
	assert.equal(outcome.decision.kind, "accept", "real tool errors are already visible; do not double-block");
	const snap = broker.snapshot("session-A");
	assert.equal(snap.tasks[0].results[0].status, "ERROR");
	assert.equal(snap.tasks[0].consecutiveFailures, 1);
});

test("envelope gate blocks a result without STATUS", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t1\nSUMMARY: no status here", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /missing STATUS/);
	// the failed protocol attempt still counts (consumed delegation)
	assert.equal(broker.snapshot("session-A").tasks[0].consecutiveFailures, 1);
});

test("envelope gate blocks a TASK_ID mismatch between prompt and envelope", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t9\nSTATUS: SUCCESS\nSUMMARY: done.", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /TASK_ID mismatch/);
});

test("envelope gate blocks SUCCESS without the role's required evidence", () => {
	const broker = createBroker();
	// fixer SUCCESS must carry CHANGES + VERIFICATION
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	const outcome = broker.settle(fix, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: fixed.", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /CHANGES/);
	assert.match(outcome.decision.feedback[0].text, /VERIFICATION/);

	// observer SUCCESS must carry OBSERVED
	const obs = exec("subagent_observer", "t2", { prompt: "TASK_ID: t1\nObserve." });
	broker.gate(obs);
	broker.markDispatched(obs);
	const obsOutcome = broker.settle(obs, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: saw things.", isError: false });
	assert.equal(obsOutcome.decision.kind, "block");
	assert.match(obsOutcome.decision.feedback[0].text, /OBSERVED/);
});

test("envelope gate ACCEPTS a complete fixer SUCCESS with CHANGES + VERIFICATION", () => {
	const broker = createBroker();
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	const outcome = broker.settle(fix, {
		text: [
			"TASK_ID: t1",
			"STATUS: SUCCESS",
			"SUMMARY: fixed the bug",
			"CHANGES:",
			"  src/a.js: corrected the check",
			"VERIFICATION:",
			"  npm test: 12 passed",
			"EVIDENCE: git diff src/a.js",
			"UNCERTAINTIES: none",
			"RECOMMENDED_NEXT_STEP: run the full suite"
		].join("\n"),
		isError: false
	});
	assert.equal(outcome.decision.kind, "accept", `unexpected block: ${outcome.decision.kind === "block" ? outcome.decision.feedback[0].text : ""}`);
	assert.equal(broker.snapshot("session-A").tasks[0].results[0].status, "SUCCESS");
});

// ── observability ──────────────────────────────────────────────────────────

test("report renders per-task budget state and empty state", () => {
	const broker = createBroker();
	assert.match(broker.report("session-A"), /no delegations recorded/);
	roundTrip(broker, exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	const report = broker.report("session-A");
	assert.match(report, /task "t1"/);
	assert.match(report, new RegExp(String(DEFAULT_BUDGETS.maxDelegationsPerTask)));
	assert.match(report, new RegExp(EXPLORER));
});

test("reset clears all broker state", () => {
	const broker = createBroker();
	roundTrip(broker, exec(FIXER, "t1", { cwd: "/proj", prompt: "TASK_ID: t1\nFix." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  t: pass" });
	broker.reset();
	assert.deepEqual(broker.snapshot("session-A").tasks, []);
	assert.ok(!broker.isWriterLocked("/proj"));
	assert.deepEqual(broker.gate(exec(FIXER, "t2", { cwd: "/proj", prompt: "TASK_ID: t1\nFix." })), { ok: true });
});

// ── P1: test receipts ──────────────────────────────────────────────────────

test("extractReceipts parses <command>: <result> lines and skips headers", () => {
	const body = [
		"npm test: 42 passed",
		"  npm run lint: clean",
		"pytest tests/unit: 17 passed, 2 failed",
		"STATUS: SUCCESS",
		"all good"
	].join("\n");
	const receipts = extractReceipts(body);
	assert.equal(receipts.length, 3);
	assert.deepEqual(receipts[0], { command: "npm test", result: "42 passed" });
	assert.deepEqual(receipts[1], { command: "npm run lint", result: "clean" });
	assert.equal(receipts[2].command, "pytest tests/unit");
	assert.deepEqual(extractReceipts(""), []);
	assert.deepEqual(extractReceipts("no colons here"), []);
});

test("fixer SUCCESS results carry mechanically extracted receipts", () => {
	const broker = createBroker();
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, {
		text: [
			"TASK_ID: t1",
			"STATUS: SUCCESS",
			"SUMMARY: fixed",
			"CHANGES:",
			"  src/a.js: x",
			"VERIFICATION:",
			"  npm test: 42 passed",
			"  pytest tests/unit: 17 passed",
			"EVIDENCE: git diff",
			"UNCERTAINTIES: none",
			"RECOMMENDED_NEXT_STEP: none"
		].join("\n"),
		isError: false
	});
	const snap = broker.snapshot("session-A");
	const result = snap.tasks[0].results[0];
	assert.ok(Array.isArray(result.receipts));
	assert.equal(result.receipts.length, 2);
	assert.equal(result.receipts[0].command, "npm test");
	assert.equal(result.receipts[0].section, "VERIFICATION");
	assert.equal(result.receipts[1].command, "pytest tests/unit");
});

test("fixer results record before/after workspace fingerprints (null-safe)", () => {
	const broker = createBroker();
	const fix = exec(FIXER, "t1", { cwd: "/nonexistent-dir-xyz", prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test: pass", isError: false });
	const result = broker.snapshot("session-A").tasks[0].results[0];
	assert.ok(result.fingerprint !== void 0, "fixer records must carry a fingerprint field");
	assert.ok("before" in result.fingerprint && "after" in result.fingerprint);
});

// ── P1: root session key (children querying broker_status) ────────────────

test("rootSessionKey walks the parentSession header to the root", () => {
	assert.equal(rootSessionKey(exec(EXPLORER, "t")), "session-A", "root agent → own id");
	const child = { name: EXPLORER, token: "t", agent: { id: "child-1", session: { header: { parentSession: "session-A" } } } };
	assert.equal(rootSessionKey(child), "session-A", "depth-1 child → parent id");
	const orphan = { name: EXPLORER, token: "t", agent: { id: "orphan", session: { header: { parentSession: void 0 } } } };
	assert.equal(rootSessionKey(orphan), "orphan");
	assert.equal(rootSessionKey({ name: EXPLORER, token: "t" }), "unknown");
});

// ── P2: budgets from environment ───────────────────────────────────────────

test("readBudgetsFromEnv parses and validates the override JSON", () => {
	const before = process.env[BUDGETS_ENV];
	try {
		delete process.env[BUDGETS_ENV];
		assert.deepEqual(readBudgetsFromEnv(), {});
		process.env[BUDGETS_ENV] = JSON.stringify({ maxDelegationsPerTask: 20, maxConsecutiveFailures: 5 });
		assert.deepEqual(readBudgetsFromEnv(), { maxDelegationsPerTask: 20, maxConsecutiveFailures: 5 });
		// invalid entries are ignored; malformed JSON yields nothing
		process.env[BUDGETS_ENV] = JSON.stringify({ maxDelegationsPerTask: -1, bogus: 3 });
		assert.deepEqual(readBudgetsFromEnv(), {});
		process.env[BUDGETS_ENV] = "{not json";
		assert.deepEqual(readBudgetsFromEnv(), {});
	} finally {
		if (before === void 0) delete process.env[BUDGETS_ENV];
		else process.env[BUDGETS_ENV] = before;
	}
});

test("broker honors env-style budget overrides passed to createBroker", () => {
	const broker = createBroker({ maxDelegationsPerTask: 1 });
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nA" });
	assert.equal(broker.gate(e).ok, true);
	broker.markDispatched(e);
	broker.settle(e, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.", isError: false });
	assert.equal(broker.gate(exec(EXPLORER, "t2", { prompt: "TASK_ID: t1\nB" })).ok, false);
	assert.match(broker.report("session-A"), /1 delegations\/task/);
});

// ── P1: persistence / crash recovery ───────────────────────────────────────

test("settled attempts persist artifacts and state; a fresh broker reloads them", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	const broker = createBroker({}, store);

	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, {
		text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: fixed.\nCHANGES:\n  src/a.js: x\nVERIFICATION:\n  npm test: 42 passed",
		isError: false
	});
	assert.equal(store.listArtifacts("session-A").length, 1, "artifact must be written");

	// Simulate a process restart: a NEW broker over the SAME store.
	const reloaded = createBroker({}, store);
	// The reloaded broker sees the persisted budget usage and results.
	const second = exec(FIXER, "t2", { prompt: "TASK_ID: t1\nFix more." });
	const gate = reloaded.gate(second);
	assert.equal(gate.ok, true, "budget not exhausted yet");
	const snap = reloaded.snapshot("session-A");
	assert.equal(snap.tasks[0].delegationsUsed, 1, "persisted delegation count must reload");
	assert.equal(snap.tasks[0].results[0].status, "SUCCESS");
	assert.equal(snap.tasks[0].results[0].receipts[0].command, "npm test");
});

test("persisted consecutive failures hard-stop a restarted task", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	const broker = createBroker({ maxConsecutiveFailures: 2 }, store);
	const mk = (token, text) => {
		const e = exec(EXPLORER, token, { prompt: "TASK_ID: t1\nA" });
		broker.gate(e);
		broker.markDispatched(e);
		broker.settle(e, { text, isError: false });
	};
	mk("f1", "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: nope.");
	mk("f2", "TASK_ID: t1\nSTATUS: PARTIAL\nSUMMARY: partly.");

	const reloaded = createBroker({ maxConsecutiveFailures: 2 }, store);
	const gate = reloaded.gate(exec(EXPLORER, "t3", { prompt: "TASK_ID: t1\nC" }));
	assert.equal(gate.ok, false);
	assert.match(gate.reason, /consecutive non-SUCCESS/);
});

test("report and snapshot load persisted state without a prior gate", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	const broker = createBroker({}, store);
	const e = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(e);
	broker.markDispatched(e);
	broker.settle(e, {
		text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: fixed.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test [risk=R1,exit=0,counts=3]: 3 passed",
		isError: false
	});

	const reloaded = createBroker({}, store);
	const report = reloaded.report("session-A");
	assert.match(report, /task "t1"/, report);
	assert.match(report, /npm test/, report);
	assert.match(report, /exit=0, success/, report);
	const snap = reloaded.snapshot("session-A");
	assert.equal(snap.tasks[0].delegationsUsed, 1);
});

test("report supports taskId filtering and artifact listing", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	const broker = createBroker({}, store);
	roundTrip(broker, exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nA" }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	roundTrip(broker, exec(EXPLORER, "t2", { prompt: "TASK_ID: t2\nB" }), { text: "TASK_ID: t2\nSTATUS: SUCCESS\nSUMMARY: found." });

	const focused = broker.report("session-A", { taskId: "t2" });
	assert.ok(focused.includes('task "t2"'));
	assert.ok(!focused.includes('task "t1"'), "task filter must exclude other tasks");

	const withArtifacts = broker.report("session-A", { taskId: "t1", includeArtifacts: true });
	assert.match(withArtifacts, /artifacts \(1\)/);
	assert.match(withArtifacts, /t1\/000-subagent_explorer/);
});

// ── P1: receipt annotation schema (pytest layering) ────────────────────────

test("parseReceiptLine handles plain and annotated receipt lines", () => {
	assert.deepEqual(parseReceiptLine("npm test: 42 passed"), { command: "npm test", result: "42 passed" });
	assert.deepEqual(
		parseReceiptLine("pytest tests/test_auth.py::test_login [risk=R1,exit=0,counts=1]: 1 passed (0.3s)"),
		{ command: "pytest tests/test_auth.py::test_login", result: "1 passed (0.3s)", risk: "R1", exit: 0, counts: 1 }
	);
	const failed = parseReceiptLine("pytest tests/test_auth.py [risk=R2,exit=1,counts=42,fail=tests/test_auth.py::test_logout]: 41 passed, 1 failed");
	assert.equal(failed.risk, "R2");
	assert.equal(failed.exit, 1);
	assert.deepEqual(failed.fail, ["tests/test_auth.py::test_logout"]);
	// section headers and non-command lines do not parse
	assert.equal(parseReceiptLine("STATUS: SUCCESS"), null);
	assert.equal(parseReceiptLine("all good here"), null);
	assert.equal(parseReceiptLine(""), null);
});

test("receiptSucceeded uses exit code first, then result text", () => {
	assert.equal(receiptSucceeded({ exit: 0, result: "1 failed" }), true, "exit=0 wins");
	assert.equal(receiptSucceeded({ exit: 1, result: "42 passed" }), false, "exit=1 fails");
	assert.equal(receiptSucceeded({ result: "42 passed" }), true);
	assert.equal(receiptSucceeded({ result: "2 failed, 3 error" }), false);
});

test("duplicate verification is detected when the workspace fingerprint is unchanged", () => {
	const broker = createBroker();
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, {
		text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: fixed.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test [risk=R1,exit=0,counts=42]: 42 passed",
		isError: false
	});
	const obs = exec("subagent_observer", "t2", { prompt: "TASK_ID: t1\nVerify." });
	broker.gate(obs);
	broker.markDispatched(obs);
	const outcome = broker.settle(obs, {
		text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: verified.\nOBSERVED:\n  npm test [risk=R1,exit=0,counts=42]: 42 passed",
		isError: false
	});
	assert.equal(outcome.decision.kind, "accept");
	const snap = broker.snapshot("session-A");
	const task = snap.tasks[0];
	assert.equal(task.duplicateReceipts, 1, "identical command at the same fingerprint must be flagged");
	const obsResult = task.results.at(-1);
	assert.ok(obsResult.warnings.some((w) => w.startsWith("duplicate verification")), obsResult.warnings.join(" | "));
	const obsReceipt = task.receipts.at(-1);
	assert.equal(obsReceipt.duplicate, true);
});

test("a changed workspace fingerprint does NOT flag a re-run as duplicate", () => {
	// Deterministic stand-in for "the workspace changed between runs":
	// when NO git fingerprint is available (non-repo cwd), the dedupe rule
	// must be conservative and flag nothing, never a false positive.
	const broker = createBroker();
	const cwd = "/nonexistent-dir-for-fingerprint";
	const fix = exec(FIXER, "t1", { cwd, prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test: 42 passed", isError: false });
	const obs = exec("subagent_observer", "t3", { cwd, prompt: "TASK_ID: t1\nVerify." });
	broker.gate(obs);
	broker.markDispatched(obs);
	broker.settle(obs, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: verified.\nOBSERVED:\n  npm test: 42 passed", isError: false });
	const task = broker.snapshot("session-A").tasks[0];
	assert.equal(task.duplicateReceipts, 0, "without a fingerprint the rule must not guess");
	assert.equal(task.workspaceFingerprint, null);
});

test("receipt budget warns when a task reports more commands than allowed", () => {
	const broker = createBroker({ maxReceiptsPerTask: 1 });
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	broker.settle(fix, {
		text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test: 42 passed\n  pytest tests/unit: 17 passed\n  npm run lint: clean",
		isError: false
	});
	const result = broker.snapshot("session-A").tasks[0].results[0];
	assert.ok(result.warnings.some((w) => w.includes("receipt budget exceeded")), result.warnings.join(" | "));
});

// ── completion gate: derived task states ───────────────────────────────────

test("deriveTaskState walks PLANNED → RUNNING → IMPLEMENTED → VERIFIED → COMPLETE", () => {
	const mk = () => ({ taskId: "t1", results: [], receipts: [], attempts: new Map(), consecutiveFailures: 0, delegationsUsed: 0, workspaceFingerprint: null, duplicateReceipts: 0 });
	const t = mk();
	assert.equal(deriveTaskState(t), "PLANNED");
	t.results.push({ tool: EXPLORER, status: "SUCCESS" });
	assert.equal(deriveTaskState(t), "RUNNING");
	t.results.push({ tool: FIXER_DELEGATION, status: "SUCCESS" });
	assert.equal(deriveTaskState(t), "IMPLEMENTED");
	t.results.push({ tool: "subagent_observer", status: "SUCCESS" });
	assert.equal(deriveTaskState(t), "COMPLETE");
});

test("deriveTaskState requires a passed Oracle review when Oracle was consulted", () => {
	const mk = () => ({ taskId: "t1", results: [
		{ tool: FIXER_DELEGATION, status: "SUCCESS" },
		{ tool: "subagent_observer", status: "SUCCESS" }
	], receipts: [], attempts: new Map(), consecutiveFailures: 0, delegationsUsed: 0, workspaceFingerprint: null, duplicateReceipts: 0 });
	const t = mk();
	t.results.push({ tool: "subagent_oracle", status: "PARTIAL" });
	assert.equal(deriveTaskState(t), "VERIFIED", "review pending → verified but not complete");
	t.results.push({ tool: "subagent_oracle", status: "SUCCESS" });
	assert.equal(deriveTaskState(t), "COMPLETE", "review passed → complete");
});

test("deriveTaskState requires the Oracle review to come after implementation", () => {
	const mk = () => ({ taskId: "t1", results: [
		{ tool: "subagent_oracle", status: "SUCCESS" },
		{ tool: FIXER_DELEGATION, status: "SUCCESS" },
		{ tool: "subagent_observer", status: "SUCCESS" }
	], receipts: [], attempts: new Map(), consecutiveFailures: 0, delegationsUsed: 0, workspaceFingerprint: null, duplicateReceipts: 0 });
	const t = mk();
	assert.equal(deriveTaskState(t), "VERIFIED", "a pre-fix Oracle consultation is not a post-change review");
	t.results.push({ tool: "subagent_oracle", status: "SUCCESS" });
	assert.equal(deriveTaskState(t), "COMPLETE", "a later Oracle SUCCESS closes the review loop");
});

test("an Oracle BLOCKED review blocks the task and the gate denies further delegations", () => {
	const broker = createBroker();
	const mk = (tool, token, prompt) => exec(tool, token, { prompt });
	const settle = (e, text) => {
		broker.gate(e);
		broker.markDispatched(e);
		return broker.settle(e, { text, isError: false });
	};
	settle(mk(FIXER_DELEGATION, "f1", "TASK_ID: t1\nFix."), "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test: pass");
	settle(mk("subagent_observer", "o1", "TASK_ID: t1\nVerify."), "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nOBSERVED:\n  npm test: pass");
	settle(mk("subagent_oracle", "r1", "TASK_ID: t1\nReview."), "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: design is unsafe.");

	assert.equal(broker.snapshot("session-A").tasks[0].state, "BLOCKED");
	// EVERY further delegation on this task id is denied with the review reason.
	const denied = broker.gate(mk(EXPLORER, "x1", "TASK_ID: t1\nInvestigate more."));
	assert.equal(denied.ok, false);
	assert.equal(denied.kind, "review");
	assert.match(denied.reason, /review blocked/);
	// A NEW task id is unaffected.
	assert.equal(broker.gate(mk(EXPLORER, "x2", "TASK_ID: t2\nNew problem.")).ok, true);
});

test("report shows the derived state and completion hints", () => {
	const broker = createBroker();
	roundTrip(broker, exec(FIXER_DELEGATION, "f1", { prompt: "TASK_ID: t1\nFix." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  npm test: pass" });
	roundTrip(broker, exec("subagent_observer", "o1", { prompt: "TASK_ID: t1\nVerify." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nOBSERVED:\n  npm test: pass" });
	const report = broker.report("session-A");
	assert.match(report, /\[COMPLETE\]/);
	assert.match(report, /reporting completion is now allowed/);
	assert.match(report, /2\/12 receipts/);
});
