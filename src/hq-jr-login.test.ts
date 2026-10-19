import { describe, it, expect } from "vitest";
import { isHqJrLogin } from "./hq-jr-login.js";

describe("isHqJrLogin", () => {
  it("matches exact hq-jr and hq-jr[bot] logins", () => {
    expect(isHqJrLogin("hq-jr")).toBe(true);
    expect(isHqJrLogin("hq-jr[bot]")).toBe(true);
    expect(isHqJrLogin("HQ-JR")).toBe(true);
    expect(isHqJrLogin("HQ-JR[bot]")).toBe(true);
  });

  it("rejects substring lookalikes and empty values", () => {
    expect(isHqJrLogin("not-hq-jr")).toBe(false);
    expect(isHqJrLogin("hq-jr-helper")).toBe(false);
    expect(isHqJrLogin("hq-jr-extra[bot]")).toBe(false);
    expect(isHqJrLogin("greptile-apps[bot]")).toBe(false);
    expect(isHqJrLogin("")).toBe(false);
    expect(isHqJrLogin(null)).toBe(false);
    expect(isHqJrLogin(undefined)).toBe(false);
  });
});
