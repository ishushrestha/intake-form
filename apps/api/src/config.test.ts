import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_WEB_ORIGIN,
  assertProductionAdminPassword,
  isProduction,
  readHost,
  splitOrigins,
} from "./config.js";

describe("listen host", () => {
  it("defaults to 127.0.0.1 and keeps an explicit HOST", () => {
    expect(readHost(undefined)).toBe(DEFAULT_HOST);
    expect(readHost("")).toBe("127.0.0.1");
    expect(readHost("  ")).toBe("127.0.0.1");
    expect(readHost("0.0.0.0")).toBe("0.0.0.0");
    expect(readHost(" 127.0.0.1 ")).toBe("127.0.0.1");
  });
});

describe("allowed origins", () => {
  it("splits comma-separated https origins", () => {
    expect(splitOrigins(undefined)).toEqual([DEFAULT_WEB_ORIGIN]);
    expect(splitOrigins("")).toEqual([DEFAULT_WEB_ORIGIN]);
    expect(splitOrigins("https://intake.example.duckdns.org")).toEqual([
      "https://intake.example.duckdns.org",
    ]);
    expect(splitOrigins("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("production admin password", () => {
  it("leaves development unchanged", () => {
    expect(isProduction("development")).toBe(false);
    expect(isProduction(undefined)).toBe(false);
    expect(() => assertProductionAdminPassword("development", undefined)).not.toThrow();
    expect(() => assertProductionAdminPassword("development", "")).not.toThrow();
    expect(() => assertProductionAdminPassword("development", "change-me")).not.toThrow();
    expect(() => assertProductionAdminPassword("test", "short")).not.toThrow();
  });

  it("refuses to start in production without a strong password", () => {
    expect(isProduction("production")).toBe(true);
    expect(() => assertProductionAdminPassword("production", undefined)).toThrow(/ADMIN_PASSWORD/);
    expect(() => assertProductionAdminPassword("production", "")).toThrow(/ADMIN_PASSWORD/);
    expect(() => assertProductionAdminPassword("production", "change-me")).toThrow(/not "change-me"/);
    expect(() => assertProductionAdminPassword("production", "12345678901")).toThrow(/at least 12/);
    expect(() => assertProductionAdminPassword("production", "strong-pass-ok")).not.toThrow();
  });
});
