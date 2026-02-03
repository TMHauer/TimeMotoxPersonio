import { describe, it, expect } from "vitest";
import { computeAutoClose } from "../src/session";

describe("computeAutoClose", () => {
  it("closes within 12h or day end", () => {
    const start = Date.UTC(2026, 1, 2, 8, 0, 0); // 2026-02-02 08:00Z
    const { autoCloseAtUtc } = computeAutoClose(start);
    expect(autoCloseAtUtc).toBeGreaterThan(start);
    expect(autoCloseAtUtc).toBeLessThanOrEqual(start + 12 * 3600_000);
  });
});
