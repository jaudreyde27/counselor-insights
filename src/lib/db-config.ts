import type { PoolConfig } from "pg";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

/**
 * DB_SSL=require turns on an encrypted connection (AWS RDS for Postgres 16 insists on one). It
 * encrypts the traffic but does not check the server's certificate, which is acceptable here
 * because the database sits in a private network that only the app can reach.
 */
export function sslOption(env: NodeJS.ProcessEnv = process.env): PoolConfig["ssl"] {
  return env.DB_SSL === "require" ? { rejectUnauthorized: false } : undefined;
}

function base(database: string): Pick<PoolConfig, "host" | "port" | "database" | "ssl"> {
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    database,
    ssl: sslOption(),
  };
}

/** Connection for the app: the limited `app_user` role, subject to row-level security. */
export function appDbConfig(database = need("POSTGRES_DB")): PoolConfig {
  return {
    ...base(database),
    user: process.env.APP_DB_USER ?? "app_user",
    password: need("APP_DB_PASSWORD"),
  };
}

/** Connection for migrations and tests only: the database owner. Never used by request handlers. */
export function adminDbConfig(database = need("POSTGRES_DB")): PoolConfig {
  return {
    ...base(database),
    user: need("POSTGRES_USER"),
    password: need("POSTGRES_PASSWORD"),
  };
}
