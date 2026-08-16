/**
 * Trajectory classifier unit tests: the "We need… vs Let me…" first-line
 * metric used by the trajectory-counter client plugin (mirrors the
 * dsh-anchored-standard measurement vocabulary).
 *
 * @module dsh-trajectory-counter/tests/classify
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyFirstLine,
	firstLine,
	messageText,
	assistantMessages,
	summarize
} from "../client/trajectory-counter/src/classify.js";

test("classifyFirstLine recognizes the anchored 'we' family", () => {
	for (const text of [
		"We need to fix the boundary check.",
		"We've identified the root cause.",
		"We're going to restructure the module.",
		"We can reuse the existing cache layer.",
		"We should verify with a targeted test.",
		"We will implement it in two steps.",
		"We must not regress the public API.",
		"We would like to confirm the contract.",
		"We have enough evidence to proceed.",
		"we need to look at src/auth.js"
	]) {
		assert.equal(classifyFirstLine(text), "we", text);
	}
});

test("classifyFirstLine recognizes the standard-like 'let' family", () => {
	for (const text of [
		"Let me check the implementation first.",
		"Let's start by reading the config.",
		"let me run the tests.",
		"Let me fix this."
	]) {
		assert.equal(classifyFirstLine(text), "let", text);
	}
});

test("classifyFirstLine falls back to 'other'", () => {
	for (const text of [
		"The user wants the login flow fixed.",
		"I'll investigate the stack trace.",
		"我来修复这个空指针问题。",
		"",
		"   ",
		"12345",
		"## Summary"
	]) {
		assert.equal(classifyFirstLine(text), "other", JSON.stringify(text));
	}
});

test("firstLine returns the first non-empty trimmed line", () => {
	assert.equal(firstLine("\n\n  We need to fix.  \nMore"), "We need to fix.");
	assert.equal(firstLine(""), "");
	assert.equal(firstLine("   \n\t"), "");
	assert.equal(firstLine("A\nB"), "A");
});

test("messageText reads the first text block of an assistant message", () => {
	assert.equal(messageText({ data: { message: { content: [{ type: "text", text: "We need x." }] } } }), "We need x.");
	assert.equal(messageText({ data: { message: { content: [{ type: "image" }, { type: "text", text: "second" }] } } }), "second");
	assert.equal(messageText({ data: { message: { content: [] } } }), "");
	assert.equal(messageText({ data: {} }), "");
	assert.equal(messageText({}), "");
});

test("assistantMessages filters and extracts only assistant/message events", () => {
	const events = [
		{ seq: 1, type: "turn/start", data: {} },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "We need a plan." }] } } },
		{ seq: 3, type: "tool/call", data: {} },
		{ seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "" }] } } }
	];
	const messages = assistantMessages(events);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0], { seq: 2, text: "We need a plan." });
	assert.deepEqual(assistantMessages([]), []);
	assert.deepEqual(assistantMessages(undefined), []);
});

test("summarize counts styles and percentages", () => {
	const events = [
		{ seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "We need to investigate." }] } } },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "Let me run the tests." }] } } },
		{ seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "We've confirmed the cause." }] } } },
		{ seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "我来修复。" }] } } }
	];
	const s = summarize(events);
	assert.equal(s.total, 4);
	assert.equal(s.we, 2);
	assert.equal(s.let, 1);
	assert.equal(s.other, 1);
	assert.equal(s.wePercent, 50);
	assert.equal(s.letPercent, 25);
	assert.equal(s.otherPercent, 25);
	assert.equal(s.messages.length, 4);
	assert.deepEqual(summarize([]), { we: 0, let: 0, other: 0, total: 0, wePercent: 0, letPercent: 0, otherPercent: 0, messages: [] });
});
