import { describe, expect, test } from "bun:test";
import { resolveRoute } from "../src/routing";

const routes = new Map([
  ["100000000000000001", "guild"],
  ["110000000000000002", "parent"],
  ["110000000000000003", "channel"],
]);

describe("resolveRoute", () => {
  test("channel beats parent beats guild", () => {
    const place = { channelId: "110000000000000003", parentChannelId: "110000000000000002", guildId: "100000000000000001" };
    expect(resolveRoute(routes, place)).toBe("channel");
    expect(resolveRoute(routes, { ...place, channelId: "110000000000000009" })).toBe("parent");
    expect(resolveRoute(routes, { ...place, channelId: "110000000000000009", parentChannelId: null })).toBe("guild");
  });
  test("unlisted or no routes means the default route", () => {
    expect(resolveRoute(routes, { channelId: "110000000000000009", guildId: "100000000000000009" })).toBeUndefined();
    expect(resolveRoute(new Map(), { channelId: "110000000000000003", guildId: "100000000000000001" })).toBeUndefined();
    expect(resolveRoute(undefined, { channelId: "110000000000000003" })).toBeUndefined();
  });
});
