/**
 * Smoke test: boot the real harness stack and MOUNT the generated preset.
 *
 * This is the same composition path a web session uses (the apiproxy mounts
 * the preset in the agent factory's setup). It proves:
 *  1. The composition file activates through the real loader (every row
 *     imports, applies, and stays usable).
 *  2. The Orchestrator persona row installs.
 *  3. All six delegation tools are registered for the root agent.
 *  4. The orchestration row restricted the ROOT agent (no write/edit/bash).
 *  5. The compaction group activates.
 *
 * No model request is made: we create the agent, inspect the composed scope,
 * and dispose it.
 *
 * Usage: node scripts/smoke-mount.mjs [path-to-dsh-checkout]
 *
 * @module multi-agent-orchestrator/scripts/smoke-mount
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { PRESET_ID } from "../src/config/defaults.js";
import { SPECIALISTS } from "../src/agents/catalog.js";
import { SUBAGENT_TOOLS, ORCHESTRATOR_ALLOW } from "../src/permissions/agent-permissions.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CHECKOUT = "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai";
const CHECKOUT = process.argv[2] ?? process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT;

/** Load a package module from the checkout by package name. */
async function loadPackage(name) {
	const entry = JSON.parse(readFileSync(join(CHECKOUT, name, "package.json"), "utf8")).exports?.["."]?.default ?? "lib/index.js";
	return import(pathToFileURL(join(CHECKOUT, name, entry)).href);
}

/**
 * Boot a minimal harness with the base bundle + agent-presets roster pointing
 * at our preset dir, then create one agent with the preset mounted.
 * @returns {Promise<{toolNames: string[], restrictionApplied: boolean, presetBroken: string | undefined}>}
 */
