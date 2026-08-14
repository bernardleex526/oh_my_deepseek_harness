/**
 * Delegation tests: the six specialist tools and the control-plane boundary.
 *
 * Covers §20/§22 (harness-native delegation through the host subagent seam),
 * §25 (role-collapse prevention) and §26 Test 10/11: the Orchestrator may
 * spawn specialists; specialists must not spawn anyone.
 *
 * The `orchestration.mjs` row is the interesting piece: it must restrict the
 * ROOT agent only, never children. We drive its listener with fake agents.
 *
 * @module multi-agent-orchestrator/tests/delegation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIALISTS } from "../src/agents/catalog.js";
import { ORCHESTRATOR_ALLOW, SUBAGENT_TOOLS } from "../src/permissions/agent-permissions.js";
import { apply, name } from "../src/orchestration/orchestration.mjs";

test("catalog defines exactly the six specialists with spawn semantics", () => {
	assert.equal(SPECIALISTS.length, 6);
	for (const specialist of SPECIALISTS) {
		assert.equal(specialist.provider, "spawn", `${specialist.id} must use the spawn provider`);
		assert.equal(specialist.maxDepth, 1, `${specialist.id} must cap delegation depth at 1`);
		assert.equal(specialist.enableRunInBackground, false, `${specialist.id} must be foreground`);
		assert.equal(specialist.backgroundMode, "one-shot", `${specialist.id} must be one-shot`);
		assert.ok(specialist.toolName.startsWith("subagent_"), specialist.toolName);
	}
});

test("specialist tool names are unique and match their ids", () => {
	const names = SPECIALISTS.map((s) => s.toolName);
	assert.equal(new Set(names).size, 6);
	for (const specialist of SPECIALISTS) {
		assert.ok(names.includes(`subagent_${specialist.id}`));
	}
});

test("maxDepth 1 means a specialist can never spawn another agent", () => {
	// The harness computes childDepth = parentDepth + 1 and rejects when it
	// exceeds maxDepth. Root (0) → specialist (1) is legal; specialist (1) →
	// any child (2) exceeds every tool's maxDepth of 1.
	for (const specialist of SPECIALISTS) {
		assert.ok(specialist.maxDepth >= 1, "root may spawn this specialist");
		assert.ok(specialist.maxDepth < 2, "this specialist may not spawn anyone");
	}
});

test("orchestration.mjs is a dependency-free preset row", () => {
	assert.equal(name, "orchestration");
	assert.equal(typeof apply, "function");
	// The row must not import anything from the harness — it is loaded from
	// the preset directory where no node_modules exists. Enforce by checking
	// its source contains no import/require statements.
	const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "orchestration", "orchestration.mjs"), "utf8");
	assert.ok(!/^\s*(import|export\s+\{[^}]*\}\s+from|require\()/m.test(source), "orchestration.mjs must be import-free");
});

test("orchestration row restricts only the ROOT agent (not children)", async () => {
	const restricted = [];
	const tools = {
		restrict(filter) {
			restricted.push(filter);
		}
	};
	const listeners = {};
	const ctx = {
		on(event, handler) {
			listeners[event] = handler;
		}
	};
	apply(ctx);

	const rootAgent = {
		session: { header: { parentSession: void 0 } },
		ctx: { get: () => tools }
	};
	const childAgent = {
		session: { header: { parentSession: "session-parent" } },
		ctx: { get: () => tools }
	};

	assert.equal(typeof listeners["agent/created"], "function");
	listeners["agent/created"]({ agent: childAgent });
	listeners["agent/created"]({ agent: rootAgent });

	assert.equal(restricted.length, 1, "only the root agent must be restricted");
	assert.deepEqual(restricted[0].allow.sort(), [...ORCHESTRATOR_ALLOW].sort());
});

test("orchestrator boundary includes every delegation tool", () => {
	for (const tool of SUBAGENT_TOOLS) assert.ok(ORCHESTRATOR_ALLOW.includes(tool));
});

test("specialist surfaces never include delegation tools (runtime guard double-check)", () => {
	// Even if a specialist somehow obtained a subagent tool, maxDepth 1 blocks
	// the spawn; the filter makes the tool invisible in the first place.
	for (const specialist of SPECIALISTS) {
		const allow = specialist.filterFor("posix").allow;
		assert.ok(!SUBAGENT_TOOLS.some((t) => allow.includes(t)), `${specialist.id} must not see delegation tools`);
	}
});
