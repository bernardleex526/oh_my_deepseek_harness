/**
 * Multi-agent orchestration mode for DeepSeek Harness.
 *
 * Exports the pure building blocks (routing, permissions, catalog) so the
 * build script and the test suite share one source of truth. The runtime
 * artifact is the generated agent preset under `preset/orchestrator/`.
 *
 * @module multi-agent-orchestrator
 */

export * from "./agents/catalog.js";
export * from "./config/defaults.js";
export * from "./config/model-routing.js";
export * from "./config/schema.js";
export * from "./permissions/agent-permissions.js";
export * from "./routing/handoff.js";
export * from "./routing/policy.js";
