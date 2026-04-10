import { describe, it, expect } from "vitest";

describe("markscribe-log", () => {
  it("exports the logger and child logger factory", async () => {
    const mod = await import("./markscribe-log.js");
    expect(mod.markscribeLog).toBeDefined();
    expect(typeof mod.markscribeLog.info).toBe("function");
    expect(typeof mod.createChildLog).toBe("function");
  });

  it("creates a child logger with bound context", async () => {
    const { createChildLog } = await import("./markscribe-log.js");
    const child = createChildLog({ tool: "test_tool" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
  });
});
