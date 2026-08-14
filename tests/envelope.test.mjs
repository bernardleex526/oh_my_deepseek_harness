/**
 * Envelope validation tests: the mechanical parser every specialist result
 * goes through. renderEnvelope is the canonical template; parseEnvelope is the
 * tolerant validator that turns a raw envelope into structured fields.
 *
 * @module multi-agent-orchestrator/tests/envelope
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isKnownStatus, parseEnvelope, renderEnvelope, KNOWN_STATUSES } from "../src/routing/handoff.js";

const FULL_VALID = [
	"```",
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
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
	assert.equal(r.fields.FINDINGS, "the bug was in src/auth.js");
	assert.equal(r.fields.EVIDENCE, "src/auth.js:42");
	assert.equal(r.fields.UNCERTAINTIES, "none");
	assert.equal(r.fields["RECOMMENDED_NEXT_STEP"], "run the test suite");
});

test("unknown STATUS value rejects the envelope", () => {
	for (const status of ["NEED REASONING", "SUCESS", "BLOCKED / NEED REASONING"]) {
		const r = parseEnvelope(`STATUS: ${status}\nSUMMARY: something happened`);
		assert.equal(r.ok, false, `accepted unknown status "${status}"`);
		assert.equal(r.status, null);
		assert.ok(r.errors.some((e) => e.startsWith("unknown STATUS value")), r.errors.join(" | "));
	}
});

test("missing STATUS section rejects the envelope", () => {
	const r = parseEnvelope("SUMMARY: there is no status here");
	assert.equal(r.ok, false);
	assert.equal(r.status, null);
	assert.ok(r.errors.includes("missing STATUS section"));
});

test("missing SUMMARY section rejects the envelope", () => {
	const r = parseEnvelope("STATUS: SUCCESS\nFINDINGS: nothing to say");
	assert.equal(r.ok, false);
	assert.equal(r.summary, null);
	assert.ok(r.errors.includes("missing SUMMARY section"));
});

test("empty SUMMARY is an error, not just a warning", () => {
	const r = parseEnvelope("STATUS: PARTIAL\nSUMMARY:");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("empty SUMMARY") || r.errors.includes("missing SUMMARY section"));
});

test("missing optional sections produce warnings, not errors", () => {
	const r = parseEnvelope("STATUS: BLOCKED\nSUMMARY: could not proceed");
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	for (const section of ["FINDINGS", "EVIDENCE", "UNCERTAINTIES", "RECOMMENDED_NEXT_STEP"]) {
		assert.ok(r.warnings.includes(`missing optional section: ${section}`), `missing warning for ${section}`);
	}
});

test("fixer BLOCKED envelope with a REASON line parses as free text", () => {
	const text = [
		"STATUS: BLOCKED",
		"REASON: root cause differs from the input; needs re-investigation",
		"SUMMARY: could not implement as specified",
		"EVIDENCE: src/foo.mjs:12 shows a different cause"
	].join("\n");
	const r = parseEnvelope(text);
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	// REASON is free text under BLOCKED — not treated as an error, and not
	// captured as a known field.
	assert.ok(!("REASON" in r.fields), "REASON is not a structured field");
	assert.ok(r.warnings.includes("missing optional section: FINDINGS"));
});

test("parser tolerates extra prose, fences, and blank lines (no errors)", () => {
	const text = [
		"We investigated the problem.",
		"```",
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
	for (const token of ["SUCCESS", "PARTIAL", "BLOCKED", "NOT_APPLICABLE", "SUMMARY", "FINDINGS", "EVIDENCE", "UNCERTAINTIES", "RECOMMENDED_NEXT_STEP"]) {
		assert.ok(template.includes(token), `template missing token: ${token}`);
	}
});

test("a concrete completed envelope round-trips through parseEnvelope as ok", () => {
	const envelope = [
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
	assert.equal(r.fields.FINDINGS, "the overflow was caused by a fencepost error");
	assert.equal(r.fields.EVIDENCE, "src/pagination.ts:42 shows the wrong comparison");
	assert.equal(r.fields.UNCERTAINTIES, "none");
	assert.equal(r.fields["RECOMMENDED_NEXT_STEP"], "run the full test suite");
	assert.deepEqual(r.errors, []);
});

test("STATUS with trailing whitespace parses ok (value is trimmed)", () => {
	const r = parseEnvelope("STATUS: SUCCESS \nSUMMARY: done");
	assert.equal(r.ok, true, `unexpected errors: ${r.errors.join(" | ")}`);
	assert.equal(r.status, "SUCCESS");
	assert.ok(r.errors.every((e) => !e.startsWith("unknown STATUS value")), r.errors.join(" | "));
});

test("duplicate STATUS lines reject the envelope (even when both are valid)", () => {
	const r = parseEnvelope("STATUS: SUCCESS\nSTATUS: PARTIAL\nSUMMARY: happened");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("duplicate STATUS field"), r.errors.join(" | "));
});

test("duplicate SUMMARY lines reject the envelope", () => {
	const r = parseEnvelope("STATUS: SUCCESS\nSUMMARY: first\nSUMMARY: second");
	assert.equal(r.ok, false);
	assert.ok(r.errors.includes("duplicate SUMMARY field"), r.errors.join(" | "));
});

test("duplicate optional canonical fields also reject the envelope", () => {
	const r = parseEnvelope([
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