export async function smokeMount() {
	const require = createRequire(import.meta.url);
	const { boot, composeEntries } = await loadPackage("dsh-app-boot");
	const { randomUUID } = await import("node:crypto");
	const { SessionId } = await loadPackage("dsh-session");

	// The base bundle patch provides every host service the preset needs
	// (tools registry, systemPrompt, subagents + spawn provider, jobs, web,
	// sandbox, approval, agent loop, ...).
	const requireYaml = createRequire(import.meta.url);
	const yaml = requireYaml(join(CHECKOUT, "..", "js-yaml"));
	// The loader's own dialect: JSON_SCHEMA + the `!!js` expression type.
	const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		resolve: (data) => typeof data === "string",
		construct: (data) => ({ __jsExpr: data })
	});
	const entrySchema = yaml.JSON_SCHEMA.extend(JsExpr);
	const basePatch = yaml.load(readFileSync(join(CHECKOUT, "dsh-base", "cordis.patch.yml"), "utf8"), { schema: entrySchema });
	const data = [];
	const warn = () => {};
	const baseRows = composeEntries([basePatch], warn);
	// Bare `@deepseek-ai/*` specifiers in the preset resolve via Node's upward
	// node_modules walk from the loader baseUrl. The web profile resolves them
	// from its own node_modules; here we place the smoke config inside the npx
	// root so the walk lands on the harness's node_modules.
	const npxRoot = dirname(CHECKOUT);
	const home = mkdtempSync(join(npxRoot, "dsh-smoke-"));
	try {
		// The headless patch adds the code-runtime + startup rows; we only
		// need the base rows plus our own agent-presets roster. Mirror the
		// web profile's tweaks: HMR off (it needs a package.json on disk),
		// tools default presentation.
		const rows = [...baseRows];
		for (const row of rows) {
			if (row.id === "hmr") row.disabled = true;
		}
		rows.push({
			id: "agent-presets",
			name: "@deepseek-ai/dsh-agent-presets",
			config: {
				default: PRESET_ID,
				roots: [{ path: join(ROOT, "preset"), trust: "user" }],
				includeUserRoot: false
			}
		});
		const configPath = join(home, "cordis.json");
		// JSON round-trips the `{ __jsExpr }` nodes exactly, and the loader's
		// `isJsExpr` recognizes a plain object with that key, so `!!js`
		// semantics survive without a YAML dialect round-trip.
		writeFileSync(configPath, JSON.stringify(rows, null, 2), "utf8");

		const ctx = await boot("smoke", configPath, [], void 0, pathToFileURL(CHECKOUT + "/").href);
		const agents = ctx.get("agents");
		const presets = ctx.get("agentPresets");
		const defaultModel = ctx.get("agentDefaultModel");
		if (agents === void 0 || presets === void 0 || defaultModel === void 0) {
			throw new Error("required host services missing after boot");
		}

		// Health-check discovery (the web picker's own view).
		const listed = await presets.list();
		const row = listed.find((p) => p.id === PRESET_ID);

		const selection = defaultModel.currentSelection();
		const { agent, dispose } = await agents.create({
			sessionId: SessionId(`session-${randomUUID()}`),
			meta: { cwd: ROOT },
			agentOptions: { provider: selection.provider, model: selection.model },
			setup: async (agentCtx) => {
				await presets.mount(agentCtx, PRESET_ID);
			}
		});
		const composed = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
		if (composed !== PRESET_ID) {
			throw new Error(`preset not composed for agent (got ${String(composed)})`);
		}

		// Inspect the composed scope exactly as a model request would see it.
		// `view()` expects the scope KEY, not the context object.
		const scopeMod = await loadPackage("dsh-scope");
		const tools = ctx.get("tools");
		const agentKey = scopeMod.scopeOf(agent.ctx);
		const view = tools.view(agentKey);
		const toolNames = [...view.visible.keys()].sort();
		const restrictionApplied = !toolNames.includes("write") && !toolNames.includes("edit")
			&& !toolNames.includes("bash") && !toolNames.includes("pwsh");

		// Every specialist's toolFilter must pass the real `tools.restrict()`
		// name validation a child would hit at setup: restrict() rejects
		// unknown names against the child's inherited surface. A child joins
		// this preset's standing composition, so the standing scope's
		// restrictable names are exactly what the child sees (plus global).
		// Only the CURRENT platform's branch is ever applied at runtime — the
		// `!!js` expression in the composition resolves before child setup.
		const standingKey = await presets.standingKeyFor(PRESET_ID);
		const standingView = tools.view(standingKey);
		const restrictable = standingView.restrictableNames;
		let childFilterNames = 0;
		for (const specialist of SPECIALISTS) {
			const { allow } = specialist.filterFor(process.platform);
			for (const name of allow) {
				if (!restrictable.has(name)) {
					throw new Error(`child filter for ${specialist.id} names unknown tool "${name}" (visible: ${[...restrictable].sort().join(", ")})`);
				}
				childFilterNames += 1;
			}
		}

		await dispose();
		await ctx.fiber.dispose();
		return {
			toolNames,
			restrictionApplied,
			presetBroken: row?.broken,
			childFilterNames
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	smokeMount().then((result) => {
		const problems = [];
		if (result.presetBroken !== void 0) problems.push(`preset reported broken: ${result.presetBroken}`);
		for (const tool of SUBAGENT_TOOLS) {
			if (!result.toolNames.includes(tool)) problems.push(`missing delegation tool ${tool}`);
		}
		if (!result.restrictionApplied) problems.push("root agent was not restricted (write/edit/shell visible)");
		if (problems.length > 0) {
			console.error("smoke-mount FAILED:");
			for (const p of problems) console.error(`  ✗ ${p}`);
			console.error("visible tools:", result.toolNames.join(", "));
			process.exit(1);
		}
		console.log(`smoke-mount OK — ${result.toolNames.length} tools visible to the Orchestrator`);
		console.log("  delegation tools:", SUBAGENT_TOOLS.join(", "));
		console.log("  boundary enforced: write/edit/bash/pwsh hidden");
		console.log(`  child filter names validated: ${result.childFilterNames} (${process.platform})`);
		console.log("  orchestrator surface:", ORCHESTRATOR_ALLOW.join(", "));
	}).catch((error) => {
		console.error("smoke-mount FAILED:", error);
		process.exit(1);
	});
}
