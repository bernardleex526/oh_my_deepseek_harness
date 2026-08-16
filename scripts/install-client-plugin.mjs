/**
 * Install the trajectory-counter CLIENT plugin into a DSH deployment.
 *
 * The host's client-module scanner only sees packages that are LOADER
 * ENTRIES and that declare `dsh.client`. This script performs the mechanical
 * half — build the bundle and copy the package next to the deployment's own
 * packages — and prints the remaining manual step (register the plugin entry
 * in the deployment, then restart the harness).
 *
 * Usage:
 *   node scripts/install-client-plugin.mjs [--checkout <path-to-@deepseek-ai>]
 *
 * The deployment is located via (highest precedence first):
 *   - `--checkout <path>` / `$DSH_CHECKOUT` (the deployment's
 *     node_modules/@deepseek-ai directory);
 *   - otherwise the node_modules that contains `@deepseek-ai/dsh`.
 *
 * @module dsh-trajectory-counter/scripts/install-client-plugin
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./build-client.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_DIR = join(ROOT, "client", "trajectory-counter");
const PKG = JSON.parse(await (await import("node:fs/promises")).readFile(join(PKG_DIR, "package.json"), "utf8"));

/** Resolve the deployment's node_modules root. */
export function resolveDeploymentNodeModules({ checkout } = {}) {
	if (checkout !== void 0) return dirname(resolve(checkout));
	const fromEnv = process.env.DSH_CHECKOUT;
	if (fromEnv !== void 0 && fromEnv.trim() !== "") return dirname(resolve(fromEnv));
	try {
		const require = createRequire(import.meta.url);
		const dshEntry = require.resolve("@deepseek-ai/dsh/package.json");
		return dirname(dirname(dirname(dshEntry))); // .../node_modules/@deepseek-ai/dsh → .../node_modules
	} catch {
		throw new Error("install-client-plugin: cannot locate the DSH deployment (pass --checkout <node_modules/@deepseek-ai>)");
	}
}

/** Install (copy, replace semantics) the package into a deployment. */
export function installClientPlugin({ nodeModules } = {}) {
	const targetRoot = nodeModules ?? resolveDeploymentNodeModules();
	const target = join(targetRoot, PKG.name);
	if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const part of ["package.json", "lib", "client"]) {
		cpSync(join(PKG_DIR, part), join(target, part), { recursive: true });
	}
	return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const checkoutIdx = args.indexOf("--checkout");
	const checkout = checkoutIdx >= 0 && args[checkoutIdx + 1] !== void 0 ? args[checkoutIdx + 1] : void 0;
	try {
		buildClient();
		const target = installClientPlugin({ nodeModules: checkout !== void 0 ? dirname(resolve(checkout)) : void 0 });
		console.log(`trajectory-counter client plugin installed → ${target}`);
		console.log("");
		console.log("Next steps (the host only serves LOADER ENTRIES that declare dsh.client):");
		console.log(`  1. register a plugin entry for "${PKG.name}" in the deployment (e.g. via the deployment's plugin management / \`dsh plugin\`), or add a row to the launch config;`);
		console.log("  2. restart DeepSeek Harness and open a session;");
		console.log(`  3. verify the boot manifest now serves /plugins/${PKG.name}/client.js, and that the`);
		console.log('     "We need… / Let me…" chips appear in the composer dock next to the stats line.');
	} catch (error) {
		console.error(`install-client-plugin: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
