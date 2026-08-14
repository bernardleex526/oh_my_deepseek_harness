/**
 * Real-mount integration test: boots the actual harness stack (base bundle +
 * agent-presets) and mounts the generated preset on a real agent scope.
 *
 * This is the strongest compatibility proof short of a live model request:
 * the composition goes through the real loader, every row activates, the
 * Orchestrator boundary is enforced by `tools.restrict()`, and every
 * specialist toolFilter passes the child-setup name validation.
 *
 * Skips cleanly when the DSH checkout is unavailable.
 *
 * @module multi-agent-orchestrator/tests/mount
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeMount } from "../scripts/smoke-mount.mjs";
import { SUBAGENT_TOOLS } from "../src/permissions/agent-permissions.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECKOUT = process.env.DSH_CHECKOUT ?? "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai";

test("real harness boot mounts the preset and enforces every boundary", { skip: !existsSync(join(CHECKOUT, "dsh-base")) }, async () => {
	const result = await smokeMount();
	assert.equal(result.presetBroken, void 0, "preset must pass the harness health check");
	for (const tool of SUBAGENT_TOOLS) {
		assert.ok(result.toolNames.includes(tool), `orchestrator must see ${tool}`);
	}
	assert.ok(result.restrictionApplied, "orchestrator must be restricted (no write/edit/shell)");
	assert.ok(result.childFilterNames > 0, "specialist filters must validate against the live registry");
});
