import { describe, expect, it } from "vitest";
import adminPackage from "../../package.json";

describe("admin chart library", () => {
  it("uses Nivo chart packages instead of Recharts", () => {
    expect(adminPackage.dependencies).toMatchObject({
      "@nivo/bar": expect.any(String),
      "@nivo/line": expect.any(String),
      "@nivo/pie": expect.any(String)
    });
    expect(adminPackage.dependencies).not.toHaveProperty("recharts");
  });
});
