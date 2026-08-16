/**
 * Client bundle tests: the trajectory-counter browser bundle must
 *  - be byte-identical to a fresh build (reproducibility gate),
 *  - compile and load through the host's `window.__ModuleLoader__` contract,
 *  - register its locale dictionaries and the `conversation.composer.dock`
 *    slot entry (the same dock that renders the host stats line),
 *  - render the live "We need… vs Let me…" counts from a session event log.
 *
 * The bundle is executed in a `node:vm` sandbox with stubbed react /
 * jsx-runtime and a fake cordis ctx, so no browser and no react install are
 * needed.
 *
 * @module dsh-trajectory-counter/tests/client-bundle
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildClientBundle } from "../scripts/build-client.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_PATH = join(ROOT, "client", "trajectory-counter", "client", "client.js");
const PKG = JSON.parse(readFileSync(join(ROOT, "client", "trajectory-counter", "package.json"), "utf8"));

test("the committed client bundle is reproducible (matches a fresh build)", () => {
	assert.equal(readFileSync(BUNDLE_PATH, "utf8"), buildClientBundle());
});

/** Minimal react hooks stub: useState/useMemo/useRef execute, effects no-op. */
function reactStub() {
	return {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect: () => {},
		useMemo: (fn) => fn(),
		useRef: (init) => ({ current: init }),
		memo: (fn) => fn,
		Fragment: Symbol("Fragment")
	};
}

/** jsx/jsxs stubs that record a plain element tree. */
function jsxStubs() {
	const element = (type, props) => ({ type, props: props ?? {} });
	return { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
}

/** Collect all text leaves of an element tree. */
function collectText(node, out = []) {
	if (node === null || node === void 0) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	const children = node.props?.children;
	if (Array.isArray(children)) for (const child of children) collectText(child, out);
	else if (children !== void 0) collectText(children, out);
	return out;
}

/** A fake cordis ctx capturing locale + slot registrations and serving events. */
function fakeCtx(events) {
	const dictionaries = {};
	let slotInject = null;
	const registrations = [];
	const ctx = {
		effect: (fn) => fn(), // cordis runs the effect immediately (dispose on teardown)
		locale: {
			register(ns, dict) {
				dictionaries[ns] = dict;
			}
		},
		slots: {
			inject(name, fn) {
				slotInject = { name, fn };
			},
			register(config, component) {
				registrations.push({ config, component });
			}
		},
		sessions: {
			binding: () => ({ session: { events, subscribe: () => () => {} } })
		}
	};
	return { ctx, dictionaries, registrations, invokeSlotInject: () => slotInject.fn() };
}

/** Load the bundle through a fake `window.__ModuleLoader__` and fake require. */
function loadBundle() {
	const documentStub = {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" }),
		head: { appendChild: () => {} }
	};
	let loadedEntry = null;
	const windowStub = {
		__ModuleLoader__: {
			load(entry) {
				loadedEntry = entry;
			}
		}
	};
	vm.runInNewContext(readFileSync(BUNDLE_PATH, "utf8"), { window: windowStub, document: documentStub }, { filename: "client.js" });
	assert.ok(loadedEntry !== null, "the bundle must call window.__ModuleLoader__.load");
	assert.equal(loadedEntry.id, PKG.name);

	const requireMap = {
		"react": reactStub(),
		"react/jsx-runtime": jsxStubs()
	};
	return loadedEntry.factory((id) => {
		assert.ok(id in requireMap, `unexpected require: ${id}`);
		return requireMap[id];
	});
}

/** A translator built from a dictionary (zh). */
function makeT(dict) {
	return (key, params = {}) => {
		const template = dict[key] ?? key;
		return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
	};
}

test("the bundle registers locale dictionaries and the composer-dock slot entry", () => {
	const { ctx, dictionaries, registrations, invokeSlotInject } = fakeCtx([]);
	const plugin = loadBundle();
	assert.deepEqual([...plugin.inject], ["sessions", "slots", "locale"]);
	plugin.apply(ctx);
	assert.ok(dictionaries["trajectory-counter"], "locale namespace must be registered");
	assert.ok("we.label" in dictionaries["trajectory-counter"].zh);
	assert.ok("we.label" in dictionaries["trajectory-counter"].en);
	// the lazy inject registers the entry (exactly like the jobs plugin)
	invokeSlotInject();
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].config.name, "conversation.composer.dock");
	assert.equal(registrations[0].config.id, "trajectory-counter");
	assert.equal(registrations[0].config.order, 10);
	assert.equal(registrations[0].config.locale, "trajectory-counter");
	assert.equal(typeof registrations[0].component, "function");
});

test("the counter renders We/Let/Other counts next to the host stats dock", () => {
	const events = [
		{ seq: 1, type: "turn/start", data: {} },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "We need to investigate the auth flow." }] } } },
		{ seq: 3, type: "tool/call", data: { name: "subagent_explorer" } },
		{ seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "Let me run the targeted tests." }] } } },
		{ seq: 5, type: "assistant/message", data: { message: { content: [{ type: "text", text: "We've confirmed the root cause." }] } } },
		{ seq: 6, type: "assistant/message", data: { message: { content: [{ type: "text", text: "我来修复。" }] } } }
	];
	const { ctx, dictionaries, registrations, invokeSlotInject } = fakeCtx(events);
	const plugin = loadBundle();
	plugin.apply(ctx);
	invokeSlotInject();
	const tree = registrations[0].component({
		sessionId: "session-1",
		t: makeT(dictionaries["trajectory-counter"].zh)
	});
	assert.ok(tree !== null, "the counter must render once assistant replies exist");
	const text = collectText(tree).join(" ");
	assert.match(text, /We need…/);
	assert.match(text, /Let me…/);
	assert.match(text, /其他/);
	assert.match(text, /\b2\b/, "two 'we' replies");
	assert.match(text, /\b1\b/, "one 'let' reply");
	assert.match(text, /\(50%\)/, "we share");
	assert.match(text, /\(25%\)/, "let share");
	assert.equal(tree.props.className, "tc-counter", "root chip group class present");
});

test("the counter renders nothing before the first assistant reply", () => {
	const { ctx, dictionaries, registrations, invokeSlotInject } = fakeCtx([{ seq: 1, type: "turn/start", data: {} }]);
	const plugin = loadBundle();
	plugin.apply(ctx);
	invokeSlotInject();
	const tree = registrations[0].component({
		sessionId: "session-1",
		t: makeT(dictionaries["trajectory-counter"].zh)
	});
	assert.equal(tree, null);
});
