import { automationCreateSchema, automationUpdateSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body, query } from "../middleware";

export const automationRoutes = new Hono<AppEnv>();

automationRoutes.get("/automations", async (c) => {
  const s = c.env.agent.services;
  return c.json({
    automations: (await s.automations.list()),
    runs: (await s.automationsRepo.runs({ limit: 50 })),
    failed_runs: (await s.automationsRepo.runs({ limit: 20, status: "error" })),
    timezone: (await s.settings.get()).timezone,
  });
});

automationRoutes.post("/automations", async (c) => {
  const input = await body(c, automationCreateSchema);
  return c.json({ automation: await c.env.agent.services.automations.create(input) }, 201);
});

automationRoutes.patch("/automations/:id", async (c) => {
  const patch = await body(c, automationUpdateSchema);
  return c.json({ automation: await c.env.agent.services.automations.update(c.req.param("id"), patch) });
});

automationRoutes.delete("/automations/:id", async (c) => {
  await c.env.agent.services.automations.delete(c.req.param("id"));
  return c.json({ deleted: true });
});

// ---------- Notification center ----------

automationRoutes.get("/notifications", async (c) => {
  const { unread } = query(c, z.object({ unread: z.enum(["1", "0"]).optional() }));
  const s = c.env.agent.services;
  return c.json({ notifications: (await s.notifications.list({ unreadOnly: unread === "1" })), unread: (await s.notifications.unreadCount()) });
});

automationRoutes.post("/notifications/read", async (c) => {
  const { id } = await body(c, z.object({ id: z.string().max(64).optional() }));
  (await c.env.agent.services.notifications.markRead(id));
  await c.env.agent.refreshUnread();
  return c.json({ unread: (await c.env.agent.services.notifications.unreadCount()) });
});

automationRoutes.delete("/notifications/:id", async (c) => {
  (await c.env.agent.services.notifications.delete(c.req.param("id")));
  await c.env.agent.refreshUnread();
  return c.json({ deleted: true });
});
