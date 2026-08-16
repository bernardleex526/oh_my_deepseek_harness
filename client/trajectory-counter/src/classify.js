/**
 * First-line trajectory classifier for the trajectory counter client plugin.
 *
 * Mirrors the metric dsh-anchored-standard uses to measure first-request
 * anchoring: the FIRST LINE of each assistant reply is classified into
 *   - "we"  — the anchored, planning-style signature ("We need …", "We've …",
 *             "We're going to …", …);
 *   - "let" — the standard-like action signature ("Let me …", "Let's …");
 *   - "other" — everything else (including Chinese replies).
 *
 * Pure and dependency-free so the same logic is unit-tested in Node and
 * inlined into the browser bundle.
 *
 * @module dsh-trajectory-counter/classify
 */

/** The anchored "we" family: "we" + a modal/auxiliary (with contractions). */
export const WE_PATTERNS = /^we[ '’]?(?:need|'ve|'re|'ll|can|should|will|must|could|would|want|have|has|are|wouldn|can't|cannot|don't|didn't)\b/i;

/** The standard-like "let" family. */
export const LET_PATTERNS = /^let[ '’]?s\b|^let me\b/i;

/**
 * Classify the first non-empty line of one assistant text.
 * @param {string} text - the assistant message text.
 * @returns {"we" | "let" | "other"}
 */
export function classifyFirstLine(text) {
	const first = firstLine(text);
	if (first === "") return "other";
	if (WE_PATTERNS.test(first)) return "we";
	if (LET_PATTERNS.test(first)) return "let";
	return "other";
}

/**
 * The first non-empty line of a text (trimmed, whitespace folded).
 * @param {string} text - the raw text.
 * @returns {string} "" when there is no content.
 */
export function firstLine(text) {
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line !== "") return line.replace(/\s+/g, " ").trim();
	}
	return "";
}

/**
 * Extract the text of one assistant/message event: the first text block of
 * `event.data.message.content` (the shape the host's conversation client
 * reads via `toAssistantBlocks`).
 * @param {object} event - a session event.
 * @returns {string} the message text ("" when absent).
 */
export function messageText(event) {
	const content = event?.data?.message?.content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

/**
 * Assistant messages of one session event log.
 * @param {Array<object>} events - the session's durable events.
 * @returns {Array<{seq: number, text: string}>}
 */
export function assistantMessages(events) {
	if (!Array.isArray(events)) return [];
	const out = [];
	for (const event of events) {
		if (event?.type !== "assistant/message") continue;
		const text = messageText(event);
		if (text === "") continue;
		out.push({ seq: event.seq, text });
	}
	return out;
}

/**
 * Summarize the trajectory style of one session's assistant messages.
 * @param {Array<object>} events - the session's durable events.
 * @returns {{we: number, let: number, other: number, total: number,
 *   wePercent: number, letPercent: number, otherPercent: number,
 *   messages: Array<{seq: number, style: string}>}}
 */
export function summarize(events) {
	const messages = assistantMessages(events).map(({ seq, text }) => ({ seq, style: classifyFirstLine(text) }));
	let we = 0;
	let letCount = 0;
	let other = 0;
	for (const m of messages) {
		if (m.style === "we") we += 1;
		else if (m.style === "let") letCount += 1;
		else other += 1;
	}
	const total = messages.length;
	const percent = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
	return {
		we,
		let: letCount,
		other,
		total,
		wePercent: percent(we),
		letPercent: percent(letCount),
		otherPercent: percent(other),
		messages
	};
}
