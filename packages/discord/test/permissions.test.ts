import { describe, expect, test } from "bun:test";
import { channelPermissions, computeBasePermissions, has, Permission, type APIGuild } from "../src";

const G = "100000000000000001";
const BOT = "200000000000000001";
const ROLE_A = "300000000000000001";
const ROLE_B = "300000000000000002";

const guild = (everyone: bigint, extra: Record<string, bigint> = {}, owner = "999999999999999999"): APIGuild => ({
  id: G,
  name: "g",
  owner_id: owner,
  roles: [
    { id: G, name: "@everyone", permissions: everyone.toString(), position: 0 },
    ...Object.entries(extra).map(([id, p], i) => ({ id, name: id, permissions: p.toString(), position: i + 1 })),
  ],
});

const VIEW_SEND = Permission.ViewChannel | Permission.SendMessages | Permission.ReadMessageHistory;

describe("computeBasePermissions", () => {
  test("combines @everyone and member roles", () => {
    const p = computeBasePermissions(guild(Permission.ViewChannel, { [ROLE_A]: Permission.SendMessages }), BOT, [ROLE_A]);
    expect(has(p, Permission.ViewChannel | Permission.SendMessages)).toBe(true);
    expect(has(p, Permission.AddReactions)).toBe(false);
  });
  test("owner and administrator get everything", () => {
    expect(has(computeBasePermissions(guild(0n, {}, BOT), BOT, []), Permission.AddReactions)).toBe(true);
    expect(has(computeBasePermissions(guild(0n, { [ROLE_A]: Permission.Administrator }), BOT, [ROLE_A]), Permission.SendMessages)).toBe(true);
  });
});

describe("channelPermissions", () => {
  test("@everyone deny hides the channel", () => {
    const p = channelPermissions(guild(VIEW_SEND), BOT, [], {
      permission_overwrites: [{ id: G, type: 0, allow: "0", deny: Permission.ViewChannel.toString() }],
    });
    expect(p).toBe(0n);
  });
  test("role allow beats @everyone deny, member deny beats role allow", () => {
    const overwrites = [
      { id: G, type: 0 as const, allow: "0", deny: Permission.SendMessages.toString() },
      { id: ROLE_A, type: 0 as const, allow: Permission.SendMessages.toString(), deny: "0" },
    ];
    const g = guild(VIEW_SEND);
    expect(has(channelPermissions(g, BOT, [ROLE_A], { permission_overwrites: overwrites }), Permission.SendMessages)).toBe(true);
    expect(has(channelPermissions(g, BOT, [], { permission_overwrites: overwrites }), Permission.SendMessages)).toBe(false);
    const withMember = [...overwrites, { id: BOT, type: 1 as const, allow: "0", deny: Permission.SendMessages.toString() }];
    expect(has(channelPermissions(g, BOT, [ROLE_A], { permission_overwrites: withMember }), Permission.SendMessages)).toBe(false);
  });
  test("role allow and deny from different roles: allow wins", () => {
    const overwrites = [
      { id: ROLE_A, type: 0 as const, allow: "0", deny: Permission.AddReactions.toString() },
      { id: ROLE_B, type: 0 as const, allow: Permission.AddReactions.toString(), deny: "0" },
    ];
    expect(has(channelPermissions(guild(VIEW_SEND | Permission.AddReactions), BOT, [ROLE_A, ROLE_B], { permission_overwrites: overwrites }), Permission.AddReactions)).toBe(true);
  });
  test("administrator ignores overwrites", () => {
    const p = channelPermissions(guild(0n, { [ROLE_A]: Permission.Administrator }), BOT, [ROLE_A], {
      permission_overwrites: [{ id: G, type: 0, allow: "0", deny: Permission.ViewChannel.toString() }],
    });
    expect(has(p, Permission.ViewChannel)).toBe(true);
  });
});
