import { describe, it, expect } from "vitest";

describe("vaultscribe-log", () => {
  it("exports the logger and child logger factory", async () => {
    const mod = await import("./vaultscribe-log.js");
    expect(mod.vaultscribeLog).toBeDefined();
    expect(typeof mod.vaultscribeLog.info).toBe("function");
    expect(typeof mod.createChildLog).toBe("function");
  });

  it("creates a child logger with bound context", async () => {
    const { createChildLog } = await import("./vaultscribe-log.js");
    const child = createChildLog({ tool: "test_tool" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
  });
});
