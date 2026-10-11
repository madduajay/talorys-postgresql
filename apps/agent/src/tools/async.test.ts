import { describe, expect, it, vi } from "vitest";
import type { Memory, Task } from "@talorys/shared";
import type { Services } from "../services/container";
import { selectRelevantMemories } from "../agent/memory";
import { ALL_TOOLS, runApprovedAction, ToolExecutor } from "./index";

const task: Task = {
  id: "task-1", title: "Test task", description: "", status: "todo", priority: "medium",
  due_at: null, project_id: null, created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z", completed_at: null,
};

function context(services: unknown) {
  return { services: services as Services, timezone: "UTC", mode: "chat" as const, conversationId: "conversation-1" };
}

function executor(services: unknown) {
  return new ToolExecutor(ALL_TOOLS, context(services), { maxToolCalls: 10 });
}

describe("async agent storage boundaries", () => {
  it("waits for task creation and its activity record before reporting success", async () => {
    let finishRecord!: () => void;
    const record = vi.fn(() => new Promise<void>((resolve) => { finishRecord = resolve; }));
    const create = vi.fn().mockResolvedValue(task);
    const services = { tasks: { create }, projects: { resolve: vi.fn().mockResolvedValue({ id: "project-1" }) }, activity: { record } };
    let completed = false;
    const operation = executor(services).execute("create_task", { title: "Test task", project: "Test" }).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ project_id: "project-1" }));
    finishRecord();
    await expect(operation).resolves.toMatchObject({ created: { id: "task-1", title: "Test task" } });
  });

  it("resolves asynchronous lists before assembling search and project results", async () => {
    const services = {
      tasks: { list: vi.fn().mockResolvedValue([task]) },
      notes: { search: vi.fn().mockResolvedValue([{ id: "note-1", title: "Note", content: "Content" }]) },
      memories: { search: vi.fn().mockResolvedValue([{ id: "memory-1", content: "Preference" }]) },
      conversations: { list: vi.fn().mockResolvedValue([{ id: "conversation-1", title: "Conversation" }]) },
      projects: { list: vi.fn().mockResolvedValue([{ id: "project-1", name: "Project", status: "active", description: "" }]) },
    };
    const ex = executor(services);
    await expect(ex.execute("search", { query: "Test" })).resolves.toMatchObject({
      tasks: [{ id: "task-1" }], notes: [{ id: "note-1" }],
      memories: [{ id: "memory-1" }], conversations: [{ id: "conversation-1" }],
    });
    await expect(ex.execute("list_projects", {})).resolves.toMatchObject({ projects: [{ id: "project-1" }] });
  });

  it("does not delete before approval and awaits persisted approval and deletion", async () => {
    let status = "pending";
    const action = { id: "action-1", summary: "Delete task", status: "pending", error: null, expires_at: "2099-01-01T00:00:00.000Z" };
    const remove = vi.fn().mockResolvedValue(undefined);
    const services = {
      tasks: { resolve: vi.fn().mockResolvedValue(task), get: vi.fn().mockResolvedValue(task), delete: remove },
      activity: { record: vi.fn().mockResolvedValue(undefined) },
      pendingActions: {
        create: vi.fn().mockResolvedValue(action),
        get: vi.fn().mockResolvedValue({ ...action, tool: "delete_task", target_id: task.id }),
        resolve: vi.fn(async () => {
          if (status !== "pending") return false;
          status = "approved";
          return true;
        }),
        view: vi.fn(async () => ({ ...action, status })),
        markFailed: vi.fn().mockResolvedValue(undefined),
      },
    };
    const ex = executor(services);
    await expect(ex.execute("delete_task", { task: task.id }, "call-1")).resolves.toMatchObject({ status: "awaiting_owner_approval" });
    expect(ex.approvalFor("call-1")).toEqual(action);
    expect(remove).not.toHaveBeenCalled();
    await expect(runApprovedAction(ALL_TOOLS, context(services), action.id)).resolves.toMatchObject({ status: "approved" });
    expect(remove).toHaveBeenCalledExactlyOnceWith(task.id);
    await expect(runApprovedAction(ALL_TOOLS, context(services), action.id)).rejects.toThrow("already handled");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("awaits both memory sources and deduplicates matching preferences", async () => {
    const memory = { id: "memory-1", content: "Likes tea", category: "preference" } as Memory;
    const services = { memories: { search: vi.fn().mockResolvedValue([memory]), list: vi.fn().mockResolvedValue([memory]) } };
    await expect(selectRelevantMemories(context(services).services.memories, "tea")).resolves.toEqual([memory]);
  });
});
