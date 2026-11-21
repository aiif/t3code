import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Remembers which personal key this host last used, so a changed key revokes
 * the guest sessions the old one created instead of leaving them valid.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_personal_key_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
