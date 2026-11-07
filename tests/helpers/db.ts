import path from "node:path";
import { Client, Pool } from "pg";
import { adminDbConfig, appDbConfig } from "@/lib/db-config";
import { runMigrations, setAppUserPassword } from "@/lib/migrate";

export interface TestDb {
  /** Database owner. Bypasses row-level security. For seeding and inspection only. */
  admin: Pool;
  /** The limited `app_user` role, exactly as the app connects. */
  app: Pool;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Creates (if needed) a separate `<POSTGRES_DB>_test` database, migrates it,
 * and returns pools. Your dev data is never touched. Needs `npm run db:up`.
 */
export async function setupTestDb(): Promise<TestDb> {
  const testDb = `${process.env.POSTGRES_DB}_test`;

  const root = new Client(adminDbConfig("postgres"));
  try {
    await root.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the local database (${(err as Error).message}). Start it with: npm run db:up`,
    );
  }
  const exists = await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [testDb]);
  if (exists.rowCount === 0) await root.query(`CREATE DATABASE "${testDb}"`);
  await root.end();

  const migrator = new Client(adminDbConfig(testDb));
  await migrator.connect();
  await runMigrations(migrator, path.resolve("migrations"));
  await setAppUserPassword(migrator, process.env.APP_DB_USER ?? "app_user", process.env.APP_DB_PASSWORD!);
  await migrator.end();

  const admin = new Pool(adminDbConfig(testDb));
  const app = new Pool(appDbConfig(testDb));
  return {
    admin,
    app,
    reset: async () => {
      await admin.query("TRUNCATE counselors CASCADE");
    },
    close: async () => {
      await app.end();
      await admin.end();
    },
  };
}
