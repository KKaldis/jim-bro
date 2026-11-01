/**
 * Tool definitions (canonical `Fa*` schema) + executor — public entry point.
 * Each tool is a deterministic operation on the user's data.
 * The agent picks tools based on the system prompt and tool descriptions.
 *
 * Layout:
 *   tools/defs/<domain>.ts      the definitions (name, description, schema)
 *   tools/registry.ts           groups, MUTATING_TOOLS, RESULT_CARD_TOOLS,
 *                               categories/labels, input preparation
 *   tools/executor.ts           the name → handler switch
 *   tools/handlers/<domain>.ts  the handlers
 * Adding a tool: a definition, a case in the executor, a handler, and its
 * group + category entries in the registry (all checked against ToolName).
 *
 * UI scheme — every tool should prefer a bespoke UI over prose, on whichever
 * side applies, when a fitting component exists:
 *   - INPUT  (mutating tools): add to MUTATING_TOOLS so the call opens a
 *            pre-execution form gate, and give it a bespoke form in
 *            apps/web/src/forms/overrides.tsx (the user edits + confirms the
 *            args before anything is written).
 *   - OUTPUT (read/compute tools that return user-facing numbers): add to
 *            RESULT_CARD_TOOLS (tools/registry.ts) and register a card in
 *            apps/web/src/cards/resultCards.tsx so the result renders as a rich
 *            card (calorie ring / macro bars / metric gauge) instead of the
 *            model re-typing the numbers.
 * Reuse the existing form-kit primitives / Dashboard viz widgets rather than
 * hand-rolling.
 */
export { executeTool } from "./tools/executor.ts";
export { APP_SCREENS, SCREEN_TABS, type AppScreen } from "./tools/handlers/core.ts";
export { parseRecipeFromHtml } from "./tools/handlers/recipes.ts";
export { buildStateTag } from "./tools/handlers/shared.ts";
export {
  DUPLICATE_READ_PREFIX,
  HIDDEN_RESULT_CARD_TOOLS,
  MUTATING_TOOLS,
  REQUESTABLE_GROUPS,
  RESULT_CARD_TOOLS,
  SERVER_TOOLS,
  TOOLS,
  TOOL_GROUPS,
  getToolCategory,
  getToolLabel,
  getToolSchema,
  hasResultCard,
  isMutatingTool,
  modelFacingToolResult,
  prepareToolInput,
  toolSchemas,
  toolsForGroups,
  type PreparedToolInput,
  type ToolCategory,
  type ToolGroup,
  type ToolName,
} from "./tools/registry.ts";
