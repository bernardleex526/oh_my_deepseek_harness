/**
 * Orchestration status CLI (P2): render the persisted broker state for one
 * session (or list sessions) from the ArtifactStore.
 *
 * The runtime only persists when `$DSH_ORCHESTRATION_HOME` is set (or the
 * store root is passed with --home). Snapshots live at
 * `<root>/state/<session>.json`, raw artifacts at
 * `<root>/artifacts/<session>/<taskId>/…`.
 *
 * Usage:
 *   node scripts/orchestration-status.mjs                 # list sessions
 *   node scripts/orchestration-status.mjs <sessionId>     # one session
 *   node scripts/orchestration-status.mjs <sessionId> --home <path>
 *
 * @module multi-agent-orchestrator/scripts/orchestration-status
 */

import { join } from "node:path";
import { cliStoreRoot, createArtifactStore } from "../src/orchestration/artifacts.mjs";
import { deriveTaskState } from "../src/orchestration/broker.mjs";

const args = process.argv.slice(2);
const homeIdx = args.indexOf("--home");
const home = homeIdx >= 0 && args[homeIdx + 1] !== void 0 ? args[homeIdx + 1] : cliStoreRoot();
const sessionId = args.find((a) => !a.startsWith("--") && a !== home && a !== "--home");

const store = createArtifactStore(home);
if (!store.enabled) {
	console.error(`status: store root "${home}" does not exist or persistence is disabled — set $DSH_ORCHESTRATION_HOME (or pass --home) before running the harness.`);
	process.exit(1);
}
store.ensureRoot();

if (sessionId === void 0) {
	const sessions = store.listSessions();
	console.log(`sessions (${sessions.length}) under ${store.root}:`);
	for (const s of sessions) {
		const artifacts = store.listArtifacts(s);
		const state = store.readSessionState(s);
		const tasks = state?.tasks?.length ?? 0;
		const last = state?.savedAt ? new Date(state.savedAt).toISOString() : "?";
		console.log(`  ${s} — ${tasks} task(s), ${artifacts.length} artifact(s), last saved ${last}`);
	}
	process.exit(0);
}

const state = store.readSessionState(sessionId);
if (state === null) {
	console.error(`status: no persisted state for session "${sessionId}" under ${store.root}`);
	process.exit(1);
}
console.log(`session ${sessionId} (saved ${new Date(state.savedAt ?? 0).toISOString()}):`);
for (const task of state.tasks ?? []) {
	const derived = deriveTaskState(task);
	console.log(`\ntask "${task.taskId}" [${derived}]: ${task.delegationsUsed} delegations, ${task.consecutiveFailures} consecutive failures, ${(task.receipts ?? []).length} receipts, ${task.duplicateReceipts ?? 0} duplicate verification(s)`);
	for (const [tool, count] of Object.entries(task.attempts ?? {})) {
		console.log(`  ${tool}: ${count} attempt(s)`);
	}
	for (const r of task.results ?? []) {
		const receipts = (r.receipts ?? []).map((x) => x.command).join(" | ");
		console.log(`  #${r.callIndex} ${r.tool}: ${r.status}${r.summary ? ` — ${String(r.summary).slice(0, 80)}` : ""}${receipts ? `\n    receipts: ${receipts}` : ""}`);
		if (r.fingerprint) console.log(`    fingerprint: before=${r.fingerprint.before ?? "n/a"} after=${r.fingerprint.after ?? "n/a"}`);
	}
}
const artifacts = store.listArtifacts(sessionId);
if (artifacts.length > 0) {
	console.log(`\nartifacts (${artifacts.length}):`);
	for (const a of artifacts) console.log(`  ${a.taskId}/${String(a.callIndex).padStart(3, "0")}-${a.tool}.txt — ${a.size} bytes`);
}
