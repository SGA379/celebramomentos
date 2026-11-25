import { afterEach, describe, expect, it } from "vitest";
import { podEnvironmentProblem, podMode } from "@/lib/pod/config";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("POD environment separation", () => {
  it("uses live mode only when Vercel production explicitly opts in", () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.POD_ORDER_MODE;
    expect(podMode()).toBe("live");
    expect(podEnvironmentProblem()).toMatch(/POD_ORDER_MODE=live/);
    process.env.POD_ORDER_MODE = "live";
    expect(podEnvironmentProblem()).toBeNull();
  });

  it("keeps local mode in draft and rejects a local live setting", () => {
    delete process.env.VERCEL_ENV;
    process.env.POD_ORDER_MODE = "live";
    expect(podMode()).toBe("live");
    expect(podEnvironmentProblem()).toMatch(/Local development/);
    process.env.POD_ORDER_MODE = "draft";
    expect(podMode()).toBe("draft");
    expect(podEnvironmentProblem()).toBeNull();
  });
});
