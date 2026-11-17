import { describe, expect, it } from "vitest";
import { crossSiteReason } from "./csrf";
import { appCsp } from "./headers";
import { hostnameOf, isHostAllowed } from "./host";
import { redactIds } from "./rateLimit";

const HOSTS = ["localhost", "127.0.0.1", "[::1]", "myboard.lan"];

describe("host check", () => {
  it("compares hostnames without ports", () => {
    expect(hostnameOf("localhost:5183")).toBe("localhost");
    expect(hostnameOf("[::1]:5183")).toBe("[::1]");
    expect(hostnameOf("MyBoard.LAN")).toBe("myboard.lan");
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf("bad host")).toBeNull();
    for (const ok of [
      "localhost",
      "localhost:5183",
      "127.0.0.1:1",
      "[::1]:5183",
      "[::1]",
      "MYBOARD.lan:80",
    ])
      expect(isHostAllowed(ok, HOSTS), ok).toBe(true);
    for (const bad of [
      "evil.com",
      "evil.com:5183",
      "localhost.evil.com",
      "[::2]:5183",
      "",
      undefined,
    ])
      expect(isHostAllowed(bad, HOSTS), String(bad)).toBe(false);
  });
});

describe("cross-site guard", () => {
  const own = ["https://board.example.com"];
  it("refuses Sec-Fetch-Site: cross-site and foreign origins", () => {
    expect(
      crossSiteReason({ "sec-fetch-site": "cross-site", host: "localhost:5183" }, own),
    ).toMatch(/other websites/);
    expect(
      crossSiteReason({ origin: "https://evil.example", host: "localhost:5183" }, own),
    ).toMatch(/refused/);
    // same site, other port: still another origin
    expect(
      crossSiteReason({ origin: "http://localhost:5000", host: "localhost:5183" }, own),
    ).not.toBeNull();
    expect(crossSiteReason({ origin: "null", host: "localhost:5183" }, own)).not.toBeNull();
  });

  it("accepts its own origin, listed origins and requests without Origin", () => {
    expect(
      crossSiteReason({ origin: "http://localhost:5183", host: "localhost:5183" }, own),
    ).toBeNull();
    expect(crossSiteReason({ origin: "http://[::1]:5183", host: "[::1]:5183" }, own)).toBeNull();
    expect(
      crossSiteReason({ origin: "https://board.example.com", host: "localhost:5183" }, own),
    ).toBeNull();
    expect(
      crossSiteReason({ "sec-fetch-site": "same-origin", host: "localhost:5183" }, own),
    ).toBeNull();
    expect(crossSiteReason({ host: "localhost:5183" }, own)).toBeNull();
  });
});

describe("headers", () => {
  it("the CSP names ws:// and wss:// for the host", () => {
    const csp = appCsp("localhost:5183", false);
    expect(csp).toContain("connect-src 'self' ws://localhost:5183 wss://localhost:5183");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(appCsp("localhost:5183", true)).toContain("'unsafe-inline'");
  });

  it("logs never show a full session id", () => {
    expect(redactIds("GET /s/abcdEFGHijklMNOPqrstUVWX done")).toBe("GET /s/abcd… done");
  });
});
