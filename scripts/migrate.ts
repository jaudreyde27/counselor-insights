// Usage: npm run db:migrate
// Applies migrations/*.sql to the local database and sets the app login password.
import path from "node:path";
import { Client } from "pg";
import { adminDbConfig } from "../src/lib/db-config";
import { runMigrations, setAppUserPassword } from "../src/lib/migrate";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on variables already in the environment.
}

async function main() {
  const client = new Client(adminDbConfig());
  await client.connect();
  try {
    const applied = await runMigrations(client, path.resolve("migrations"));
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
    const pw = process.env.APP_DB_PASSWORD;
    if (!pw) throw new Error("APP_DB_PASSWORD is not set. See .env.example.");
    await setAppUserPassword(client, process.env.APP_DB_USER ?? "app_user", pw);
    console.log("App login role is ready.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
