// Loads the local .env (git-ignored) so database tests can connect.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on variables already in the environment (e.g. CI).
}

// Tests must not break when the real deadline (2026-12-15) passes. Tests of the deadline itself pass their own settings.
process.env.APP_ACTIVE_UNTIL = "2099-12-31";
