import { describe, it, expect } from "vitest";
import {
  validateReport,
  feedbackBytes,
  feedbackLimit,
  type FeedbackReport,
} from "../src/feedback-report";
const report = (): FeedbackReport => ({
  version: 1,
  id: "a".repeat(32),
  capturedAt: new Date().toISOString(),
  release: "old-build",
  environment: "test",
  message: "Falscher Hinweis",
});
describe("feedback report", () => {
  it("accepts text-only reports without route or image", () => {
    expect(() => validateReport(report())).not.toThrow();
  });
  it("rejects empty and oversized messages", () => {
    for (const message of ["  ", "x".repeat(5001)])
      expect(() => validateReport({ ...report(), message })).toThrow();
  });
  it("bounds bytes including image data", () => {
    const value = {
      ...report(),
      image: new Blob([new Uint8Array(feedbackLimit)]),
    };
    expect(feedbackBytes(value)).toBeGreaterThan(feedbackLimit);
    expect(() => validateReport(value)).toThrow("5 MiB");
  });
  it("rejects invalid identities and timestamps", () => {
    expect(() => validateReport({ ...report(), id: "bad" })).toThrow();
    expect(() => validateReport({ ...report(), capturedAt: "bad" })).toThrow();
  });
});
