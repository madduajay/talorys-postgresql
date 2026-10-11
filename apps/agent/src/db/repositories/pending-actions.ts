import type { ChatMessage, PendingAction } from "@talorys/shared";
import { type Database, newId, now } from "../database";

/** How long the owner has to approve a proposed destructive action. */
export const PENDING_ACTION_TTL_MS = 30 * 60_000;

export interface StoredPendingAction {
  id: string;
  conversation_id: string;
  tool: string;
  target_id: string;
  summary: string;
  status: "pending" | "approved" | "cancelled" | "failed";
  error: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

function present(row: StoredPendingAction): PendingAction {
  const expired = row.status === "pending" && row.expires_at <= now();
  return { id: row.id, summary: row.summary, status: expired ? "expired" : row.status, error: row.error, expires_at: row.expires_at };
}

/**
 * Destructive actions proposed by the agent. The agent can only create them; running one
 * requires the owner to approve that exact id through the API.
 */
export class PendingActionRepository {
  constructor(private readonly db: Database) {}

  async create(input: { conversation_id: string; tool: string; target_id: string; summary: string }): Promise<PendingAction> {
    const createdAt = now();
    const row: StoredPendingAction = {
      id: newId(),
      ...input,
      status: "pending",
      error: null,
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + PENDING_ACTION_TTL_MS).toISOString(),
      resolved_at: null,
    };
    await this.db.run(
      `INSERT INTO tal_pending_actions (id, conversation_id, tool, target_id, summary, status, error, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      row.id, row.conversation_id, row.tool, row.target_id, row.summary, row.created_at, row.expires_at,
    );
    await this.db.run(`DELETE FROM tal_pending_actions WHERE created_at < ?`, new Date(Date.now() - 30 * 86_400_000).toISOString());
    return present(row);
  }

  async get(id: string): Promise<StoredPendingAction | null> {
    return await this.db.one<StoredPendingAction>(`SELECT * FROM tal_pending_actions WHERE id = ?`, id);
  }

  async view(id: string): Promise<PendingAction | null> {
    const row = await this.get(id);
    return row ? present(row) : null;
  }

  /**
   * Atomically moves a pending, unexpired action to `status`. Returns false if it was
   * already resolved or has expired, so an action can run at most once.
   */
  async resolve(id: string, status: "approved" | "cancelled"): Promise<boolean> {
    const at = now();
    return (
      (await this.db.run(
        `UPDATE tal_pending_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        status, at, id, at,
      )).changes === 1
    );
  }

  /** Refreshes approval cards stored on messages with each action's current status. */
  async withCurrentStatus(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const ids = [...new Set(messages.flatMap((message) =>
      message.tools.flatMap((tool) => tool.approval ? [tool.approval.id] : []),
    ))];
    if (ids.length === 0) return messages;
    // Batch status reads rather than opening one PostgreSQL connection per approval card.
    const rows = await this.db.all<StoredPendingAction>(
      `SELECT * FROM tal_pending_actions WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );
    const actions = new Map(rows.map((row) => [row.id, present(row)]));
    return messages.map((message) => ({
      ...message,
      tools: message.tools.map((tool) => tool.approval
        ? { ...tool, approval: actions.get(tool.approval.id) ?? tool.approval }
        : tool),
    }));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.run(`UPDATE tal_pending_actions SET status = 'failed', error = ? WHERE id = ?`, error.slice(0, 300), id);
  }
}
