import { describe, expect, test } from "bun:test";
import type { APIMessage } from "@discord-mcp/discord";
import { messageBlock } from "../src/tools/common";

const m = {
  id: "300000000000000001",
  channel_id: "110000000000000001",
  author: { id: "200000000000000001", username: "bob", global_name: null },
  content: "見て",
  timestamp: "2026-11-18T03:00:00.000Z",
  type: 0,
  mentions: [],
  mention_roles: [],
  mention_everyone: false,
  attachments: [
    { id: "1", filename: "shot.png", size: 2048, content_type: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1" },
    { id: "2", filename: "log.txt", size: 10, content_type: "text/plain", url: "https://cdn.discordapp.com/attachments/1/2/log.txt" },
  ],
  embeds: [{ type: "rich", image: { url: "https://example.com/e.png", proxy_url: "https://media.discordapp.net/external/e.png" } }],
} as unknown as APIMessage;

describe("messageBlock images", () => {
  test("lists attachment and embed image urls", () => {
    const b = messageBlock(m, 1000);
    expect(b).toContain("[添付 2件: shot.png, log.txt]");
    expect(b).toContain("[画像1: shot.png (2KB) https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1]");
    expect(b).toContain("[画像2: e.png https://media.discordapp.net/external/e.png]");
    expect(b).not.toContain("log.txt?");
  });
});
