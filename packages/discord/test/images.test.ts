import { describe, expect, test } from "bun:test";
import { imageLine, messageImages } from "../src/images";

const CDN = "https://cdn.discordapp.com/attachments/1/2";
const base = { attachments: [], embeds: [] } as Parameters<typeof messageImages>[0];

describe("messageImages", () => {
  test("picks image attachments and skips other files", () => {
    const refs = messageImages({
      ...base,
      attachments: [
        { id: "1", filename: "shot.png", size: 2048, content_type: "image/png", url: `${CDN}/shot.png?ex=1&hm=2` },
        { id: "2", filename: "log.txt", size: 10, content_type: "text/plain", url: `${CDN}/log.txt` },
        { id: "3", filename: "no-type.JPG", size: 10, url: `${CDN}/no-type.JPG` },
      ],
    });
    expect(refs.map((r) => r.filename)).toEqual(["shot.png", "no-type.JPG"]);
    expect(refs[0]).toMatchObject({ url: `${CDN}/shot.png?ex=1&hm=2`, size: 2048, source: "attachment" });
  });
  test("embeds: image, or the thumbnail of an image embed; prefers the proxy url; no duplicates", () => {
    const refs = messageImages({
      ...base,
      embeds: [
        { type: "rich", image: { url: "https://example.com/a.png", proxy_url: "https://media.discordapp.net/external/a.png" } },
        { type: "link", thumbnail: { url: "https://example.com/t.png" } },
        { type: "image", thumbnail: { url: "https://example.com/b.png" } },
        { type: "rich", image: { url: "https://example.com/b.png" } },
      ],
    });
    expect(refs.map((r) => r.url)).toEqual(["https://media.discordapp.net/external/a.png", "https://example.com/b.png"]);
    expect(refs.every((r) => r.source === "embed")).toBe(true);
  });
  test("imageLine shows the name, size and a cleaned url", () => {
    expect(imageLine({ url: `${CDN}/a.png`, filename: "a.png", size: 3 * 1024 * 1024, source: "attachment" }, 0)).toBe(`画像1: a.png (3.0MB) ${CDN}/a.png`);
    expect(imageLine({ url: "https://x/<b>", source: "embed" }, 1)).toBe("画像2: https://x/‹b›");
  });
});
