import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceSqlError } from "./Errors.ts";

export const AuthPersonalKeyState = Schema.Struct({
  fingerprint: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AuthPersonalKeyState = typeof AuthPersonalKeyState.Type;

const SetInput = Schema.Struct({
  fingerprint: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
});

/** The personal key fingerprint this host last started with. */
export class AuthPersonalKeyStateRepository extends Context.Service<
  AuthPersonalKeyStateRepository,
  {
    readonly get: () => Effect.Effect<Option.Option<AuthPersonalKeyState>, PersistenceSqlError>;
    readonly set: (input: typeof SetInput.Type) => Effect.Effect<void, PersistenceSqlError>;
    readonly clear: () => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/AuthPersonalKeyState/AuthPersonalKeyStateRepository") {}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AuthPersonalKeyState,
    execute: () =>
      sql`
        SELECT fingerprint, updated_at AS "updatedAt"
        FROM auth_personal_key_state
        WHERE singleton = 1
      `,
  });

  const setRow = SqlSchema.void({
    Request: SetInput,
    execute: ({ fingerprint, updatedAt }) =>
      sql`
        INSERT INTO auth_personal_key_state (singleton, fingerprint, updated_at)
        VALUES (1, ${fingerprint}, ${updatedAt})
        ON CONFLICT (singleton) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          updated_at = excluded.updated_at
      `,
  });

  const clearRow = SqlSchema.void({
    Request: Schema.Void,
    execute: () => sql`DELETE FROM auth_personal_key_state WHERE singleton = 1`,
  });

  return {
    get: () =>
      getRow(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(sqlError("AuthPersonalKeyStateRepository.get")),
      ),
    set: (input) =>
      setRow(input).pipe(Effect.mapError(sqlError("AuthPersonalKeyStateRepository.set"))),
    clear: () =>
      clearRow(undefined).pipe(Effect.mapError(sqlError("AuthPersonalKeyStateRepository.clear"))),
  } satisfies AuthPersonalKeyStateRepository["Service"];
});

export const layer = Layer.effect(AuthPersonalKeyStateRepository, make);
