import type { Memory, MemoryCategory } from "@talorys/shared";
import { type Database, ftsQuery, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class MemoryRepository {
  constructor(private readonly db: Database) {}

  async list(opts: { category?: string; q?: string; limit?: number } = {}): Promise<Memory[]> {
    if (opts.q) return await this.search(opts.q, opts.limit ?? 100, opts.category);
    const params: unknown[] = [];
    let where = "";
    if (opts.category) {
      where = "WHERE category = ?";
      params.push(opts.category);
    }
    return await this.db.all<Memory>(
      `SELECT id, content, category, source, created_at, updated_at FROM tal_memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      opts.limit ?? 500,
    );
  }

  /** PostgreSQL full-text prefix search; falls back to ILIKE for queries without indexable terms. */
  async search(q: string, limit = 10, category?: string): Promise<Memory[]> {
    const match = ftsQuery(q);
    if (match) {
      return await this.db.all<Memory>(
        `SELECT m.id, m.content, m.category, m.source, m.created_at, m.updated_at
         FROM tal_memories m, to_tsquery('simple', ?) AS query
         WHERE m.search_vector @@ query ${category ? "AND m.category = ?" : ""}
         ORDER BY ts_rank(m.search_vector, query) DESC, m.updated_at DESC LIMIT ?`,
        ...(category ? [match, category, limit] : [match, limit]),
      );
    }
    return await this.db.all<Memory>(
      `SELECT id, content, category, source, created_at, updated_at FROM tal_memories WHERE content ILIKE ? ESCAPE '\\' ${category ? "AND category = ?" : ""}
       ORDER BY updated_at DESC LIMIT ?`,
      ...(category ? [likePattern(q), category, limit] : [likePattern(q), limit]),
    );
  }

  async get(id: string): Promise<Memory | null> {
    return await this.db.one<Memory>(`SELECT id, content, category, source, created_at, updated_at FROM tal_memories WHERE id = ?`, id);
  }

  async require(id: string): Promise<Memory> {
    const m = await this.get(id);
    if (!m) throw new NotFoundError("Memory not found");
    return m;
  }

  async create(input: { content: string; category?: MemoryCategory; source?: Memory["source"] }): Promise<Memory> {
    const content = input.content.trim();
    // Avoid storing exact duplicates; refresh the existing entry instead.
    const dup = await this.db.one<Memory>(`SELECT id, content, category, source, created_at, updated_at FROM tal_memories WHERE lower(content) = lower(?)`, content);
    if (dup) {
      const ts = now();
      await this.db.run(`UPDATE tal_memories SET updated_at = ? WHERE id = ?`, ts, dup.id);
      return { ...dup, updated_at: ts };
    }
    const ts = now();
    const memory: Memory = {
      id: newId(),
      content,
      category: input.category ?? "other",
      source: input.source ?? "manual",
      created_at: ts,
      updated_at: ts,
    };
    await this.db.run(
      `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      memory.id, memory.content, memory.category, memory.source, memory.created_at, memory.updated_at,
    );
    return memory;
  }

  async update(id: string, patch: { content?: string; category?: MemoryCategory }): Promise<Memory> {
    const existing = await this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    await this.db.run(
      `UPDATE tal_memories SET content = ?, category = ?, updated_at = ? WHERE id = ?`,
      next.content.trim(), next.category, next.updated_at, id,
    );
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.db.run(`DELETE FROM tal_memories WHERE id = ?`, id);
  }

  async clear(): Promise<number> {
    return (await this.db.run(`DELETE FROM tal_memories`)).changes;
  }

  async count(): Promise<number> {
    return Number((await this.db.one<{ n: number | string }>(`SELECT count(*) AS n FROM tal_memories`))?.n ?? 0);
  }
}
