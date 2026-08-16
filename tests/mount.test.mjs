/**
 * Real-mount integration test: boots the actual harness stack (base bundle +
 * agent-presets) and mounts the generated preset on a real agent scope.
 *
 * This is the strongest compatibility proof short of a live model request:
 * the composition goes through the real loader, every row activates, the
 * Orchestrator boundary is enforced by `tools.restrict()`, and every
 * specialist toolFilter passes the child-setup name validation.
 *
 * The test FAILS (rather than skips) when the DSH checkout is unavailable:
 * deep package checks are essential. Run `npm install` (installs @deepseek-ai/*
 * under node_modules/@deepseek-ai) and/or set DSH_CHECKOUT.
 *
 * @module multi-agent-orchestrator/tests/mount
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeMount } from "../scripts/smoke-mount.mjs";
import { SUBAGENT_TOOLS } from "../src/permissions/agent-permissions.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CHECKOUT = join(resolve(ROOT), "node_modules", "@deepseek-ai");
const CHECKOUT = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT;

test("real harness boot mounts the preset and enforces every boundary", async () => {
	assert.ok(
		existsSync(join(CHECKOUT, "dsh-base")),
		`DSH checkout unavailable at "${CHECKOUT}" — run \`npm install\` (installs @deepseek-ai/* under node_modules/@deepseek-ai), or set DSH_CHECKOUT`
	);
	const result = await smokeMount();
	assert.equal(result.presetBroken, void 0, "preset must pass the harness health check");
	for (const tool of SUBAGENT_TOOLS) {
		assert.ok(result.toolNames.includes(tool), `orchestrator must see ${tool}`);
	}
	assert.ok(result.toolNames.includes("broker_status"), "orchestrator must see broker_status");
	assert.ok(result.restrictionApplied, "orchestrator must be restricted (no write/edit/shell)");
	assert.ok(result.childFilterNames > 0, "specialist filters must validate against the live registry");
	// Real-chain probes: the broker chain (gate → execute → post-execute)
	// must work on the actual tool pipeline, not just in unit tests.
	assert.equal(result.probes.gateDenied, true, "concurrent fixer must be denied by the real single-writer gate");
	assert.equal(result.probes.envelopeBlocked, true, "malformed envelope must be blocked by the real post-execute gate");
	assert.notEqual(result.probes.askSerialized, false, "the writer lock must be held through an ask approval (or the probe skipped)");
});
