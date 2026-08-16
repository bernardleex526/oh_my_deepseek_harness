/**
 * ArtifactStore: durable persistence for the orchestration runtime.
 *
 * Every settled delegation attempt writes two artifacts under the store
 * root:
 *
 *   <root>/artifacts/<session>/<taskId>/<callIndex>-<tool>.json   parsed meta
 *   <root>/artifacts/<session>/<taskId>/<callIndex>-<tool>.txt    raw result text
 *
 * and the broker's per-session state (budgets, attempts, consecutive
 * failures, results) is snapshotted to:
 *
 *   <root>/state/<session>.json
 *
 * This gives the P1 audit items their mechanical base: full results survive
 * the harness's tool-result pruner, a restarted session can reload its
 * budgets/results (crash recovery / task replay), and the CLI tools
 * (`scripts/orchestration-status.mjs`, `scripts/orchestration-metrics.mjs`)
 * can render live state and historical quality metrics.
 *
 * The store is only node builtins (no node_modules needed in the preset
 * dir). Persistence is OPT-IN: the store root is resolved from
 * `$DSH_ORCHESTRATION_HOME` at construction time; without it the broker runs
 * purely in memory (the previous behavior).
 *
 * @module multi-agent-orchestrator/orchestration/artifacts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

/** Env var that turns persistence on and names the store root. */
export const STORE_ROOT_ENV = "DSH_ORCHESTRATION_HOME";

/** Default store root when the env var is absent but a DSH home exists. */
export function defaultStoreRoot() {
	const explicit = process.env[STORE_ROOT_ENV];
	if (explicit !== void 0 && explicit.trim() !== "") return explicit;
	const dshHome = process.env.DSH_HOME;
	if (dshHome !== void 0 && dshHome.trim() !== "") return join(dshHome, "orchestration");
	return join(homedir(), ".dsh", "orchestration");
}

/**
 * Resolve the store root. Returns null when persistence is not enabled
 * (only `$DSH_ORCHESTRATION_HOME` opts in — never the implicit home, so the
 * runtime never writes to disk behind the user's back).
 * @returns {string | null} the store root, or null when disabled.
 */
export function resolveStoreRoot() {
	const explicit = process.env[STORE_ROOT_ENV];
	if (explicit === void 0 || explicit.trim() === "") return null;
	return explicit;
}

/** A deterministic content hash (sha256 hex, 16 chars) for dedupe/replay. */
export function contentHash(text) {
	return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/**
 * Create one artifact store bound to a root directory.
 * @param {string} [root] - the store root (default: resolveStoreRoot()).
 * @returns {object} the store API; when `root` is null every call is a no-op
 *   returning null (persistence disabled).
 */
export function createArtifactStore(root = resolveStoreRoot()) {
	const enabled = root !== null && root !== void 0 && root !== "";

	function artifactDir(session) {
		return join(root, "artifacts", session);
	}

	function taskDir(session, taskId) {
		return join(artifactDir(session), taskId);
	}

	return {
		/** Whether this store actually persists. */
		enabled,
		root: enabled ? root : null,

		/**
		 * Write one delegation artifact (parsed meta + raw text).
		 * @param {object} meta - JSON-serializable metadata (taskId, tool,
		 *   callIndex, status, summary, errors, warnings, receipts, …).
		 * @param {string} text - the raw result text.
		 * @returns {{jsonPath: string, textPath: string, hash: string} | null}
		 */
		writeArtifact(meta, text) {
			if (!enabled) return null;
			const { session, taskId, callIndex, tool } = meta;
			const dir = taskDir(session, taskId);
			mkdirSync(dir, { recursive: true });
			const hash = contentHash(text);
			const base = `${String(callIndex).padStart(3, "0")}-${tool}`;
			const jsonPath = join(dir, `${base}.json`);
			const textPath = join(dir, `${base}.txt`);
			writeFileSync(jsonPath, JSON.stringify({ ...meta, hash }, null, 2), "utf8");
			writeFileSync(textPath, text, "utf8");
			return { jsonPath, textPath, hash };
		},

		/**
		 * Persist one session's broker state snapshot.
		 * @param {string} session - the session key.
		 * @param {object} state - the serializable state.
		 * @returns {string | null} the written path.
		 */
		writeSessionState(session, state) {
			if (!enabled) return null;
			const dir = join(root, "state");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${session}.json`);
			writeFileSync(path, JSON.stringify({ ...state, savedAt: Date.now() }, null, 2), "utf8");
			return path;
		},

		/**
		 * Load one session's persisted state.
		 * @param {string} session - the session key.
		 * @returns {object | null} the parsed state, or null.
		 */
		readSessionState(session) {
			if (!enabled) return null;
			const path = join(root, "state", `${session}.json`);
			if (!existsSync(path)) return null;
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch {
				return null; // corrupt state degrades to a fresh session
			}
		},

		/**
		 * List artifact files for one session (newest first).
		 * @param {string} session - the session key.
		 * @returns {Array<{taskId: string, callIndex: number, tool: string,
		 *   jsonPath: string, textPath: string, size: number, savedAt: number}>}
		 */
		listArtifacts(session) {
			if (!enabled) return [];
			const dir = artifactDir(session);
			if (!existsSync(dir)) return [];
			const rows = [];
			for (const taskId of readdirSync(dir)) {
				const taskPath = join(dir, taskId);
				if (!statSync(taskPath).isDirectory()) continue;
				for (const file of readdirSync(taskPath)) {
					if (!file.endsWith(".json")) continue;
					const jsonPath = join(taskPath, file);
					const textPath = join(taskPath, file.slice(0, -5) + ".txt");
					const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
					rows.push({
						taskId,
						callIndex: parsed.callIndex,
						tool: parsed.tool,
						jsonPath,
						textPath,
						size: existsSync(textPath) ? statSync(textPath).size : 0,
						savedAt: parsed.at ?? statSync(jsonPath).mtimeMs
					});
				}
			}
			return rows.sort((a, b) => b.savedAt - a.savedAt);
		},

		/**
		 * List every session that has persisted state or artifacts.
		 * @returns {string[]} session keys (newest first).
		 */
		listSessions() {
			if (!enabled) return [];
			const names = new Set();
			for (const dir of [join(root, "state"), join(root, "artifacts")]) {
				if (!existsSync(dir)) continue;
				for (const name of readdirSync(dir)) {
					// state files carry a .json suffix; artifact dirs do not
					names.add(name.endsWith(".json") ? name.slice(0, -5) : name);
				}
			}
			return [...names].sort();
		},

		/** Ensure the store root exists (no-op when disabled). */
		ensureRoot() {
			if (enabled) mkdirSync(root, { recursive: true });
			return enabled ? root : null;
		}
	};
}

/** Resolve a store root for the CLI scripts (env → DSH home → ~/.dsh). */
export function cliStoreRoot() {
	const explicit = process.env[STORE_ROOT_ENV];
	if (explicit !== void 0 && explicit.trim() !== "") return explicit;
	return defaultStoreRoot();
}
