/**
 * Drizzle client (Postgres). One process-wide pool, lazily created.
 *
 * Use:
 *   import { db } from "./db";
 *   const rows = await db.select().from(schema.profile).where(...);
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getClient(): ReturnType<typeof postgres> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set — see .env.example");
    // SSL is driven by the URL itself: include `?sslmode=require` (or
    // verify-full) for managed Postgres (Neon, Supabase, RDS). The driver
    // parses it automatically — don't override here, or you break local
    // plain-text servers (compose, docker, dev).
    _client = postgres(url, { max: 10, idle_timeout: 20 });
  }
  return _client;
}

export function db(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getClient(), { schema });
  }
  return _db;
}

export { schema };
