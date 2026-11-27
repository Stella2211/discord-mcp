import { describe, expect, test } from "bun:test";
import { isDiscordCdn, loadImages } from "../src/decision/images";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const ref = (url: string, extra: object = {}) => ({ url, source: "attachment" as const, ...extra });

function fake(respond: (url: string) => Response) {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return respond(String(url));
  }) as typeof fetch;
  return { f, urls };
}

describe("loadImages", () => {
  test("only Discord CDN hosts over https", () => {
    expect(isDiscordCdn("https://cdn.discordapp.com/a.png")).toBe(true);
    expect(isDiscordCdn("https://media.discordapp.net/a.png")).toBe(true);
    expect(isDiscordCdn("http://cdn.discordapp.com/a.png")).toBe(false);
    expect(isDiscordCdn("https://evil.example.com/a.png")).toBe(false);
    expect(isDiscordCdn("https://cdn.discordapp.com.evil.example/a.png")).toBe(false);
    expect(isDiscordCdn("https://127.0.0.1/a.png")).toBe(false);
  });
  test("downloads allowed images as base64 and never fetches other hosts", async () => {
    const t = fake(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const out = await loadImages([ref("https://evil.example.com/x.png"), ref("https://cdn.discordapp.com/a.png")], { fetch: t.f });
    expect(t.urls).toEqual(["https://cdn.discordapp.com/a.png"]);
    expect(out).toEqual([{ url: "https://cdn.discordapp.com/a.png", mediaType: "image/png", base64: Buffer.from(PNG).toString("base64") }]);
  });
  test("skips unsupported types, failures, and oversized images; keeps at most 4", async () => {
    const t = fake((u) => {
      if (u.includes("gif")) return new Response(PNG, { headers: { "content-type": "image/gif" } });
      if (u.includes("gone")) return new Response("no", { status: 404 });
      return new Response(PNG, { headers: { "content-type": "image/jpeg" } });
    });
    const urls = ["gif", "gone", "1", "2", "3", "4", "5"].map((n) => ref(`https://cdn.discordapp.com/${n}.jpg`));
    const out = await loadImages([...urls, ref("https://cdn.discordapp.com/huge.png", { size: 5 * 1024 * 1024 })], { fetch: t.f });
    expect(out.map((i) => i.url.split("/").pop())).toEqual(["1.jpg", "2.jpg", "3.jpg", "4.jpg"]);
    expect(t.urls.some((u) => u.includes("huge"))).toBe(false);
  });
  test("stops reading a streamed body without Content-Length once it exceeds the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
        if (pulled > 100) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const t = fake((u) =>
      u.includes("big")
        ? new Response(body, { headers: { "content-type": "image/png" } })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const out = await loadImages([ref("https://cdn.discordapp.com/big.png"), ref("https://cdn.discordapp.com/ok.png")], { fetch: t.f });
    expect(out.map((i) => i.url.split("/").pop())).toEqual(["ok.png"]);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
});
