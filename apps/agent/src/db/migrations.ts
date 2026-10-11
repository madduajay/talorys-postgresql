import type { Database } from "./database";

/**
 * Versioned, append-only PostgreSQL schema migrations for Talorys data.
 * This fork starts a separate PostgreSQL lineage. Existing SQLite deployments
 * move application records through the portable backup import, not these DDLs.
 *
 * Rules:
 *  - Never edit or reorder an existing migration; add a new one.
 *  - Migrations must be non-destructive (no DROP of owner data).
 *  - All tables are prefixed `tal_` so they never collide with the
 *    Agents SDK's internal `cf_agents_*` tables.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS tal_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        summary_upto TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_messages (
        id TEXT PRIMARY KEY,
        sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES tal_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'complete',
        error TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tal_messages_conv ON tal_messages(conversation_id, created_at, sequence)`,
      `CREATE TABLE IF NOT EXISTS tal_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        due_at TEXT,
        project_id TEXT REFERENCES tal_projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tal_tasks_status_due ON tal_tasks(status, due_at)`,
      `CREATE TABLE IF NOT EXISTS tal_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', title), 'A') ||
          setweight(to_tsvector('simple', content), 'B')
        ) STORED,
        project_id TEXT REFERENCES tal_projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'scheduled',
        schedule_id TEXT,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        automation_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tal_runs_started ON tal_automation_runs(started_at)`,
      `CREATE TABLE IF NOT EXISTS tal_notifications (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        automation_id TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_activity (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS tal_login_attempts (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        client TEXT NOT NULL,
        success INTEGER NOT NULL,
        at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tal_login_attempts_at ON tal_login_attempts(at)`,
      `CREATE TABLE IF NOT EXISTS tal_usage_daily (
        day TEXT PRIMARY KEY,
        ai_requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        scheduled_ai_runs INTEGER NOT NULL DEFAULT 0,
        ai_errors INTEGER NOT NULL DEFAULT 0
      )`,
      // Generated vectors stay in sync on every INSERT/UPDATE, including imports.
      `CREATE INDEX IF NOT EXISTS tal_memories_search ON tal_memories USING GIN (search_vector)`,
      `CREATE INDEX IF NOT EXISTS tal_notes_search ON tal_notes USING GIN (search_vector)`,
    ],
  },
  {
    version: 2,
    name: "pending destructive actions",
    statements: [
      `CREATE TABLE IF NOT EXISTS tal_pending_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES tal_conversations(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','cancelled','failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Applies pending migrations and version updates in one transaction. A fixed
 * transaction-level advisory lock serializes startup across Durable Objects and
 * Worker instances, including first creation of the version table. On failure,
 * all pending schema changes roll back and the previously committed version is
 * preserved. The lock is automatically released on commit, rollback or disconnect.
 */
export async function migrate(db: Database, migrations: Migration[] = MIGRATIONS): Promise<number> {
  return db.transaction(async () => {
    // A Talorys-specific namespace and lock ID; scoped to this PostgreSQL database.
    await db.run("SELECT pg_advisory_xact_lock(1952541807, 0)");
    await db.run(`CREATE TABLE IF NOT EXISTS tal_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    let version = await schemaVersion(db);
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      for (const statement of migration.statements) await db.run(statement);
      await db.run(
        `INSERT INTO tal_schema (id, version, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
        migration.version,
        new Date().toISOString(),
      );
      version = migration.version;
    }
    return version;
  });
}

export async function schemaVersion(db: Database): Promise<number> {
  return (await db.one<{ version: number }>(`SELECT version FROM tal_schema WHERE id = 1`))?.version ?? 0;
}
