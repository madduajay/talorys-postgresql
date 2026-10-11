import type { ChatMessage, Conversation, ToolActivity } from "@talorys/shared";
import { type Database, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  tools: string;
  status: ChatMessage["status"];
  error: string | null;
  created_at: string;
}

export interface ConversationRecord extends Conversation {
  summary: string | null;
  summary_upto: string | null;
}

function toMessage(row: MessageRow): ChatMessage {
  let tools: ToolActivity[] = [];
  try {
    tools = JSON.parse(row.tools) as ToolActivity[];
  } catch {
    tools = [];
  }
  return { id: row.id, conversation_id: row.conversation_id, role: row.role, content: row.content, tools, status: row.status, error: row.error, created_at: row.created_at };
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  async list(opts: { q?: string; limit?: number } = {}): Promise<Conversation[]> {
    if (opts.q) {
      const pattern = likePattern(opts.q);
      return await this.db.all<Conversation>(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT count(*)::integer FROM tal_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM tal_conversations c
         WHERE c.title ILIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM tal_messages m WHERE m.conversation_id = c.id AND m.content ILIKE ? ESCAPE '\\')
         ORDER BY c.updated_at DESC LIMIT ?`,
        pattern, pattern, opts.limit ?? 50,
      );
    }
    return await this.db.all<Conversation>(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
         (SELECT count(*)::integer FROM tal_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM tal_conversations c ORDER BY c.updated_at DESC LIMIT ?`,
      opts.limit ?? 200,
    );
  }

  async get(id: string): Promise<ConversationRecord | null> {
    return await this.db.one<ConversationRecord>(`SELECT * FROM tal_conversations WHERE id = ?`, id);
  }

  async require(id: string): Promise<ConversationRecord> {
    const c = await this.get(id);
    if (!c) throw new NotFoundError("Conversation not found");
    return c;
  }

  async create(title = "New conversation"): Promise<ConversationRecord> {
    const ts = now();
    const c: ConversationRecord = { id: newId(), title, created_at: ts, updated_at: ts, summary: null, summary_upto: null };
    await this.db.run(
      `INSERT INTO tal_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      c.id, c.title, c.created_at, c.updated_at,
    );
    return c;
  }

  async rename(id: string, title: string): Promise<ConversationRecord> {
    await this.require(id);
    await this.db.run(`UPDATE tal_conversations SET title = ?, updated_at = ? WHERE id = ?`, title, now(), id);
    return await this.require(id);
  }

  async touch(id: string): Promise<void> {
    await this.db.run(`UPDATE tal_conversations SET updated_at = ? WHERE id = ?`, now(), id);
  }

  async setSummary(id: string, summary: string, upto: string): Promise<void> {
    await this.db.run(`UPDATE tal_conversations SET summary = ?, summary_upto = ? WHERE id = ?`, summary, upto, id);
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.db.transaction(async () => {
      await this.db.run(`DELETE FROM tal_messages WHERE conversation_id = ?`, id);
      await this.db.run(`DELETE FROM tal_conversations WHERE id = ?`, id);
    });
  }

  async deleteAll(): Promise<number> {
    return await this.db.transaction(async () => {
      await this.db.run(`DELETE FROM tal_messages`);
      return (await this.db.run(`DELETE FROM tal_conversations`)).changes;
    });
  }

  async messages(conversationId: string, opts: { limit?: number; after?: string } = {}): Promise<ChatMessage[]> {
    const rows = opts.after
      ? await this.db.all<MessageRow>(
          `SELECT * FROM tal_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC, sequence ASC`,
          conversationId, opts.after,
        )
      : await this.db.all<MessageRow>(
          `SELECT * FROM (SELECT * FROM tal_messages WHERE conversation_id = ? ORDER BY created_at DESC, sequence DESC LIMIT ?) AS recent_messages
           ORDER BY created_at ASC, sequence ASC`,
          conversationId, opts.limit ?? 500,
        );
    return rows.map(toMessage);
  }

  async addMessage(input: {
    conversation_id: string;
    role: "user" | "assistant";
    content: string;
    tools?: ToolActivity[];
    status?: ChatMessage["status"];
    error?: string | null;
    id?: string;
  }): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: input.id ?? newId(),
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      tools: input.tools ?? [],
      status: input.status ?? "complete",
      error: input.error ?? null,
      created_at: now(),
    };
    await this.db.run(
      `INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id, message.conversation_id, message.role, message.content, JSON.stringify(message.tools),
      message.status, message.error, message.created_at,
    );
    await this.touch(input.conversation_id);
    return message;
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.run(`DELETE FROM tal_messages WHERE id = ?`, id);
  }

  async lastMessage(conversationId: string): Promise<ChatMessage | null> {
    const row = await this.db.one<MessageRow>(
      `SELECT * FROM tal_messages WHERE conversation_id = ? ORDER BY created_at DESC, sequence DESC LIMIT 1`,
      conversationId,
    );
    return row ? toMessage(row) : null;
  }
}
