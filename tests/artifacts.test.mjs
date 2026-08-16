/**
 * ArtifactStore tests: persistence of delegation artifacts and broker state
 * snapshots — the P1 base for crash recovery, task replay, and the status /
 * metrics CLIs.
 *
 * @module multi-agent-orchestrator/tests/artifacts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createArtifactStore,
	resolveStoreRoot,
	defaultStoreRoot,
	contentHash,
	STORE_ROOT_ENV
} from "../src/orchestration/artifacts.mjs";

/** A temp store root that is always deleted afterwards. */
function tempStore(t) {
	const root = mkdtempSync(join(tmpdir(), "mao-store-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("persistence is opt-in via DSH_ORCHESTRATION_HOME (never implicit)", () => {
	const before = process.env[STORE_ROOT_ENV];
	try {
		delete process.env[STORE_ROOT_ENV];
		assert.equal(resolveStoreRoot(), null, "without the env var the store must be disabled");
		assert.equal(createArtifactStore().enabled, false);
		assert.equal(createArtifactStore().writeArtifact({}, "x"), null, "disabled store writes are no-ops");
		assert.equal(createArtifactStore().readSessionState("s"), null);
		process.env[STORE_ROOT_ENV] = "C:\\tmp\\store";
		assert.equal(resolveStoreRoot(), "C:\\tmp\\store");
	} finally {
		if (before === void 0) delete process.env[STORE_ROOT_ENV];
		else process.env[STORE_ROOT_ENV] = before;
	}
});

test("defaultStoreRoot falls back to DSH_HOME then ~/.dsh", () => {
	const beforeHome = process.env.DSH_HOME;
	const beforeStore = process.env[STORE_ROOT_ENV];
	try {
		delete process.env[STORE_ROOT_ENV];
		process.env.DSH_HOME = "C:\\dsh-home";
		assert.equal(defaultStoreRoot(), "C:\\dsh-home\\orchestration");
		delete process.env.DSH_HOME;
		assert.ok(defaultStoreRoot().endsWith(join(".dsh", "orchestration")));
	} finally {
		if (beforeHome === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = beforeHome;
		if (beforeStore === void 0) delete process.env[STORE_ROOT_ENV];
		else process.env[STORE_ROOT_ENV] = beforeStore;
	}
});

test("contentHash is deterministic and prefix-stable", () => {
	assert.equal(contentHash("hello"), contentHash("hello"));
	assert.equal(contentHash("hello").length, 16);
	assert.notEqual(contentHash("hello"), contentHash("hello!"));
});

test("writeArtifact persists meta + raw text and lists them back", (t) => {
	const store = createArtifactStore(tempStore(t));
	const meta = { session: "sess-1", taskId: "t1", callIndex: 0, tool: "subagent_fixer", status: "SUCCESS" };
	const out = store.writeArtifact(meta, "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.");
	assert.ok(out !== null);
	assert.ok(existsSync(out.jsonPath));
	assert.ok(existsSync(out.textPath));
	assert.equal(out.hash, contentHash("TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok."));
	const parsed = JSON.parse(readFileSync(out.jsonPath, "utf8"));
	assert.equal(parsed.status, "SUCCESS");
	assert.equal(parsed.hash, out.hash);
	assert.equal(readFileSync(out.textPath, "utf8"), "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.");

	const rows = store.listArtifacts("sess-1");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].taskId, "t1");
	assert.equal(rows[0].tool, "subagent_fixer");
	assert.equal(rows[0].size, "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.".length);
	// other sessions see nothing
	assert.deepEqual(store.listArtifacts("sess-other"), []);
});

test("session state round-trips through writeSessionState/readSessionState", (t) => {
	const store = createArtifactStore(tempStore(t));
	assert.equal(store.readSessionState("sess-1"), null, "absent state reads null");
	const state = {
		tasks: [{
			taskId: "t1",
			delegationsUsed: 3,
			attempts: { subagent_explorer: 2, subagent_fixer: 1 },
			consecutiveFailures: 1,
			results: [{ at: 1, tool: "subagent_explorer", status: "SUCCESS", callIndex: 0 }]
		}]
	};
	store.writeSessionState("sess-1", state);
	const loaded = store.readSessionState("sess-1");
	assert.equal(loaded.tasks[0].delegationsUsed, 3);
	assert.equal(loaded.tasks[0].attempts.subagent_explorer, 2);
	assert.ok(loaded.savedAt > 0);
});

test("corrupt session state degrades to null (fresh session)", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	mkdirSync(join(root, "state"), { recursive: true });
	writeFileSync(join(root, "state", "sess-1.json"), "{not json", "utf8");
	assert.equal(store.readSessionState("sess-1"), null);
});

test("listSessions merges state and artifact directories", (t) => {
	const root = tempStore(t);
	const store = createArtifactStore(root);
	store.writeSessionState("sess-a", { tasks: [] });
	store.writeArtifact({ session: "sess-b", taskId: "t1", callIndex: 0, tool: "subagent_explorer", status: "SUCCESS" }, "text");
	const sessions = store.listSessions();
	assert.ok(sessions.includes("sess-a"));
	assert.ok(sessions.includes("sess-b"));
});

test("disabled store reports no sessions and empty artifact lists", () => {
	const store = createArtifactStore(null);
	assert.equal(store.enabled, false);
	assert.deepEqual(store.listSessions(), []);
	assert.deepEqual(store.listArtifacts("s"), []);
});
