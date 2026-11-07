import { Pool, type PoolClient } from "pg";
import { appDbConfig } from "./db-config";

let pool: Pool | undefined;

/** Shared pool for the app. Connects as the limited `app_user` role. */
export function getPool(): Pool {
  pool ??= new Pool(appDbConfig());
  return pool;
}

/**
 * Run `fn` in one transaction as the given counselor. Row-level security uses
 * the setting made here, so the callback can only see and change that
 * counselor's rows. This is the only way request code should touch the database.
 */
export async function withCounselor<T>(
  counselorId: string,
  fn: (client: PoolClient) => Promise<T>,
  p: Pool = getPool(),
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    // `true` = local to this transaction, so it can't leak to the next request.
    await client.query("SELECT set_config('app.current_counselor_id', $1, true)", [counselorId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Sign-in helper: finds the counselor for this login, creating the row on first sign-in. */
export async function findOrCreateCounselor(
  sub: string,
  email: string,
  displayName: string,
  p: Pool = getPool(),
): Promise<string> {
  const { rows } = await p.query<{ id: string }>(
    "SELECT find_or_create_counselor($1, $2, $3) AS id",
    [sub, email, displayName],
  );
  return rows[0].id;
}
