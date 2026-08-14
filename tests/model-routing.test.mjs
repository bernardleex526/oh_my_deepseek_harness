/**
 * Per-specialist model-routing tests: different agents can use different
 * providers/models via `model-routing.json`, merged into each delegation
 * tool's `agentOptions` (which the harness applies at spawn time).
 *
 * @module multi-agent-orchestrator/tests/model-routing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRouting, MODEL_ROUTING_FILE } from "../src/config/model-routing.js";
import { assertAgentOptions } from "../src/agents/catalog.js";
import { renderComposition } from "../scripts/build.mjs";

/** Create a temp project root with an optional model-routing.json. */
function tempRoot(routing) {
	const dir = mkdtempSync(join(tmpdir(), "mao-routing-"));
	if (routing !== void 0) writeFileSync(join(dir, MODEL_ROUTING_FILE), JSON.stringify(routing), "utf8");
	return dir;
}

test("absent model-routing.json yields no routes (inherit parent route)", () => {
	const root = tempRoot(void 0);
	try {
		assert.deepEqual(loadModelRouting(root), {});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("valid routes load per specialist", () => {
	const root = tempRoot({
		explorer: { provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 8000 },
		oracle: { provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 16000 }
	});
	try {
		const routes = loadModelRouting(root);
		assert.equal(routes.explorer.model, "deepseek-v4-flash");
		assert.equal(routes.oracle.maxTokens, 16000);
		assert.equal(routes.fixer, void 0, "unconfigured specialists stay inherited");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unknown specialist ids fail loudly", () => {
	const root = tempRoot({ wizard: { provider: "p", model: "m", maxTokens: 1 } });
	try {
		assert.throws(() => loadModelRouting(root), /unknown specialist "wizard"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("incomplete agentOptions fail loudly (all three fields required)", () => {
	for (const bad of [
		{ provider: "deepseek-official" },
		{ provider: "deepseek-official", model: "m" },
		{ provider: "deepseek-official", model: "m", maxTokens: 0 }
	]) {
		assert.throws(() => assertAgentOptions(bad, "test"), /agentOptions\./);
	}
	const root = tempRoot({ fixer: { provider: "deepseek-official", model: "m" } });
	try {
		assert.throws(() => loadModelRouting(root), /model-routing:fixer/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("composition renders agentOptions only when routes exist", async () => {
	const clean = tempRoot(void 0);
	try {
		const composition = renderComposition(clean);
		assert.ok(!composition.includes("agentOptions:"), "default build must not emit agentOptions");
		assert.ok(!composition.includes("maxTokens:"), "default build must not emit maxTokens");
	} finally {
		rmSync(clean, { recursive: true, force: true });
	}
	const routed = tempRoot({
		explorer: { provider: "opencode-go", model: "deepseek-v4-flash", maxTokens: 32768 }
	});
	try {
		const composition = renderComposition(routed);
		assert.ok(composition.includes("agentOptions:"), "routed build must emit agentOptions");
		assert.ok(composition.includes("model: deepseek-v4-flash"), "routed build must carry the route model");
		assert.ok(composition.includes("maxTokens: 32768"), "routed build must carry maxTokens");
	} finally {
		rmSync(routed, { recursive: true, force: true });
	}
});

test("model route rows pass the real harness schema", async () => {
	const { createRequire } = await import("node:module");
	const { pathToFileURL } = await import("node:url");
	const require = createRequire(import.meta.url);
	const checkout = process.env.DSH_CHECKOUT ?? "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai";
	const { existsSync } = await import("node:fs");
	if (!existsSync(join(checkout, "dsh-tool-subagent"))) return; // skip without checkout
	const toolSubagent = await import(pathToFileURL(join(checkout, "dsh-tool-subagent", "lib", "index.js")).href);
	const sample = {
		toolName: "subagent_oracle",
		provider: "spawn",
		maxDepth: 1,
		agentOptions: { provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 16000 }
	};
	const validated = toolSubagent.Config(sample);
	assert.equal(validated.agentOptions.model, "deepseek-v4-flash");
});
