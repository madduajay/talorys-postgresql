import { changePasswordSchema, loginSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { body, clientId, readSessionToken, sessionCookie } from "../middleware";
import { AppError } from "../errors";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", async (c) => {
  const { password } = await body(c, loginSchema, 4096);
  const auth = c.env.agent.services.auth;
  const { token, expiresAt } = await auth.login(password, clientId(c), c.req.header("user-agent") ?? "");
  (await c.env.agent.services.activity.record("auth.login", "Signed in"));
  c.header("set-cookie", sessionCookie(c, token, expiresAt));
  return c.json({ authenticated: true, expires_at: expiresAt.toISOString() });
});

authRoutes.post("/logout", async (c) => {
  const sessionId = c.get("sessionId");
  if (sessionId) (await c.env.agent.services.auth.revoke(sessionId));
  c.header("set-cookie", sessionCookie(c, "", null));
  return c.json({ authenticated: false });
});

authRoutes.get("/session", async (c) => {
  const s = c.env.agent.services;
  const authenticated = !!c.get("sessionId");
  if (!authenticated && readSessionToken(c)) c.header("set-cookie", sessionCookie(c, "", null));
  const settings = (await s.settings.get());
  return c.json({
    authenticated,
    configured: s.auth.isConfigured(),
    agent_name: authenticated ? settings.agentName : undefined,
    theme: authenticated ? settings.theme : undefined,
  });
});

authRoutes.get("/sessions", async (c) => c.json({ sessions: (await c.env.agent.services.auth.listSessions(c.get("sessionId"))) }));

authRoutes.delete("/sessions/:id", async (c) => {
  const ok = (await c.env.agent.services.auth.revokeByPublicId(c.req.param("id")));
  if (!ok) throw new AppError("NOT_FOUND", "Session not found");
  return c.json({ revoked: true });
});

authRoutes.post("/sessions/revoke-others", async (c) => {
  const count = (await c.env.agent.services.auth.revokeAllExcept(c.get("sessionId")));
  return c.json({ revoked: count });
});

authRoutes.post("/password", async (c) => {
  const input = await body(c, changePasswordSchema, 4096);
  const s = c.env.agent.services;
  await s.auth.changePassword(input.current_password, input.new_password, c.get("sessionId"), clientId(c));
  (await s.activity.record("auth.password_changed", "Password changed; other sessions signed out"));
  return c.json({ changed: true });
});
