import { AsyncLocalStorage } from "node:async_hooks";
import { Client, types, type QueryResult, type QueryResultRow } from "pg";

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** Safe to expose to an owner or AI tool: no connection strings or query values. */
export class DatabaseError extends Error {
  constructor(readonly code?: string) {
    super(code ? `PostgreSQL operation failed (SQLSTATE ${code}).` : "PostgreSQL operation failed.");
    this.name = "DatabaseError";
  }
}

function databaseError(error: unknown): DatabaseError {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new DatabaseError(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined);
}

async function execute(client: Client, query: string, values: SqlValue[] = []): Promise<QueryResult<QueryResultRow>> {
  try {
    return await client.query(query, values);
  } catch (error) {
    // Driver errors may contain credentials, hosts, SQL, or private row values.
    // Do not attach the raw error as a cause or pass it to an application logger.
    throw databaseError(error);
  }
}

interface TransactionContext {
  client: Client;
  active: boolean;
  failure?: { error: unknown };
}

/**
 * Async PostgreSQL access for application data. The Agents SDK keeps its own
 * Durable Object SQLite storage; it must never be passed to this class.
 *
 * Hyperdrive owns the upstream connection pool. Clients are short-lived so a
 * Durable Object cannot retain idle connections or reuse another request's I/O.
 * All values are bound parameters; the optional `?` syntax is translated to $n.
 */
export class Database {
  private readonly transactions = new AsyncLocalStorage<TransactionContext>();

  constructor(private readonly connectionString: string) {
    if (!connectionString) throw new Error("A PostgreSQL connection string is required.");
  }

  async all<T = Row>(query: string, ...params: unknown[]): Promise<T[]> {
    return (await this.query(query, params)).rows as T[];
  }

  async one<T = Row>(query: string, ...params: unknown[]): Promise<T | null> {
    return (await this.all<T>(query, ...params))[0] ?? null;
  }

  async run(query: string, ...params: unknown[]): Promise<{ changes: number }> {
    return { changes: (await this.query(query, params)).rowCount ?? 0 };
  }

  /**
   * Runs awaited database work atomically on one connection. AsyncLocalStorage
   * isolates simultaneous requests and transactions on the same Database.
   * Nested calls join the outer transaction (they are not savepoints). A failed
   * nested call or query aborts the entire transaction, even if its error is caught.
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    const current = this.transactions.getStore();
    if (current) {
      if (!current.active) throw new Error("The database transaction has already finished. Await all transaction work.");
      try {
        return await fn();
      } catch (error) {
        current.failure ??= { error };
        throw error;
      }
    }
    return this.withClient(async (client) => {
      await execute(client, "BEGIN");
      const context: TransactionContext = { client, active: true };
      try {
        const result = await this.transactions.run(context, fn);
        if (context.failure) throw context.failure.error;
        context.active = false;
        const committed = await execute(client, "COMMIT");
        // PostgreSQL can answer COMMIT with ROLLBACK for an aborted transaction.
        if (committed.command === "ROLLBACK") throw new DatabaseError("25P02");
        return result;
      } catch (error) {
        context.active = false;
        // Preserve the original error if the connection also fails on rollback.
        await execute(client, "ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async query(query: string, params: unknown[]): Promise<QueryResult<QueryResultRow>> {
    const sql = postgresQuery(query);
    const values = params.map(normalize);
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active) throw new Error("The database transaction has already finished. Await all transaction work.");
      try {
        return await execute(transaction.client, sql, values);
      } catch (error) {
        // PostgreSQL marks a transaction failed after a statement error. Do not
        // report a successful COMMIT if application code catches that error.
        transaction.failure ??= { error };
        throw error;
      }
    }
    return this.withClient((client) => execute(client, sql, values));
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    let client: Client;
    try {
      client = new Client({
        connectionString: this.connectionString,
        connectionTimeoutMillis: 10_000,
        // COUNT, SUM(integer), identity columns and epoch milliseconds are int8.
        // Keep existing application number contracts without silent precision loss.
        types: {
          getTypeParser: (oid, format) => {
            if (oid === types.builtins.INT8 && format !== "binary") return safeInteger;
            return types.getTypeParser(oid, format);
          },
        },
      });
    } catch (error) {
      throw databaseError(error);
    }
    // An idle transport failure is also emitted as an event. Query/connect
    // promises report unusable connections; never let this event log raw secrets.
    client.on("error", () => undefined);
    try {
      try {
        await client.connect();
      } catch (error) {
        throw databaseError(error);
      }
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function safeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError("PostgreSQL integer exceeds JavaScript's safe integer range.");
  return number;
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Convert legacy positional `?` parameters without touching SQL literals,
 * quoted identifiers, dollar-quoted strings, or comments. Native $n parameters
 * are also accepted, but never mixed. This application does not use PostgreSQL
 * JSON `?` operators; use jsonb_exists() instead when adding such queries.
 * Ordinary strings follow PostgreSQL's default standard_conforming_strings=on.
 */
export function postgresQuery(query: string): string {
  let result = "";
  let index = 0;
  let parameters = 0;
  let numbered = false;
  while (index < query.length) {
    const char = query[index]!;
    const next = query[index + 1];
    if (char === "'" || char === '"') {
      const start = index++;
      const escaped = char === "'" && /[eE]/.test(query[start - 1] ?? "") && !/[\w$]/.test(query[start - 2] ?? "");
      while (index < query.length) {
        if (escaped && query[index] === "\\") {
          index += 2;
        } else if (query[index] === char) {
          index++;
          if (query[index] !== char) break;
          index++;
        } else {
          index++;
        }
      }
      result += query.slice(start, index);
    } else if (char === "-" && next === "-") {
      const end = query.indexOf("\n", index + 2);
      const stop = end === -1 ? query.length : end;
      result += query.slice(index, stop);
      index = stop;
    } else if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      let depth = 1;
      while (index < query.length && depth > 0) {
        if (query[index] === "/" && query[index + 1] === "*") {
          depth++;
          index += 2;
        } else if (query[index] === "*" && query[index + 1] === "/") {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      result += query.slice(start, index);
    } else if (char === "$") {
      const delimiter = query.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const end = query.indexOf(delimiter, index + delimiter.length);
        const stop = end === -1 ? query.length : end + delimiter.length;
        result += query.slice(index, stop);
        index = stop;
      } else {
        if (/\d/.test(next ?? "")) numbered = true;
        result += char;
        index++;
      }
    } else if (char === "?") {
      result += `$${++parameters}`;
      index++;
    } else {
      result += char;
      index++;
    }
  }
  if (parameters > 0 && numbered) throw new Error("Do not mix ? and $n SQL parameters in one query.");
  return result;
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/** Escapes a user query for PostgreSQL LIKE/ILIKE with ESCAPE '\\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Builds a safe PostgreSQL tsquery (OR of prefix terms) from free text. */
export function ftsQuery(q: string, maxTerms = 8): string | null {
  const terms = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((t) => !STOPWORDS.has(t)))].slice(0, Math.max(0, maxTerms));
  if (terms.length === 0) return null;
  return terms.map((t) => `'${t}':*`).join(" | ");
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these they this to us was we were what when where which who why will with would you your about also just like want need tell show give make get remember".split(
    " ",
  ),
);
