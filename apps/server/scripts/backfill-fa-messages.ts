/**
 * One-shot backfill: migrate persisted conversation_message rows from the old
 * Anthropic content-block shape (`type:"tool_use"|"tool_result"|...`) to the
 * canonical `Fa*` shape (`kind:"tool_call"|"tool_result"|...`).
 *
 * Idempotent: a row whose content is already `Fa*` (first block has `kind`),
 * a plain string, or an empty array is left untouched. Safe to re-run — the
 * second pass updates 0 rows.
 *
 * Usage (post-deploy, same channel as db:migrate:prod):
 *   bun run apps/server/scripts/backfill-fa-messages.ts
 *   # or in prod:  kamal app exec --reuse "bun run apps/server/scripts/backfill-fa-messages.ts"
 *
 * Reuses the SAME anthropicContentToFa() the Anthropic adapter uses, so the
 * conversion logic lives in exactly one place. Requires DATABASE_URL.
 */
import { eq } from "drizzle-orm";

import { anthropicContentToFa } from "@fa/agent";
import { db, schema } from "@fa/db_postgres";

// Already in the new shape? An Fa block is an object with a `kind` field; a
// legacy Anthropic block has `type`. Strings and empty arrays are shape-neutral.
function isAlreadyFa(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return true; // malformed — leave for the loader to drop
  if (content.length === 0) return true;
  const first = content[0] as Record<string, unknown> | null;
  return !!first && typeof first === "object" && "kind" in first;
}

async function main(): Promise<void> {
  const rows = await db()
    .select({
      id: schema.conversationMessage.id,
      content: schema.conversationMessage.content,
    })
    .from(schema.conversationMessage)
    .orderBy(schema.conversationMessage.id);

  let converted = 0;
  let skipped = 0;
  for (const r of rows) {
    if (isAlreadyFa(r.content)) {
      skipped++;
      continue;
    }
    const faContent = anthropicContentToFa(r.content as Parameters<typeof anthropicContentToFa>[0]);
    await db()
      .update(schema.conversationMessage)
      .set({ content: faContent as unknown })
      .where(eq(schema.conversationMessage.id, r.id));
    converted++;
    if (converted % 200 === 0) console.log(`  …converted ${converted}`);
  }

  console.log(
    `backfill complete: ${converted} converted, ${skipped} already-Fa/neutral, ${rows.length} total`,
  );
  // postgres-js keeps the pool open; exit explicitly so the script terminates.
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
