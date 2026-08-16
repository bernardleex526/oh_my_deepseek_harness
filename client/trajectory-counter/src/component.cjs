/**
 * TrajectoryCounter component + client plugin body.
 *
 * This file is CJS and is APPENDED inside the `__ModuleLoader__.load` factory
 * by `scripts/build-client.mjs`, right after the inlined `classify.js`
 * functions (`classifyFirstLine`, `summarize`, `firstLine` are in scope).
 * It follows the exact plugin shape of the official client plugins
 * (dsh-client-ui-jobs as the reference): `inject` lists the cordis services,
 * `apply` registers the locale dictionaries and injects a
 * `conversation.composer.dock` slot entry — the same dock that renders the
 * host's stats line ("10 轮 · 396 步 | LLM …"), so the counter appears right
 * next to it.
 */

let react_jsx_runtime = require("react/jsx-runtime");
let React = require("react");

/** Locale namespace owned by this plugin. */
const TC_NS = "trajectory-counter";

/** zh dictionary (source of truth), key-identical to en. */
const TC_ZH = {
	"we.label": "We need…",
	"let.label": "Let me…",
	"other.label": "其他",
	"title": "首行轨迹：We need… {we} · Let me… {let} · 其他 {other}（共 {total} 条助手回复）",
	"aria": "首行轨迹统计"
};
/** en dictionary. */
const TC_EN = {
	"we.label": "We need…",
	"let.label": "Let me…",
	"other.label": "Other",
	"title": "First-line style: We need… {we} · Let me… {let} · Other {other} ({total} assistant replies)",
	"aria": "First-line trajectory stats"
};

/** Scoped CSS for the chips (injected once, mirroring the jobs plugin). */
const TC_CSS = ".tc-counter{display:inline-flex;align-items:center;gap:10px;margin-left:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}.tc-chip{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}.tc-dot{width:7px;height:7px;border-radius:50%;flex:none}.tc-we{background:#3fb950}.tc-let{background:#d29922}.tc-other{background:#8b949e}.tc-num{font-variant-numeric:tabular-nums}";
const TC_CSS_TAG = "dsh-trajectory-counter/chips.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TC_CSS_TAG) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-trajectory-counter";
	tag.dataset.pluginCss = TC_CSS_TAG;
	tag.textContent = TC_CSS;
	document.head.appendChild(tag);
}

/** Best-effort session event log for one session id. */
function sessionEvents(ctx, sessionId) {
	try {
		return ctx.sessions.binding(sessionId)?.session?.events ?? null;
	} catch {
		return null;
	}
}

/** The plugin's ctx reference for components (apply is the single entry). */
const ctxRef = { current: null };

/** Subscribe to one session's live updates; re-render on any change. */
function useSessionEvents(ctx, sessionId) {
	const [rev, setRev] = React.useState(0);
	React.useEffect(() => {
		let disposed = false;
		const tick = () => {
			if (!disposed) setRev((r) => r + 1);
		};
		let session;
		try {
			session = ctx.sessions.binding(sessionId)?.session;
		} catch {
			session = void 0;
		}
		if (session === void 0) {
			tick();
			return void 0;
		}
		return session.subscribe(tick);
	}, [ctx, sessionId]);
	return rev;
}

/**
 * The counter chip group: live "We need… vs Let me…" first-line counts of the
 * session's assistant replies, rendered in the composer dock next to the
 * host stats line. Renders nothing until the session has at least one
 * assistant reply.
 */
function TrajectoryCounter({ sessionId, t }) {
	const rev = useSessionEvents(ctxRef.current, sessionId);
	const counts = React.useMemo(() => summarize(sessionEvents(ctxRef.current, sessionId) ?? []), [rev, sessionId]);
	if (counts.total === 0) return null;
	const chips = [
		{ key: "we", style: "tc-we", label: t("we.label"), count: counts.we, percent: counts.wePercent },
		{ key: "let", style: "tc-let", label: t("let.label"), count: counts.let, percent: counts.letPercent },
		{ key: "other", style: "tc-other", label: t("other.label"), count: counts.other, percent: counts.otherPercent }
	];	return react_jsx_runtime.jsx("div", {
		className: "tc-counter",
		role: "group",
		"aria-label": t("aria"),
		title: t("title", { we: counts.we, let: counts.let, other: counts.other, total: counts.total }),
		children: chips.filter((c) => c.count > 0).map((c) => react_jsx_runtime.jsxs("span", {
			className: "tc-chip",
			key: c.key,
			children: [
				react_jsx_runtime.jsx("span", { className: "tc-dot " + c.style, "aria-hidden": true }),
				react_jsx_runtime.jsx("span", { children: c.label }),
				react_jsx_runtime.jsx("span", { className: "tc-num", children: String(c.count) }),
				react_jsx_runtime.jsx("span", { className: "tc-num", children: "(" + String(c.percent) + "%)" })
			]
		}))
	});
}

/** Required services for locale registration and the composer-dock contribution. */
const inject = ["sessions", "slots", "locale"];

/** Client plugin body: register dictionaries and the counter slot entry. */
function apply(ctx) {
	ctxRef.current = ctx;
	ctx.effect(() => ctx.locale.register(TC_NS, { zh: TC_ZH, en: TC_EN }), "trajectory-counter: dictionaries");
	ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
		name: "conversation.composer.dock",
		id: "trajectory-counter",
		order: 10,
		locale: TC_NS
	}, TrajectoryCounter));
}

module.exports = { apply, inject };
