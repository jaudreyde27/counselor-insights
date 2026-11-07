import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

/**
 * Applies the SQL files in `migrations/` in filename order, once each.
 * Applied files are recorded in `schema_migrations`. Returns the names applied now.
 * Run as the database owner (see scripts/migrate.ts), never as `app_user`.
 */
export async function runMigrations(client: Client, dir: string): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const done = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}

/** Gives the `app_user` role its login password (read from the environment, never from a file). */
export async function setAppUserPassword(client: Client, user: string, password: string): Promise<void> {
  const { rows } = await client.query<{ stmt: string }>(
    "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS stmt",
    [user, password],
  );
  await client.query(rows[0].stmt);
}
