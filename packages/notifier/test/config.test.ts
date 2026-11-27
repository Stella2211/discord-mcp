import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config";

const base = {
  DISCORD_BOT_TOKEN: "x".repeat(70),
  TARGET_USER_ID: "200000000000000001",
  DUET_SEND_PATH: "/opt/duet-send/send.ts",
};

describe("loadConfig", () => {
  test("defaults", async () => {
    const c = await loadConfig(base);
    expect(c.DECISION_PROVIDER).toBe("none");
    expect(c.ALLOWED_GUILD_IDS).toEqual([]);
    expect(c.NOTIFY_BOT_MENTIONS).toBe(true);
    expect(c.DECISION_DEBOUNCE_SECONDS).toBe(20);
    expect(c.DUET_TAG).toBe("[Discord]");
  });
  test("empty values count as unset", async () => {
    const c = await loadConfig({ ...base, DECISION_BASE_URL: "", ALLOWED_GUILD_IDS: " ", NOTIFY_EVERYONE: "" });
    expect(c.DECISION_BASE_URL).toBeUndefined();
    expect(c.NOTIFY_EVERYONE).toBe(false);
  });
  test("lists and flags", async () => {
    const c = await loadConfig({ ...base, ALLOWED_GUILD_IDS: "100000000000000001, 100000000000000002", KEYWORDS: "stella,ステラ", NOTIFY_EVERYONE: "true" });
    expect(c.ALLOWED_GUILD_IDS).toEqual(["100000000000000001", "100000000000000002"]);
    expect(c.KEYWORDS).toEqual(["stella", "ステラ"]);
    expect(c.NOTIFY_EVERYONE).toBe(true);
  });
  test("typos in flags and one-letter keywords are rejected", async () => {
    await expect(loadConfig({ ...base, NOTIFY_EVERYONE: "ture" })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ ...base, KEYWORDS: "a,stella" })).rejects.toThrow(ConfigError);
    expect((await loadConfig({ ...base, NOTIFY_EVERYONE: "OFF" })).NOTIFY_EVERYONE).toBe(false);
  });
  test("errors name the key but never echo the token", async () => {
    const err = (await loadConfig({ ...base, DISCORD_BOT_TOKEN: "short-secret", TARGET_USER_ID: "abc" }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("TARGET_USER_ID");
    expect(err.message).not.toContain("short-secret");
  });
  test("a decision provider needs its settings", async () => {
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "openai-compatible", DECISION_MODEL: "m" })).rejects.toThrow("DECISION_BASE_URL");
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "anthropic", DECISION_MODEL: "m" })).rejects.toThrow("ANTHROPIC_API_KEY");
    await expect(
      loadConfig({ ...base, DECISION_PROVIDER: "openai-compatible", DECISION_MODEL: "m", DECISION_BASE_URL: "http://127.0.0.1:1234/v1" }),
    ).rejects.toThrow("DECISION_PROFILE");
    const c = await loadConfig(
      { ...base, DECISION_PROVIDER: "openai-compatible", DECISION_MODEL: "m", DECISION_BASE_URL: "http://127.0.0.1:1234/v1", DECISION_PROFILE_FILE: "/p" },
      async () => " 担当: API \n",
    );
    expect(c.decisionProfile).toBe("担当: API");
  });
});

describe("DUET_ROUTES", () => {
  const G = "100000000000000001";
  const C = "110000000000000002";
  test("parses id=route pairs, including non-ASCII names", async () => {
    const c = await loadConfig({ ...base, DUET_ROUTES: ` ${G}=work, ${C}=仕事 ` });
    expect(c.DUET_ROUTES).toEqual(new Map([[G, "work"], [C, "仕事"]]));
  });
  test("unset or empty means no routing", async () => {
    expect((await loadConfig(base)).DUET_ROUTES.size).toBe(0);
    expect((await loadConfig({ ...base, DUET_ROUTES: "" })).DUET_ROUTES.size).toBe(0);
  });
  test("duplicate ids are an error that does not print the values", async () => {
    const err = await loadConfig({ ...base, DUET_ROUTES: `${G}=a,${G}=b` }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("DUET_ROUTES");
    expect(err.message).not.toContain(G);
  });
  test("bad ids and bad route names are errors", async () => {
    for (const v of ["123=work", `${G}`, `${G}=`, `${G}=-x`, `${G}=a b`, `${G}=a=b`, `abc=work`]) {
      await expect(loadConfig({ ...base, DUET_ROUTES: v })).rejects.toBeInstanceOf(ConfigError);
    }
  });
});
