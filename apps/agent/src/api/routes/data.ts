import {
  memoryCreateSchema,
  memoryUpdateSchema,
  MEMORY_CATEGORIES,
  noteCreateSchema,
  noteUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body, query } from "../middleware";
import { ValidationError } from "../errors";
import { localDayBounds } from "../../services/time";

/** Tasks, memories, notes and projects. None of these routes need AI. */
export const dataRoutes = new Hono<AppEnv>();

async function assertProject(c: { env: AppEnv["Bindings"] }, projectId: string | null | undefined) {
  if (projectId && !(await c.env.agent.services.projects.get(projectId))) throw new ValidationError("Project does not exist.");
}

// ---------- Tasks ----------

dataRoutes.get("/tasks", async (c) => {
  const q = query(c, taskListQuerySchema);
  const s = c.env.agent.services;
  const bounds = localDayBounds((await s.settings.get()).timezone);
  return c.json({ tasks: (await s.tasks.list({ ...q, dayStart: bounds.start, dayEnd: bounds.end })), today: bounds });
});

dataRoutes.post("/tasks", async (c) => {
  const input = await body(c, taskCreateSchema);
  await assertProject(c, input.project_id);
  return c.json({ task: (await c.env.agent.services.tasks.create(input)) }, 201);
});

dataRoutes.get("/tasks/:id", async (c) => c.json({ task: (await c.env.agent.services.tasks.require(c.req.param("id"))) }));

dataRoutes.patch("/tasks/:id", async (c) => {
  const patch = await body(c, taskUpdateSchema);
  await assertProject(c, patch.project_id);
  return c.json({ task: (await c.env.agent.services.tasks.update(c.req.param("id"), patch)) });
});

dataRoutes.delete("/tasks/:id", async (c) => {
  (await c.env.agent.services.tasks.delete(c.req.param("id")));
  return c.json({ deleted: true });
});

// ---------- Memories ----------

dataRoutes.get("/memories", async (c) => {
  const q = query(c, z.object({ q: z.string().max(200).optional(), category: z.enum(MEMORY_CATEGORIES).optional() }));
  const s = c.env.agent.services;
  return c.json({ memories: (await s.memories.list(q)), total: (await s.memories.count()) });
});

dataRoutes.post("/memories", async (c) => {
  const input = await body(c, memoryCreateSchema);
  return c.json({ memory: (await c.env.agent.services.memories.create({ ...input, source: "manual" })) }, 201);
});

dataRoutes.patch("/memories/:id", async (c) => {
  const patch = await body(c, memoryUpdateSchema);
  return c.json({ memory: (await c.env.agent.services.memories.update(c.req.param("id"), patch)) });
});

dataRoutes.delete("/memories/:id", async (c) => {
  (await c.env.agent.services.memories.delete(c.req.param("id")));
  return c.json({ deleted: true });
});

dataRoutes.delete("/memories", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  const s = c.env.agent.services;
  const deleted = (await s.memories.clear());
  (await s.activity.record("privacy.memories_cleared", `Cleared ${deleted} memories`));
  return c.json({ deleted });
});

// ---------- Notes ----------

dataRoutes.get("/notes", async (c) => {
  const q = query(c, z.object({ q: z.string().max(200).optional(), project_id: z.string().max(64).optional() }));
  return c.json({ notes: (await c.env.agent.services.notes.list(q)) });
});

dataRoutes.post("/notes", async (c) => {
  const input = await body(c, noteCreateSchema, 512 * 1024);
  await assertProject(c, input.project_id);
  return c.json({ note: (await c.env.agent.services.notes.create(input)) }, 201);
});

dataRoutes.get("/notes/:id", async (c) => c.json({ note: (await c.env.agent.services.notes.require(c.req.param("id"))) }));

dataRoutes.patch("/notes/:id", async (c) => {
  const patch = await body(c, noteUpdateSchema, 512 * 1024);
  await assertProject(c, patch.project_id);
  return c.json({ note: (await c.env.agent.services.notes.update(c.req.param("id"), patch)) });
});

dataRoutes.delete("/notes/:id", async (c) => {
  (await c.env.agent.services.notes.delete(c.req.param("id")));
  return c.json({ deleted: true });
});

// ---------- Projects ----------

dataRoutes.get("/projects", async (c) => c.json({ projects: (await c.env.agent.services.projects.list()) }));

dataRoutes.post("/projects", async (c) => {
  const input = await body(c, projectCreateSchema);
  return c.json({ project: (await c.env.agent.services.projects.create(input)) }, 201);
});

dataRoutes.patch("/projects/:id", async (c) => {
  const patch = await body(c, projectUpdateSchema);
  return c.json({ project: (await c.env.agent.services.projects.update(c.req.param("id"), patch)) });
});

dataRoutes.delete("/projects/:id", async (c) => {
  (await c.env.agent.services.projects.delete(c.req.param("id")));
  return c.json({ deleted: true });
});
