import { describe, expect, test } from "bun:test";
import { Directory } from "../src/directory";
import { CHANNEL, FakeClock, GUILD, msg, OTHER, TARGET } from "./support";

const PRIVATE = "120000000000000001";
const PUBLIC = "120000000000000002";
const ROLE = "400000000000000001";
const VIEW = 1n << 10n;
const MANAGE_THREADS = 1n << 34n;

function setup(opts: { threadMember?: () => "member" | "absent" | "error"; roles?: string[]; parentDeny?: boolean } = {}) {
  const clock = new FakeClock();
  const gets: string[] = [];
  const rest = {
    get: (async (path: string) => {
      gets.push(path);
      if (path === `/guilds/${GUILD}/members/${TARGET}`) return { roles: opts.roles ?? [] };
      if (path === `/channels/${PRIVATE}/thread-members/${TARGET}`) {
        const r = (opts.threadMember ?? (() => "absent"))();
        if (r === "member") return { id: PRIVATE, user_id: TARGET };
        if (r === "error") throw Object.assign(new Error("server error"), { status: 500 });
      }
      throw Object.assign(new Error("not found"), { status: 404 });
    }) as any,
  };
  const directory = new Directory(rest, TARGET, clock.now);
  directory.onDispatch("GUILD_CREATE", {
    id: GUILD,
    name: "社内",
    owner_id: OTHER,
    roles: [
      { id: GUILD, name: "@everyone", permissions: VIEW.toString(), position: 0 },
      { id: ROLE, name: "mod", permissions: MANAGE_THREADS.toString(), position: 1 },
    ],
    channels: [
      { id: CHANNEL, type: 0, name: "dev", permission_overwrites: opts.parentDeny ? [{ id: GUILD, type: 0, allow: "0", deny: VIEW.toString() }] : [] },
    ],
    threads: [
      { id: PRIVATE, type: 12, name: "非公開", parent_id: CHANNEL },
      { id: PUBLIC, type: 11, name: "公開", parent_id: CHANNEL },
    ],
  });
  const view = async (id: string) => directory.targetCanView(GUILD, await directory.channel(id));
  const threadLookups = () => gets.filter((p) => p.includes("/thread-members/")).length;
  return { clock, gets, directory, view, threadLookups };
}

describe("Directory.targetCanView for threads", () => {
  test("a private thread the target has not joined is not viewable", async () => {
    const t = setup({ threadMember: () => "absent" });
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.gets).toContain(`/channels/${PRIVATE}/thread-members/${TARGET}`);
  });

  test("a private thread the target has joined is viewable", async () => {
    const t = setup({ threadMember: () => "member" });
    expect(await t.view(PRIVATE)).toBe(true);
  });

  test("a public thread is judged by the parent channel alone", async () => {
    expect(await setup().view(PUBLIC)).toBe(true);
    const hidden = setup({ parentDeny: true });
    expect(await hidden.view(PUBLIC)).toBe(false);
    expect(hidden.threadLookups()).toBe(0);
  });

  test("a private thread under a parent the target cannot see is not viewable, without a lookup", async () => {
    const t = setup({ parentDeny: true, threadMember: () => "member" });
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(0);
  });

  test("Manage Threads on the parent makes a private thread viewable without a lookup", async () => {
    const t = setup({ roles: [ROLE], threadMember: () => "absent" });
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(0);
  });

  test("a failed lookup leans towards notifying, like the other missing inputs", async () => {
    const t = setup({ threadMember: () => "error" });
    expect(await t.view(PRIVATE)).toBe(true);
  });

  test("membership is cached: not a member for 5 minutes, a member for an hour", async () => {
    let answer: "member" | "absent" | "error" = "absent";
    const t = setup({ threadMember: () => answer });
    expect(await t.view(PRIVATE)).toBe(false);
    answer = "member";
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(1);
    t.clock.advance(5 * 60 * 1000);
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(2);
    answer = "absent";
    t.clock.advance(59 * 60 * 1000);
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(2);
    t.clock.advance(60 * 1000);
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(3);
  });

  test("a failed lookup keeps only a known membership; an expired not-member answer leans towards notifying", async () => {
    let answer: "member" | "absent" | "error" = "absent";
    const t = setup({ threadMember: () => answer });
    expect(await t.view(PRIVATE)).toBe(false);
    t.clock.advance(5 * 60 * 1000);
    answer = "error";
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(2);
    // 失敗の控えは1分。その後は問い合わせ直す
    answer = "absent";
    expect(await t.view(PRIVATE)).toBe(true);
    t.clock.advance(60 * 1000);
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(3);

    // 参加していると分かっていたなら、失敗しても参加しているとみなす
    answer = "member";
    t.clock.advance(5 * 60 * 1000);
    expect(await t.view(PRIVATE)).toBe(true);
    t.clock.advance(60 * 60 * 1000);
    answer = "error";
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(5);
  });

  test("a RECIPIENT_ADD naming the target, or her own post, marks her as a member", async () => {
    const t = setup({ threadMember: () => "absent" });
    expect(await t.view(PRIVATE)).toBe(false);
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PRIVATE, type: 1, mentions: [{ id: TARGET, username: "stella" }] }));
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(1);

    const own = setup({ threadMember: () => "absent" });
    expect(await own.view(PRIVATE)).toBe(false);
    own.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PRIVATE, author: { id: TARGET, username: "stella" } }));
    expect(await own.view(PRIVATE)).toBe(true);
    expect(own.threadLookups()).toBe(1);
  });

  test("a RECIPIENT_REMOVE naming the target marks her as not a member; other people's changes are ignored", async () => {
    const t = setup({ threadMember: () => "member" });
    expect(await t.view(PRIVATE)).toBe(true);
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PRIVATE, type: 1, mentions: [{ id: OTHER, username: "other" }] }));
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PRIVATE, type: 2, mentions: [{ id: OTHER, username: "other" }] }));
    expect(await t.view(PRIVATE)).toBe(true);
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PRIVATE, type: 2, mentions: [{ id: TARGET, username: "stella" }] }));
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(1);
  });

  test("posts outside private threads do not touch the membership notes", async () => {
    const t = setup({ threadMember: () => "absent" });
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: PUBLIC, author: { id: TARGET, username: "stella" } }));
    t.directory.onDispatch("MESSAGE_CREATE", msg({ channel_id: CHANNEL, author: { id: TARGET, username: "stella" } }));
    expect(await t.view(PRIVATE)).toBe(false);
    expect(t.threadLookups()).toBe(1);
  });

  test("a mention of the target ignores a cached not-member answer and drops it", async () => {
    let answer: "member" | "absent" | "error" = "absent";
    const t = setup({ threadMember: () => answer });
    expect(await t.view(PRIVATE)).toBe(false);
    const thread = await t.directory.channel(PRIVATE);
    expect(await t.directory.targetCanView(GUILD, thread, { mentioned: true })).toBe(true);
    expect(t.threadLookups()).toBe(1);
    // メンションで加わったので、次の投稿は問い合わせ直す
    answer = "member";
    expect(await t.view(PRIVATE)).toBe(true);
    expect(t.threadLookups()).toBe(2);
  });

  test("a mention still needs the parent channel to be visible", async () => {
    const t = setup({ parentDeny: true });
    expect(await t.directory.targetCanView(GUILD, await t.directory.channel(PRIVATE), { mentioned: true })).toBe(false);
  });
});
