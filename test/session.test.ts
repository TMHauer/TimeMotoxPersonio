import test from "node:test";
import assert from "node:assert/strict";
import { computeAutoClose } from "../src/session.js";

test("autoClose is min(start+12h, 23:59)", () => {
  const start = "2026-02-02T17:00:00";
  const auto = computeAutoClose(start);
  // 12h later would be next day 05:00, so clamp to 23:59 same day
  assert.equal(auto, "2026-02-02T23:59:00");
});

test("autoClose within day uses +12h", () => {
  const start = "2026-02-02T08:00:00";
  const auto = computeAutoClose(start);
  assert.equal(auto, "2026-02-02T20:00:00");
});
