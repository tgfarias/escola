import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import * as outbox from "../outbox/service";
import * as serviceDays from "../serviceDays/service";

const TOKEN = "test-jobs-token-with-at-least-32-chars";

afterEach(() => vi.restoreAllMocks());

describe("Cloud Scheduler job routes", () => {
  it("dispatches the outbox with the job token", async () => {
    const spy = vi.spyOn(outbox, "dispatchOutbox").mockResolvedValue({ schools: 2, delivered: 3, failed: 0, abandoned: 1 });
    const res = await buildApp().inject({ method: "POST", url: "/jobs/v1/outbox/dispatch", headers: { "x-job-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ schools: 2, delivered: 3, failed: 0, abandoned: 1 });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].schoolIds).toBeUndefined();
  });

  it("runs the safety close with the job token", async () => {
    const spy = vi.spyOn(serviceDays, "safetyClose").mockResolvedValue({ closed: 1, failed: 0 });
    const res = await buildApp().inject({ method: "POST", url: "/jobs/v1/service-days/safety-close", headers: { "x-job-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed: 1, failed: 0 });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("rejects a missing or wrong token without running anything", async () => {
    const spy = vi.spyOn(outbox, "dispatchOutbox");
    const app = buildApp();
    for (const headers of [{}, { "x-job-token": "nope" }, { authorization: `Bearer ${TOKEN}` }]) {
      const res = await app.inject({ method: "POST", url: "/jobs/v1/outbox/dispatch", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
