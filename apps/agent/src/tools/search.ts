import { z } from "zod";
import { defineTool } from "./registry";
import { presentTask } from "./tasks";

export const searchTools = [
  defineTool({
    name: "search",
    description: "Search across the owner's tasks, notes, memories and past conversations at once.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({ query: z.string().min(1).max(200) }),
    label: (i) => `Searching for “${i.query}”`,
    execute: async (i, ctx) => {
      const s = ctx.services;
      const [tasks, notes, memories, conversations] = await Promise.all([
        s.tasks.list({ q: i.query, limit: 5 }),
        s.notes.search(i.query, 5),
        s.memories.search(i.query, 5),
        s.conversations.list({ q: i.query, limit: 5 }),
      ]);
      return {
        tasks: tasks.map((t) => presentTask(t, ctx.timezone)),
        notes: notes.map((n) => ({ id: n.id, title: n.title, excerpt: n.content.slice(0, 200) })),
        memories: memories.map((m) => ({ id: m.id, content: m.content })),
        conversations: conversations.map((c) => ({ id: c.id, title: c.title })),
      };
    },
  }),
];
