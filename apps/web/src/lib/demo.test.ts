import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { DemoAuthError, demoErrorMessage } from "./demo";

describe("demoErrorMessage", () => {
  it("explains a busy or unconfigured demo", () => {
    expect(demoErrorMessage(new ApiError(503, "x"))).toBe(
      "The demo is busy right now — try again tomorrow."
    );
  });

  it("tells a signed-in user why there is no demo for them", () => {
    expect(demoErrorMessage(new ApiError(403, "x"))).toBe(
      "You're signed in, so there's no demo to start — your own spaces are on the home page."
    );
  });

  it("explains anonymous sign-in being unavailable", () => {
    expect(demoErrorMessage(new DemoAuthError("Anonymous sign-ins are disabled"))).toBe(
      "The demo isn't available right now."
    );
  });

  it("falls back to a retryable message", () => {
    expect(demoErrorMessage(new Error("boom"))).toBe("Couldn't start the demo — try again.");
    expect(demoErrorMessage(new ApiError(0, "offline"))).toBe(
      "Couldn't start the demo — try again."
    );
  });
});
