import { describe, expect, test } from "bun:test";
import { applyDeployValues, DEPLOY_CONFIG, validate } from "../scripts/deploy-config";

const values = { MCP_HOST: "mcp.my-domain.test", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "abc123def456" };

describe("deploy-config", () => {
  test("同梱の wrangler.jsonc のプレースホルダーを全部置き換え、ほかは変えない", async () => {
    const text = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
    const out = applyDeployValues(text, values);
    expect(out).not.toContain("example.com");
    expect(out).toContain(`"pattern": "mcp.my-domain.test", "custom_domain": true`);
    expect(out).toContain(`"MCP_HOST": "mcp.my-domain.test"`);
    expect(out).toContain(`"ACCESS_TEAM_DOMAIN": "team.cloudflareaccess.com"`);
    expect(out).toContain(`"ACCESS_AUD": "abc123def456"`);
    expect(out).toContain(`"ALLOWED_GUILD_IDS": ""`);
    expect(out.split("\n").length).toBe(text.split("\n").length);
  });

  test("deploy スクリプトは生成した設定でデプロイし、wrangler.jsonc をそのまま使わない", async () => {
    // mcp の型は Workers の Blob を使うので BunFile.json() が無い。text() を読んで JSON.parse する
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { scripts: Record<string, string> };
    const deploy = pkg.scripts.deploy!;
    expect(deploy.startsWith("bun run scripts/deploy-config.ts && ")).toBe(true);
    expect(deploy).toContain(`wrangler deploy --config ${DEPLOY_CONFIG}`);
    // 生成物は wrangler.jsonc と同じフォルダ（main などの相対パスがそのまま通る）で、git に入らない
    expect(DEPLOY_CONFIG).not.toContain("/");
    const ignore = await Bun.file(new URL("../../../.gitignore", import.meta.url)).text();
    expect(ignore.split("\n")).toContain(`packages/mcp/${DEPLOY_CONFIG}`);
  });

  test("足りない値は名前を挙げて断る", () => {
    expect(() => validate({ MCP_HOST: "mcp.my-domain.test", ACCESS_TEAM_DOMAIN: " ", ACCESS_AUD: undefined })).toThrow(
      "ACCESS_TEAM_DOMAIN, ACCESS_AUD",
    );
  });

  test("例のホスト名や、JSON を壊す値は断る", () => {
    expect(() => validate({ ...values, MCP_HOST: "discord-mcp.example.com" })).toThrow();
    expect(() => validate({ ...values, MCP_HOST: 'a.test", "x": "y' })).toThrow();
    expect(() => validate({ ...values, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" })).toThrow();
    expect(() => validate({ ...values, ACCESS_AUD: 'abc"' })).toThrow();
    expect(validate({ ...values, ACCESS_AUD: " abc123 " }).ACCESS_AUD).toBe("abc123");
  });

  test("キーが無い・重複している設定は書き換えない", () => {
    expect(() => applyDeployValues(`{ "MCP_HOST": "" }`, values)).toThrow("pattern");
    const twice = `"pattern": "a", "pattern": "b", "MCP_HOST": "", "ACCESS_TEAM_DOMAIN": "", "ACCESS_AUD": ""`;
    expect(() => applyDeployValues(twice, values)).toThrow("2 か所");
  });
});
