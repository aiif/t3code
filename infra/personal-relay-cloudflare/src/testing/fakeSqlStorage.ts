import * as NodeSqlite from "node:sqlite";

import type { RegistrySql } from "../store.ts";

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

/**
 * A `SqlStorage` stand-in backed by Node's SQLite, so the Durable Object store can
 * be tested without workerd. Not imported by the Worker bundle.
 */
export interface FakeSqlStorage {
  readonly sql: RegistrySql;
  rows(query: string, ...bindings: ReadonlyArray<SqlValue>): ReadonlyArray<Row>;
}

class FakeCursor implements Iterable<Row> {
  readonly #rows: ReadonlyArray<Row>;
  readonly columnNames: ReadonlyArray<string>;
  readonly rowsRead: number;
  readonly rowsWritten = 0;
  #index = 0;

  constructor(rows: ReadonlyArray<Row>, columnNames: ReadonlyArray<string>, rowsRead: number) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rowsRead;
  }

  next(): IteratorResult<Row, undefined> {
    if (this.#index >= this.#rows.length) return { done: true, value: undefined };
    const value = this.#rows[this.#index]!;
    this.#index += 1;
    return { done: false, value };
  }

  toArray(): Row[] {
    const remaining = this.#rows.slice(this.#index);
    this.#index = this.#rows.length;
    return [...remaining];
  }

  one(): Row {
    const rows = this.toArray();
    if (rows.length !== 1) throw new Error("Expected exactly one row.");
    return rows[0]!;
  }

  raw(): IterableIterator<ReadonlyArray<unknown>> {
    const rows = this.toArray().map((row) => this.columnNames.map((name) => row[name]));
    return rows[Symbol.iterator]();
  }

  [Symbol.iterator](): Iterator<Row, undefined> {
    return {
      next: () => this.next(),
    };
  }
}

export function createFakeSqlStorage(): FakeSqlStorage {
  const database = new NodeSqlite.DatabaseSync(":memory:");

  const read = (query: string, bindings: ReadonlyArray<SqlValue>): Row[] =>
    database.prepare(query).all(...bindings) as Row[];

  return {
    sql: {
      exec(query: string, ...bindings: ReadonlyArray<SqlValue>) {
        const statement = database.prepare(query);
        const columns = statement.columns().map((column) => column.name);
        if (columns.length === 0) {
          statement.run(...bindings);
          return new FakeCursor([], [], 0);
        }
        const rows = statement.all(...bindings) as Row[];
        return new FakeCursor(rows, columns, rows.length);
      },
      get databaseSize() {
        return 0;
      },
    } as unknown as RegistrySql,
    rows: (query, ...bindings) => read(query, bindings),
  };
}
