import type { RegistryStore } from "./store/types.ts";

export type RegistrySql = DurableObjectStorage["sql"];

/** Replaced by the SQLite implementation in Lane W; the interface is frozen. */
export function createSqliteRegistryStore(_sql: RegistrySql): RegistryStore {
  throw new Error("The SQLite registry store is not implemented yet.");
}
