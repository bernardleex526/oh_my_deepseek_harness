/**
 * Bootstrap smoke test: spawns the real harness smoke in the BOOTSTRAP variant
 * (separate process — the preset row reads the env at apply time, and the
 * orchestration module is cached per process) and asserts the fresh root agent
 * sees exactly the control-plane set on its first request.
 *
 * @module multi-agent-orchestrator/tests/bootstrap-smoke
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("real harness: anchored bootstrap shows only the control-plane set on request #1", () => {
	const env = {
		...process.env,
		SMOKE_BOOTSTRAP: "1",
		DSH_CHECKOUT: process.env.DSH_CHECKOUT ?? join(ROOT, "node_modules", "@deepseek-ai")
	};
	const result = spawnSync(process.execPath, [join(ROOT, "scripts", "smoke-mount.mjs")], {
		env,
		encoding: "utf8",
		timeout: 120000
	});
	assert.equal(result.status, 0, `bootstrap smoke failed:\n${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /smoke-mount \(bootstrap\) OK/, result.stdout);
	assert.match(result.stdout, /8 tools visible on the FIRST request/, result.stdout);
	assert.match(result.stdout, /delegation tools hidden until promotion: verified/, result.stdout);
});
