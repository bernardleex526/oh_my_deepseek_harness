/**
 * Orchestration quality metrics CLI (P2): aggregate the persisted broker
 * state across sessions into per-specialist quality indicators.
 *
 * Metrics computed from the ArtifactStore snapshots:
 * - per-specialist outcome distribution (SUCCESS / PARTIAL / BLOCKED /
 *   NOT_APPLICABLE / ERROR / PROTOCOL_ERROR) and success rate;
 * - average attempts per task and delegation distribution;
 * - total tasks, total delegations, test receipts collected;
 * - envelope protocol-block rate (results the gate rejected).
 *
 * Usage:
 *   node scripts/orchestration-metrics.mjs [--home <path>]
 *
 * @module multi-agent-orchestrator/scripts/orchestration-metrics
 */

import { cliStoreRoot, createArtifactStore } from "../src/orchestration/artifacts.mjs";
import { deriveTaskState } from "../src/orchestration/broker.mjs";

const args = process.argv.slice(2);
const homeIdx = args.indexOf("--home");
const home = homeIdx >= 0 && args[homeIdx + 1] !== void 0 ? args[homeIdx + 1] : cliStoreRoot();

const store = createArtifactStore(home);
if (!store.enabled) {
	console.error(`metrics: store root "${home}" does not exist or persistence is disabled — set $DSH_ORCHESTRATION_HOME (or pass --home) before running the harness.`);
	process.exit(1);
}

const sessions = store.listSessions();
if (sessions.length === 0) {
	console.log("metrics: no persisted sessions found.");
	process.exit(0);
}

const STATUSES = ["SUCCESS", "PARTIAL", "BLOCKED", "NOT_APPLICABLE", "ERROR", "PROTOCOL_ERROR"];
const STATES = ["PLANNED", "RUNNING", "IMPLEMENTED", "VERIFIED", "COMPLETE", "BLOCKED"];
const byTool = new Map(); // tool -> { status: Map, total }
const tiers = new Map(); // R0..R3 -> { commands, passed }
let totalTasks = 0;
let totalDelegations = 0;
let totalReceipts = 0;
let duplicateReceipts = 0;
let protocolBlocks = 0;
let tasksWithFailures = 0;
const stateCounts = new Map(STATES.map((s) => [s, 0]));
const tasksPerSession = new Map();

function toolRow(tool) {
	if (!byTool.has(tool)) {
		byTool.set(tool, { status: new Map(), total: 0 });
	}
	return byTool.get(tool);
}

for (const session of sessions) {
	const state = store.readSessionState(session);
	if (state?.tasks === void 0) continue;
	for (const task of state.tasks) {
		totalTasks += 1;
		tasksPerSession.set(session, (tasksPerSession.get(session) ?? 0) + 1);
		stateCounts.set(deriveTaskState(task), (stateCounts.get(deriveTaskState(task)) ?? 0) + 1);
		duplicateReceipts += task.duplicateReceipts ?? 0;
		let failed = false;
		for (const r of task.results ?? []) {
			totalDelegations += 1;
			const row = toolRow(r.tool ?? "unknown");
			const status = STATUSES.includes(r.status) ? r.status : "OTHER";
			row.status.set(status, (row.status.get(status) ?? 0) + 1);
			row.total += 1;
			if (r.status !== "SUCCESS") failed = true;
			if (r.status === "PROTOCOL_ERROR") protocolBlocks += 1;
			for (const receipt of r.receipts ?? []) {
				totalReceipts += 1;
				const tier = receipt.risk ?? "R?";
				const entry = tiers.get(tier) ?? { commands: 0, passed: 0 };
				entry.commands += 1;
				if (receipt.exit === 0 || /pass|clean|ok|success/i.test(receipt.result)) entry.passed += 1;
				tiers.set(tier, entry);
			}
		}
		if (failed) tasksWithFailures += 1;
	}
}

console.log(`orchestration metrics (${sessions.length} session(s), ${totalTasks} task(s), ${totalDelegations} delegation(s)):`);
console.log(`  protocol blocks (envelope gate rejections): ${protocolBlocks}`);
console.log(`  test receipts collected: ${totalReceipts} (${duplicateReceipts} flagged duplicate verification)`);
console.log(`  tasks with at least one non-SUCCESS result: ${tasksWithFailures} (${totalTasks === 0 ? 0 : Math.round((tasksWithFailures / totalTasks) * 100)}%)`);
console.log(`  task states: ${STATES.map((s) => `${s}=${stateCounts.get(s) ?? 0}`).join(" ")}`);
if (tiers.size > 0) {
	console.log("\nreceipts by risk tier:");
	for (const [tier, entry] of [...tiers.entries()].sort()) {
		const pct = entry.commands === 0 ? 0 : Math.round((entry.passed / entry.commands) * 100);
		console.log(`  ${tier.padEnd(4)} ${String(entry.commands).padStart(4)} commands, ${entry.passed} passed (${pct}%)`);
	}
}
console.log("\nper-specialist outcomes:");
console.log(`  ${"tool".padEnd(24)} ${STATUSES.map((s) => s.padEnd(14)).join("")} success%`);
for (const [tool, row] of [...byTool.entries()].sort()) {
	const counts = STATUSES.map((s) => row.status.get(s) ?? 0);
	const success = row.status.get("SUCCESS") ?? 0;
	const pct = row.total === 0 ? 0 : Math.round((success / row.total) * 100);
	console.log(`  ${tool.padEnd(24)} ${counts.map((c) => String(c).padEnd(14)).join("")} ${pct}%`);
}
