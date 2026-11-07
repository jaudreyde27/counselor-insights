import { describe, expect, it } from "vitest";
import { GET } from "@/app/healthz/route";

describe("smoke", () => {
  it("test runner works", () => {
    expect(1 + 1).toBe(2);
  });

  it("/healthz returns ok and no student data", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
