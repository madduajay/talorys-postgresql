import { describe, expect, it, vi } from "vitest";
import type { Automation } from "@talorys/shared";
import type { AutomationRepository } from "../db/repositories/automations";
import type { SettingsService } from "../services/settings";
import type { ActivityLog } from "../services/usage";
import { AutomationService } from "./scheduling";

describe("asynchronous automation callbacks", () => {
  it("uses an atomic claim before executing a schedule, ignoring concurrent duplicate callbacks", async () => {
    const automation = {
      id: "automation-1", name: "Reminder", kind: "reminder", message: "Test", enabled: true,
      status: "running", schedule_id: "schedule-1", next_run: "2020-01-01T00:00:00.000Z",
      schedule: { type: "once", at: "2020-01-01T00:00" }, run_count: 0,
    } as Automation;
    const claimRun = vi.fn().mockResolvedValueOnce(automation).mockResolvedValue(null);
    const startRun = vi.fn().mockResolvedValue({ id: "run-1" });
    const finishRun = vi.fn().mockResolvedValue(undefined);
    let current = automation;
    const update = vi.fn(async (_id, patch) => (current = { ...current, ...patch }));
    const repo = {
      claimRun, startRun, finishRun, update,
      get: vi.fn(async () => current),
      withLock: vi.fn(async (_id, fn) => fn()),
      pruneRuns: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AutomationService(
      repo as unknown as AutomationRepository,
      { get: vi.fn().mockResolvedValue({ timezone: "UTC" }) } as unknown as SettingsService,
      { record: vi.fn().mockResolvedValue(undefined) } as unknown as ActivityLog,
      { schedule: vi.fn(), cancel: vi.fn(), exists: vi.fn() },
    );
    const execute = vi.fn().mockResolvedValue({ status: "success", result: "Delivered" });
    await Promise.all([
      service.fire(automation.id, "schedule-1", execute),
      service.fire(automation.id, "schedule-1", execute),
    ]);
    expect(claimRun).toHaveBeenCalledTimes(2);
    expect(startRun).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(finishRun).toHaveBeenCalledExactlyOnceWith("run-1", "success", "Delivered", null);
    expect(update).toHaveBeenLastCalledWith(automation.id, { status: "completed", enabled: false, next_run: null, schedule_id: null });
  });
});
