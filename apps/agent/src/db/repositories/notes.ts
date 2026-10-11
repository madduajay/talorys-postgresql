import type { Note, Project } from "@talorys/shared";
import { type Database, ftsQuery, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class NoteRepository {
  constructor(private readonly db: Database) {}

  async list(opts: { q?: string; project_id?: string; limit?: number } = {}): Promise<Note[]> {
    if (opts.q) return await this.search(opts.q, opts.limit ?? 50);
    const params: unknown[] = [];
    let where = "";
    if (opts.project_id) {
      where = "WHERE project_id = ?";
      params.push(opts.project_id);
    }
    return await this.db.all<Note>(`SELECT id, title, content, project_id, created_at, updated_at FROM tal_notes ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, opts.limit ?? 500);
  }

  async search(q: string, limit = 20): Promise<Note[]> {
    const match = ftsQuery(q);
    if (match) {
      return await this.db.all<Note>(
        `SELECT n.id, n.title, n.content, n.project_id, n.created_at, n.updated_at
         FROM tal_notes n, to_tsquery('simple', ?) AS query
         WHERE n.search_vector @@ query ORDER BY ts_rank(n.search_vector, query) DESC, n.updated_at DESC LIMIT ?`,
        match,
        limit,
      );
    }
    return await this.db.all<Note>(
      `SELECT id, title, content, project_id, created_at, updated_at FROM tal_notes WHERE title ILIKE ? ESCAPE '\\' OR content ILIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
      likePattern(q), likePattern(q), limit,
    );
  }

  async get(id: string): Promise<Note | null> {
    return await this.db.one<Note>(`SELECT id, title, content, project_id, created_at, updated_at FROM tal_notes WHERE id = ?`, id);
  }

  async require(id: string): Promise<Note> {
    const n = await this.get(id);
    if (!n) throw new NotFoundError("Note not found");
    return n;
  }

  async create(input: { title: string; content?: string; project_id?: string | null }): Promise<Note> {
    const ts = now();
    const note: Note = {
      id: newId(),
      title: input.title.trim(),
      content: input.content ?? "",
      project_id: input.project_id ?? null,
      created_at: ts,
      updated_at: ts,
    };
    await this.db.run(
      `INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      note.id, note.title, note.content, note.project_id, note.created_at, note.updated_at,
    );
    return note;
  }

  async update(id: string, patch: { title?: string; content?: string; project_id?: string | null }): Promise<Note> {
    const existing = await this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    await this.db.run(
      `UPDATE tal_notes SET title = ?, content = ?, project_id = ?, updated_at = ? WHERE id = ?`,
      next.title, next.content, next.project_id, next.updated_at, id,
    );
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.db.run(`DELETE FROM tal_notes WHERE id = ?`, id);
  }
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  async list(opts: { status?: string } = {}): Promise<Project[]> {
    if (opts.status) {
      return await this.db.all<Project>(`SELECT * FROM tal_projects WHERE status = ? ORDER BY updated_at DESC`, opts.status);
    }
    return await this.db.all<Project>(`SELECT * FROM tal_projects ORDER BY status = 'archived', updated_at DESC`);
  }

  async get(id: string): Promise<Project | null> {
    return await this.db.one<Project>(`SELECT * FROM tal_projects WHERE id = ?`, id);
  }

  async require(id: string): Promise<Project> {
    const p = await this.get(id);
    if (!p) throw new NotFoundError("Project not found");
    return p;
  }

  async resolve(ref: string): Promise<Project | null> {
    return (
      await this.get(ref) ??
      await this.db.one<Project>(`SELECT * FROM tal_projects WHERE lower(name) = lower(?)`, ref.trim()) ??
      null
    );
  }

  async create(input: { name: string; description?: string; status?: Project["status"] }): Promise<Project> {
    const ts = now();
    const project: Project = {
      id: newId(),
      name: input.name.trim(),
      description: input.description ?? "",
      status: input.status ?? "active",
      created_at: ts,
      updated_at: ts,
    };
    await this.db.run(
      `INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      project.id, project.name, project.description, project.status, project.created_at, project.updated_at,
    );
    return project;
  }

  async update(id: string, patch: { name?: string; description?: string; status?: Project["status"] }): Promise<Project> {
    const existing = await this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    await this.db.run(
      `UPDATE tal_projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`,
      next.name, next.description, next.status, next.updated_at, id,
    );
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.db.transaction(async () => {
      await this.db.run(`UPDATE tal_tasks SET project_id = NULL WHERE project_id = ?`, id);
      await this.db.run(`UPDATE tal_notes SET project_id = NULL WHERE project_id = ?`, id);
      await this.db.run(`DELETE FROM tal_projects WHERE id = ?`, id);
    });
  }
}
