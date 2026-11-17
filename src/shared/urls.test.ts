import { describe, expect, it } from "vitest";
import { checkRemoteUrl, mimeFromUrl, normaliseRemoteUrl, remoteHost } from "./urls";

describe("remote media link rules (MEDIA-05)", () => {
  it("accepts public https links in canonical form", () => {
    expect(checkRemoteUrl("https://media.example.com/a.png").ok).toBe(true);
    expect(checkRemoteUrl("https://cdn.example.org/v/clip.mp4?x=1").ok).toBe(true);
  });
  it.each([
    ["http://media.example.com/a.png", "https://"],
    ["https://user:pw@media.example.com/a.png", "password"],
    ["https://127.0.0.1/a.png", "IP"],
    ["https://2130706433/a.png", "IP"],
    ["https://0x7f.1/a.png", "IP"],
    ["https://[::1]/a.png", "IP"],
    ["https://localhost/a.png", "computer"],
    ["https://printer.local/a.png", "private"],
    ["https://wiki.corp/a.png", "private"],
    ["https://router.home.arpa/a.png", "private"],
    ["https://fileserver/a.png", "full site name"],
    ["https://Media.Example.com/a.png", "canonical"],
    ["not a url", "valid"],
    ["https://example.com./a.png", "dot"],
    ["https://localhost./a.png", "dot"],
    ["https://127.0.0.1.nip.io/a.png", "IP address"],
    ["https://10-0-0-1.sslip.io/a.png", "IP address"],
    ["https://app.lvh.me/a.png", "IP address"],
  ])("refuses %s", (url, why) => {
    const r = checkRemoteUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });
  it("normalises typed links", () => {
    expect(normaliseRemoteUrl("  https://Media.Example.com/a.png ")).toMatchObject({
      ok: true,
      url: "https://media.example.com/a.png",
    });
  });
  it("guesses types and hosts", () => {
    expect(mimeFromUrl("https://a.example.com/x.GIF")).toBe("image/gif");
    expect(mimeFromUrl("https://a.example.com/x.webm?t=2")).toBe("video/webm");
    expect(mimeFromUrl("https://a.example.com/page")).toBeNull();
    expect(remoteHost("https://www.example.com/a")).toBe("example.com");
  });
});
