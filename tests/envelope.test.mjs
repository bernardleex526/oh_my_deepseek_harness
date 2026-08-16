/**
 * Envelope validation tests: the mechanical parser every specialist result
 * goes through. renderEnvelope is the canonical template; parseEnvelope is the
 * multi-line-aware validator that turns a raw envelope into structured fields
 * (v2 protocol: TASK_ID required, role sections, multi-line bodies).
 *
 * @module multi-agent-orchestrator/tests/envelope
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isKnownStatus, parseEnvelope, renderEnvelope, KNOWN_STATUSES, extractTaskId, isValidTaskId } from "../src/routing/handoff.js";

const FULL_VALID = [
	"```",
	"TASK_ID: t1",
	"STATUS: SUCCESS",
	"SUMMARY: Found the root cause and fixed it.",
	"FINDINGS: the bug was in src/auth.js",
	"EVIDENCE: src/auth.js:42",
	"UNCERTAINTIES: none",
	"RECOMMENDED_NEXT_STEP: run the test suite",
	"```"
].join("\n");

test("valid full envelope parses ok", () => {
	const r = parseEnvelope(FULL_VALID);
	assert.equal(r.ok, true);
	assert.equal(r.status, "SUCCESS");
	assert.equal(r.summary, "Found the root cause and fixed it.");
	assert.equal(r.taskId, "t1");
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.fields.FINDINGS, "the bug was in src/auth.js");
	assert.equal(r.fields.EVIDENCE, "src/auth.js:42");
	assert.equal(r.fields.UNCERTAINTIES, "none");
	assert.equal(r.fields["RECOMMENDED_NEXT_STEP"], "run the test suite");
});

test("unknown STATUS value rejects the envelope", () => {
	for (const status of ["NEED REASONING", "SUCESS", "BLOCKED / NEED REASONING"]) {
		const r = parseEnvelope(`TASK_ID: t1\nSTATUS: ${status}\nSUMMARY: something happened`);
		assert.equal(r.ok, false, `accepted unknown status "${status}"`);
		assert.equal(r.status, null);
		assert.ok(r.errors.some((e) => e.startsWith("unknown STATUS value")), r.errors.join(" | "));
	}
});

test("missing STATUS section rejects the envelope", () => {
	const r = parseEnvelope("TASK_ID: t1\nSUMMARY: there is no status here");
	assert.equal(r.ok, false);
	assert.equal(r.status, null);
	assert.ok(r.errors.includes("missing STATUS section"));
});

test("missing SUMMARY section rejects the envelope", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: SUCCESS\nFINDINGS: nothing to say");
	assert.equal(r.ok, false);
	assert.equal(r.summary, null);
	assert.ok(r.errors.includes("missing SUMMARY section"));
});

test("empty SUMMARY is an error, not just a warning", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: PARTIAL\nSUMMARY:");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("empty SUMMARY") || r.errors.includes("missing SUMMARY section"));
});

test("missing TASK_ID rejects the envelope", () => {
	const r = parseEnvelope("STATUS: SUCCESS\nSUMMARY: done without an id");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("missing TASK_ID section"), r.errors.join(" | "));
});

test("invalid TASK_ID value rejects the envelope", () => {
	const r = parseEnvelope("TASK_ID: not valid!\nSTATUS: SUCCESS\nSUMMARY: done");
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.startsWith("invalid TASK_ID value")), r.errors.join(" | "));
});

test("missing optional sections produce warnings, not errors", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: could not proceed");
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	for (const section of ["FINDINGS", "EVIDENCE", "UNCERTAINTIES", "RECOMMENDED_NEXT_STEP"]) {
		assert.ok(r.warnings.includes(`missing optional section: ${section}`), `missing warning for ${section}`);
	}
});

test("fixer BLOCKED envelope with a REASON line parses as free text", () => {
	const text = [
		"TASK_ID: t1",
		"STATUS: BLOCKED",
		"REASON: root cause differs from the input; needs re-investigation",
		"SUMMARY: could not implement as specified",
		"EVIDENCE: src/foo.mjs:12 shows a different cause"
	].join("\n");
	const r = parseEnvelope(text);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	// REASON is free text under BLOCKED — collected in `sections`, never in
	// `fields`, and never an error.
	assert.ok(!("REASON" in r.fields), "REASON is not a structured field");
	assert.equal(r.sections.REASON, "root cause differs from the input; needs re-investigation");
	assert.ok(r.warnings.includes("missing optional section: FINDINGS"));
});

test("parser tolerates extra prose, fences, and blank lines (no errors)", () => {
	const text = [
		"We investigated the problem.",
		"```",
		"TASK_ID: t9",
		"STATUS: NOT_APPLICABLE",
		"",
		"SUMMARY: No runtime change was needed.",
		"your trailing remark",
		"```"
	].join("\n");
	const r = parseEnvelope(text);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.equal(r.status, "NOT_APPLICABLE");
	assert.equal(r.summary, "No runtime change was needed.");
	assert.equal(r.taskId, "t9");
});

test("isKnownStatus recognizes exactly the canonical four", () => {
	for (const status of KNOWN_STATUSES) assert.ok(isKnownStatus(status), `known: ${status}`);
	for (const bad of ["SUCESS", "BLOCKED / NEED REASONING", "DONE", ""]) {
		assert.ok(!isKnownStatus(bad), `unexpectedly known: "${bad}"`);
	}
});

test("renderEnvelope stays the canonical template (template token coverage)", () => {
	const template = renderEnvelope();
	assert.ok(template.includes("STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE"));
	// The template contains a placeholder STATUS value that is not a single
	// valid status, so it is intentionally NOT parseable as a filled envelope.
	// This test only verifies the template carries every canonical token; the
	// real parse round-trip is covered by the concrete-envelope test below.
	for (const token of ["TASK_ID", "SUCCESS", "PARTIAL", "BLOCKED", "NOT_APPLICABLE", "SUMMARY", "FINDINGS", "EVIDENCE", "UNCERTAINTIES", "RECOMMENDED_NEXT_STEP"]) {
		assert.ok(template.includes(token), `template missing token: ${token}`);
	}
});

test("a concrete completed envelope round-trips through parseEnvelope as ok", () => {
	const envelope = [
		"TASK_ID: t2",
		"STATUS: SUCCESS",
		"SUMMARY: Fixed the off-by-one boundary check.",
		"FINDINGS: the overflow was caused by a fencepost error",
		"EVIDENCE: src/pagination.ts:42 shows the wrong comparison",
		"UNCERTAINTIES: none",
		"RECOMMENDED_NEXT_STEP: run the full test suite"
	].join("\n");
	const r = parseEnvelope(envelope);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.equal(r.status, "SUCCESS");
	assert.equal(r.summary, "Fixed the off-by-one boundary check.");
	assert.equal(r.taskId, "t2");
	assert.equal(r.fields.FINDINGS, "the overflow was caused by a fencepost error");
	assert.equal(r.fields.EVIDENCE, "src/pagination.ts:42 shows the wrong comparison");
	assert.equal(r.fields.UNCERTAINTIES, "none");
	assert.equal(r.fields["RECOMMENDED_NEXT_STEP"], "run the full test suite");
	assert.deepEqual(r.errors, []);
});

test("STATUS with trailing whitespace parses ok (value is trimmed)", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: SUCCESS \nSUMMARY: done");
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.equal(r.status, "SUCCESS");
	assert.ok(r.errors.every((e) => !e.startsWith("unknown STATUS value")), r.errors.join(" | "));
});

test("duplicate STATUS lines reject the envelope (even when both are valid)", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: SUCCESS\nSTATUS: PARTIAL\nSUMMARY: happened");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("duplicate STATUS field"), r.errors.join(" | "));
});

test("duplicate SUMMARY lines reject the envelope", () => {
	const r = parseEnvelope("TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: first\nSUMMARY: second");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("duplicate SUMMARY field"), r.errors.join(" | "));
});

test("duplicate optional canonical fields also reject the envelope", () => {
	const r = parseEnvelope([
		"TASK_ID: t1",
		"STATUS: SUCCESS",
		"SUMMARY: s",
		"FINDINGS: one",
		"FINDINGS: two",
		"EVIDENCE: a",
		"UNCERTAINTIES: b",
		"RECOMMENDED_NEXT_STEP: c"
	].join("\n"));
	assert.equal(r.ok, false, "a duplicate FINDINGS must reject the envelope");
	assert.ok(r.errors.includes("duplicate FINDINGS field"), r.errors.join(" | "));
});

// ── v2: multi-line sections ────────────────────────────────────────────────

test("multi-line CHANGES / VERIFICATION bodies are captured as sections", () => {
	const text = [
		"TASK_ID: t3",
		"STATUS: SUCCESS",
		"SUMMARY: Implemented the caching layer.",
		"CHANGES:",
		"  src/cache.js: added LRU eviction",
		"  tests/cache.test.js: added eviction tests",
		"VERIFICATION:",
		"  npm test: 42 passed",
		"  npm run lint: clean",
		"EVIDENCE: git diff src/cache.js",
		"UNCERTAINTIES: none",
		"RECOMMENDED_NEXT_STEP: run the full suite"
	].join("\n");
	const r = parseEnvelope(text);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.ok(r.sections.CHANGES.includes("src/cache.js: added LRU eviction"), r.sections.CHANGES);
	assert.ok(r.sections.CHANGES.includes("tests/cache.test.js: added eviction tests"));
	assert.ok(r.sections.VERIFICATION.includes("npm test: 42 passed"));
	assert.ok(r.sections.VERIFICATION.includes("npm run lint: clean"));
	// `fields` keeps the first line of the section body for backward
	// compatibility (here the first body line, since the header line is empty).
	assert.equal(r.fields.CHANGES, "src/cache.js: added LRU eviction");
	assert.equal(r.fields.VERIFICATION, "npm test: 42 passed");
});

test("multi-line SPECIFICATION body is captured", () => {
	const text = [
		"TASK_ID: t4",
		"STATUS: SUCCESS",
		"SUMMARY: Spec for the settings page.",
		"SPECIFICATION:",
		"  Component: SettingsPage",
		"  Desired behavior: inline validation",
		"  Acceptance criteria: WCAG AA",
		"UNCERTAINTIES: none",
		"RECOMMENDED_NEXT_STEP: hand to Fixer"
	].join("\n");
	const r = parseEnvelope(text);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.ok(r.sections.SPECIFICATION.includes("Component: SettingsPage"));
	assert.ok(r.sections.SPECIFICATION.includes("Acceptance criteria: WCAG AA"));
});

test("multi-line body containing a STATUS-like line is treated as a new section (protocol boundary)", () => {
	// Content lines that LOOK like section headers terminate the previous
	// section — the protocol requires bodies to be indented or dash-prefixed.
	const r = parseEnvelope([
		"TASK_ID: t5",
		"STATUS: SUCCESS",
		"SUMMARY: s",
		"CHANGES:",
		"  src/a.js: fixed",
		"STATUS: PARTIAL",
		"SUMMARY: second"
	].join("\n"));
	assert.equal(r.ok, false, "duplicate STATUS/SUMMARY must reject");
	assert.ok(r.errors.includes("duplicate STATUS field"));
	assert.ok(r.errors.includes("duplicate SUMMARY field"));
});

test("extractTaskId reads the declared task id from a delegation prompt", () => {
	assert.equal(extractTaskId("TASK_ID: t1\nYou are the explorer specialist."), "t1");
	assert.equal(extractTaskId("TASK_ID: task-42\nTASK: do it"), "task-42");
	assert.equal(extractTaskId("TASK: do it\nTASK_ID: t9"), "t9");
	assert.equal(extractTaskId("no id here"), null);
	assert.equal(extractTaskId("TASK_ID: bad id\nTASK: x"), null);
});

test("isValidTaskId accepts stable ids and rejects spaces/specials", () => {
	assert.ok(isValidTaskId("t1"));
	assert.ok(isValidTaskId("task-42"));
	assert.ok(isValidTaskId("a.b_c"));
	assert.ok(!isValidTaskId("not valid"));
	assert.ok(!isValidTaskId(""));
	assert.ok(!isValidTaskId("-leading"));
	assert.ok(!isValidTaskId("a/b"));
});
