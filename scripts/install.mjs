/**
 * Install the built mode into the user's agent-preset roster.
 *
 * Copies `preset/orchestrator/` into `$DSH_HOME/.agent-presets/orchestrator/`
 * (default home: `~/.dsh`). The web surface reads the roster live, so the new
 * mode appears in the preset picker without restarting the harness.
 *
 * Run: node scripts/install.mjs
 * Uninstall: delete `$DSH_HOME/.agent-presets/orchestrator/`.
 *
 * @module multi-agent-orchestrator/scripts/install
 */

import { cpSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESET_ID } from "../src/config/defaults.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "preset", PRESET_ID);

/** Resolve the DSH home: $DSH_HOME, else ~/.dsh. */
export function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (fromEnv !== void 0 && fromEnv.trim().length > 0) return resolve(fromEnv);
	return resolve(homedir(), ".dsh");
}

/**
 * Install the preset.
 * @param {object} [opts] - install options.
 * @param {boolean} [opts.force] - overwrite an existing installation.
 * @param {string} [opts.home] - DSH home override.
 * @returns {string} the installed directory.
 */
export function install({ force = false, home = resolveDshHome() } = {}) {
	if (!existsSync(SOURCE)) {
		throw new Error(`preset not built: ${SOURCE} (run: node scripts/build.mjs)`);
	}
	const target = join(home, ".agent-presets", PRESET_ID);
	if (existsSync(target) && readdirSync(target).length > 0 && !force) {
		throw new Error(`${target} already exists — pass force: true to overwrite`);
	}
	cpSync(SOURCE, target, { recursive: true, force });
	return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const force = process.argv.includes("--force");
	try {
		const target = install({ force });
		console.log(`installed "${PRESET_ID}" mode → ${target}`);
		console.log("Pick it in the web UI preset picker, or set it as the default in Settings → Agent preset.");
	} catch (error) {
		console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
