import { describe, expect, it } from "vitest";
import { appOrigins, ConfigError, loadConfig, normalizeHostEntry } from "./config";

describe("ALLOWED_HOSTS normalisation", () => {
  it("normalises IPv6, ports and case", () => {
    expect(normalizeHostEntry("::1")).toBe("[::1]");
    expect(normalizeHostEntry("[::1]")).toBe("[::1]");
    expect(normalizeHostEntry("[::1]:5183")).toBe("[::1]");
    expect(normalizeHostEntry("fe80::1")).toBe("[fe80::1]");
    expect(normalizeHostEntry("MyBoard.LAN")).toBe("myboard.lan");
    expect(normalizeHostEntry("192.168.1.20:5183")).toBe("192.168.1.20");
  });

  it("refuses schemes, paths and wildcards", () => {
    for (const bad of [
      "http://x.lan",
      "x.lan/path",
      "*.lan",
      "x.lan:abc",
      "a b",
      "",
      "x.lan:65536",
      "[::1]:70000",
    ])
      expect(() => normalizeHostEntry(bad), bad).toThrow();
  });

  it("start-up fails with a clear message for a bad entry", () => {
    expect(() => loadConfig({ ALLOWED_HOSTS: "ok.lan,https://bad" })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_HOSTS: "ok.lan,https://bad" })).toThrow(/ALLOWED_HOSTS/);
  });
});

describe("loadConfig", () => {
  it("has safe defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(5183);
    expect(c.host).toBeNull();
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimits.enabled).toBe(true);
    expect(c.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.sessionTtlDays).toBeNull();
  });

  it("adds PUBLIC_URL's host and origin", () => {
    const c = loadConfig({
      PUBLIC_URL: "https://Board.Example.com/",
      ALLOWED_HOSTS: "::1,lan.box",
    });
    expect(c.allowedHosts).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "board.example.com",
      "lan.box",
    ]);
    expect(appOrigins(c)).toContain("https://board.example.com");
    expect(appOrigins(c)).toContain("http://localhost:5183");
    expect(() => loadConfig({ PUBLIC_URL: "ftp://x" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: "nope" })).toThrow(ConfigError);
  });

  it("parses TRUST_PROXY", () => {
    expect(loadConfig({ TRUST_PROXY: "loopback" }).trustProxy).toBe("loopback");
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "off" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.1, 10.0.0.2" }).trustProxy).toBe("10.0.0.1,10.0.0.2");
    expect(() => loadConfig({ TRUST_PROXY: "yes please" })).toThrow(ConfigError);
  });

  it("parses limits and ALLOWED_ORIGINS", () => {
    const c = loadConfig({
      MAX_SESSIONS: "3",
      RATE_LIMITS: "off",
      ALLOWED_ORIGINS: "http://localhost:6274",
    });
    expect(c.limits.maxSessions).toBe(3);
    expect(c.rateLimits.enabled).toBe(false);
    expect(c.allowedOrigins).toEqual(["http://localhost:6274"]);
    expect(() => loadConfig({ MAX_SESSIONS: "lots" })).toThrow(ConfigError);
    expect(() => loadConfig({ RATE_LIMITS: "maybe" })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_ORIGINS: "http://x/path" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
  });
});
