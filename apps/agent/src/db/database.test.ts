import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  clients: [] as {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    config: { types: { getTypeParser: (oid: number, format?: string) => (value: string) => unknown } };
  }[],
  query: vi.fn(),
  connect: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("pg", () => ({
  types: {
    builtins: { INT8: 20 },
    getTypeParser: () => (value: string) => value,
  },
  Client: class {
    query = vi.fn((query: string, values: unknown[]) => mock.query(query, values));
    connect = vi.fn(() => mock.connect());
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(readonly config: (typeof mock.clients)[number]["config"]) {
      mock.construct();
      mock.clients.push(this);
    }
  },
}));

import { Database, DatabaseError, ftsQuery, likePattern, postgresQuery } from "./database";
import { MIGRATIONS, migrate } from "./migrations";

beforeEach(() => {
  mock.clients.length = 0;
  mock.construct.mockReset();
  mock.connect.mockReset().mockResolvedValue(undefined);
  mock.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("PostgreSQL bound parameters", () => {
  it("converts placeholders without rewriting literals, identifiers or comments", () => {
    const query = `SELECT ?, '?', 'it''s ?', "?", E'escaped\\'? still literal', $$?$$, $body$?$body$
      /* ? /* nested ? */ ? */ -- ?
      WHERE value = ?`;
    const result = postgresQuery(query);
    expect(result).toContain("SELECT $1, '?', 'it''s ?', \"?\"");
    expect(result).toContain("E'escaped\\'? still literal'");
    expect(result).toContain("$$?$$, $body$?$body$");
    expect(result).toContain("/* ? /* nested ? */ ? */ -- ?");
    expect(result).toContain("WHERE value = $2");
  });

  it("accepts native numbered parameters and rejects mixed parameter styles", () => {
    expect(postgresQuery("SELECT $1, $2, '?'" )).toBe("SELECT $1, $2, '?'");
    expect(() => postgresQuery("SELECT $1, ?")).toThrow(/Do not mix/);
    expect(postgresQuery("SELECT '$1', ?")).toBe("SELECT '$1', $1");
    expect(postgresQuery("SELECT ? -- $1")).toBe("SELECT $1 -- $1");
  });

  it("keeps a literal PostgreSQL escape backslash and escaped LIKE values", () => {
    expect(postgresQuery("SELECT ? LIKE ? ESCAPE '\\'")).toBe("SELECT $1 LIKE $2 ESCAPE '\\'");
    expect(likePattern("50%_\\off")).toBe("%50\\%\\_\\\\off%");
  });

  it("passes values separately and normalizes existing application values", async () => {
    const db = new Database("postgresql://example/talorys");
    mock.query.mockResolvedValueOnce({ rows: [{ id: "one" }], rowCount: 1 });
    expect(await db.one("SELECT ?, ?, ?, ?, ?", "'; DROP TABLE tal_notes; --", undefined, true, false, { a: 1 })).toEqual({ id: "one" });
    expect(mock.query).toHaveBeenCalledWith("SELECT $1, $2, $3, $4, $5", ["'; DROP TABLE tal_notes; --", null, 1, 0, '{"a":1}']);
    expect(mock.clients[0]!.end).toHaveBeenCalledOnce();
    expect(await db.run("DELETE FROM tal_notes")).toEqual({ changes: 0 });
    expect(mock.clients).toHaveLength(2);
  });

  it("sanitizes invalid connection string errors raised during client construction", async () => {
    mock.construct.mockImplementationOnce(() => { throw new Error("Invalid postgres://secret:password@private-host"); });
    await expect(new Database("invalid").all("SELECT 1")).rejects.toThrow(new DatabaseError());
    expect(mock.clients).toHaveLength(0);
  });

  it("returns empty results and normalizes safe bigint aggregates", async () => {
    const db = new Database("postgresql://example/talorys");
    expect(await db.one("SELECT 1 WHERE false")).toBeNull();
    const parser = mock.clients[0]!.config.types.getTypeParser(20);
    expect(parser("42")).toBe(42);
    expect(parser("1791694800000")).toBe(1791694800000);
    expect(() => parser("9007199254740992")).toThrow(/safe integer/);
  });

  it("sanitizes connection and SQL errors, including nested credential-bearing details", async () => {
    const db = new Database("postgresql://secret:password@example/talorys");
    const raw = Object.assign(new Error("postgresql://secret:password@example; private row"), { code: "23505", detail: "private row" });
    mock.query.mockRejectedValueOnce(raw);
    await expect(db.run("SELECT ?", "private row")).rejects.toMatchObject({ name: "DatabaseError", code: "23505", message: "PostgreSQL operation failed (SQLSTATE 23505)." });
    mock.connect.mockRejectedValueOnce(new Error("password at secret hostname"));
    await expect(db.all("SELECT 1")).rejects.toThrow(new DatabaseError());
    expect(mock.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });
});

describe("PostgreSQL async transactions", () => {
  it("pins all awaited and nested work to one client", async () => {
    const db = new Database("postgresql://example/talorys");
    const result = await db.transaction(async () => {
      await db.run("INSERT INTO a VALUES (?)", 1);
      await db.transaction(async () => { await db.run("UPDATE a SET b = ?", 2); });
      return 42;
    });
    expect(result).toBe(42);
    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0]!.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "INSERT INTO a VALUES ($1)", "UPDATE a SET b = $1", "COMMIT"]);
    expect(mock.clients[0]!.end).toHaveBeenCalledOnce();
  });

  it("isolates simultaneous transactions and standalone queries", async () => {
    const db = new Database("postgresql://example/talorys");
    const firstReady = deferred();
    const releaseFirst = deferred();
    const first = db.transaction(async () => {
      await db.run("SELECT 'first-before'");
      firstReady.resolve();
      await releaseFirst.promise;
      await db.run("SELECT 'first-after'");
    });
    await firstReady.promise;
    await db.transaction(async () => { await db.run("SELECT 'second'"); });
    await db.run("SELECT 'standalone'");
    releaseFirst.resolve();
    await first;
    expect(mock.clients).toHaveLength(3);
    expect(mock.clients[0]!.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT 'first-before'", "SELECT 'first-after'", "COMMIT"]);
    expect(mock.clients[1]!.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT 'second'", "COMMIT"]);
    expect(mock.clients[2]!.query.mock.calls.map(([sql]) => sql)).toEqual(["SELECT 'standalone'"]);
  });

  it("rolls back the whole transaction if a nested error is caught", async () => {
    const db = new Database("postgresql://example/talorys");
    await expect(db.transaction(async () => {
      await db.run("SELECT 1");
      try {
        await db.transaction(async () => { throw new Error("validation failed"); });
      } catch { /* outer caller cannot accidentally commit partial work */ }
    })).rejects.toThrow("validation failed");
    expect(mock.clients[0]!.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
  });

  it("does not silently commit after a caught SQL error", async () => {
    const db = new Database("postgresql://example/talorys");
    mock.query.mockImplementation(async (sql) => {
      if (sql === "BROKEN") throw Object.assign(new Error("private details"), { code: "42601" });
      return { rows: [], rowCount: 0 };
    });
    await expect(db.transaction(async () => {
      try { await db.run("BROKEN"); } catch { /* ignored */ }
    })).rejects.toThrow("SQLSTATE 42601");
    expect(mock.clients[0]!.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "BROKEN", "ROLLBACK"]);
  });

  it("rejects a COMMIT that PostgreSQL reports as ROLLBACK", async () => {
    mock.query.mockImplementation(async (sql) => ({ command: sql === "COMMIT" ? "ROLLBACK" : sql, rows: [], rowCount: 0 }));
    await expect(new Database("postgresql://example/talorys").transaction(async () => 1)).rejects.toThrow(/25P02/);
    expect(mock.clients[0]!.end).toHaveBeenCalledOnce();
  });

  it("rejects escaped asynchronous work after its transaction finished", async () => {
    const db = new Database("postgresql://example/talorys");
    const release = deferred();
    let escaped!: Promise<unknown>;
    await db.transaction(async () => {
      escaped = release.promise.then(() => db.run("SELECT 'too late'"));
    });
    release.resolve();
    await expect(escaped).rejects.toThrow(/already finished/);
    expect(mock.clients).toHaveLength(1);
  });
});

describe("PostgreSQL search and migrations", () => {
  it("builds bounded, deduplicated prefix OR terms without tsquery operators from input", () => {
    expect(ftsQuery("Please remember coffee coffee cafés 中文")).toBe("'coffee':* | 'cafés':* | '中文':*");
    expect(ftsQuery("the and I")).toBeNull();
    expect(ftsQuery("alpha | !beta:* & 'gamma'", 2)).toBe("'alpha':* | 'beta':*");
    expect(ftsQuery("alpha", 0)).toBeNull();
  });

  it("locks before creating/reading the schema and commits applied migrations", async () => {
    const db = new Database("postgresql://example/talorys");
    expect(await migrate(db, [{ version: 1, name: "test", statements: ["CREATE TABLE example (id INTEGER)"] }])).toBe(1);
    const queries = mock.clients[0]!.query.mock.calls.map(([sql]) => sql);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toBe("SELECT pg_advisory_xact_lock(1952541807, 0)");
    expect(queries[2]).toContain("CREATE TABLE IF NOT EXISTS tal_schema");
    expect(queries[3]).toContain("SELECT version");
    expect(queries[4]).toBe("CREATE TABLE example (id INTEGER)");
    expect(queries[5]).toContain("VALUES (1, $1, $2)");
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("skips migrations already committed", async () => {
    mock.query.mockImplementation(async (sql) => ({ rows: sql.startsWith("SELECT version") ? [{ version: 2 }] : [], rowCount: 0 }));
    expect(await migrate(new Database("postgresql://example/talorys"))).toBe(2);
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("CREATE TABLE IF NOT EXISTS tal_notes"))).toBe(false);
  });

  it("rolls back a failing migration without advancing its version", async () => {
    mock.query.mockImplementation(async (sql) => {
      if (sql === "BROKEN") throw Object.assign(new Error("syntax error"), { code: "42601" });
      return { rows: [], rowCount: 0 };
    });
    await expect(migrate(new Database("postgresql://example/talorys"), [{ version: 3, name: "broken", statements: ["BROKEN"] }])).rejects.toThrow(/42601/);
    const queries = mock.query.mock.calls.map(([sql]) => sql);
    expect(queries).not.toContain(expect.stringContaining("INSERT INTO tal_schema"));
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("uses PostgreSQL identities, millisecond bigint and generated GIN search indexes", () => {
    const schema = MIGRATIONS.flatMap((m) => m.statements).join("\n");
    expect(schema).toContain("sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE");
    expect(schema).toContain("at BIGINT NOT NULL");
    expect(schema).toContain("TSVECTOR GENERATED ALWAYS AS");
    expect(schema).toContain("USING GIN (search_vector)");
    expect(schema).toContain("setweight(to_tsvector('simple', title), 'A')");
    expect(schema).not.toMatch(/VIRTUAL TABLE|fts5|AUTOINCREMENT|CREATE TRIGGER/);
  });
});
