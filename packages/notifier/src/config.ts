// .env（Bun が自動で読む）から設定を読む。値の検査はここに集め、起動時に分かりやすく失敗させる。
import * as z from "zod";

const snowflake = z.string().regex(/^\d{15,21}$/, "Discord の ID（15〜21桁の数字）");
const idList = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(snowflake));
// 1文字のキーワードはほとんどの投稿に当たってしまうので、2文字以上にする
const textList = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().refine((s) => Array.from(s).length >= 2, "キーワードは2文字以上にする")));
// duet-send の宛先の名前。フラグに見えないよう "-" 始まりを、区切りと混ざる空白・カンマ・"=" を含むものを断る（日本語の名前は可）
const ROUTE_NAME = /^[^\s,=-][^\s,=]*$/u;
// "<ID>=<宛先>" をカンマで並べる。ID はサーバーIDかチャンネルID。同じ ID を2回書いたらエラー（エラーには値を出さない）
const routeMap = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const map = new Map<string, string>();
    for (const entry of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf("=");
      const id = eq < 0 ? entry : entry.slice(0, eq).trim();
      const name = eq < 0 ? "" : entry.slice(eq + 1).trim();
      if (!/^\d{15,21}$/.test(id)) {
        ctx.addIssue({ code: "custom", message: "「ID=宛先」の形で書き、ID は Discord の ID（15〜21桁の数字）にする" });
        return z.NEVER;
      }
      if (!ROUTE_NAME.test(name)) {
        ctx.addIssue({ code: "custom", message: "宛先の名前は空にせず、空白・カンマ・= を含めず、- で始めない" });
        return z.NEVER;
      }
      if (map.has(id)) {
        ctx.addIssue({ code: "custom", message: "同じ ID が2回書かれている" });
        return z.NEVER;
      }
      map.set(id, name);
    }
    return map;
  });
const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];
// 書き間違い（"ture" など）を黙って false にしないよう、知らない値はエラーにする
const flag = (def: boolean) =>
  z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || [...TRUE, ...FALSE].includes(v.trim().toLowerCase()), "true か false で指定する")
    .transform((v) => (v === undefined || v === "" ? def : TRUE.includes(v.trim().toLowerCase())));
const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(50, "DISCORD_BOT_TOKEN が未設定か短すぎる"),
  // 通知の対象になる人（あなた自身）のユーザーID
  TARGET_USER_ID: snowflake,
  // 空ならBotが入っている全サーバー
  ALLOWED_GUILD_IDS: idList,
  IGNORE_CHANNEL_IDS: idList,
  // 名前などのキーワード。含まれていたらメンションと同じ扱いで通知する
  KEYWORDS: textList,
  INCLUDE_BOT_MESSAGES: flag(false),
  // Bot 自身へのメンションも通知する
  NOTIFY_BOT_MENTIONS: flag(true),
  // @everyone / @here を直接通知にするか（false なら判定モデルに回す）
  NOTIFY_EVERYONE: flag(false),
  // メンション通知に添える直前の会話の件数
  MENTION_CONTEXT_MESSAGES: int(5, 0, 20),

  DECISION_PROVIDER: z.enum(["none", "clef", "openrouter", "openai-compatible", "anthropic"]).default("none"),
  DECISION_MODEL: z.string().optional(),
  DECISION_BASE_URL: z.string().url().optional(),
  DECISION_API_KEY: z.string().optional(),
  DECISION_JSON_MODE: z.enum(["json_schema", "json_object", "none"]).default("json_schema"),
  DECISION_PROFILE: z.string().optional(),
  DECISION_PROFILE_FILE: z.string().optional(),
  // 投稿の画像を判定モデルに渡す。画像を読めないモデルなら false にする（渡して断られたときは、画像なしでやり直す）
  DECISION_IMAGES: flag(true),
  DECISION_HISTORY_MESSAGES: int(20, 1, 100),
  // 同じチャンネルの投稿をまとめて判定するまでの待ち時間（秒）。最後の投稿からこの時間静かになったら判定する
  DECISION_DEBOUNCE_SECONDS: int(20, 0, 600),
  // 投稿が続いても、最初の投稿からこの時間（秒）で必ず判定する
  DECISION_MAX_WAIT_SECONDS: int(120, 1, 3600),
  DECISION_TIMEOUT_SECONDS: int(60, 5, 600),
  ANTHROPIC_API_KEY: z.string().optional(),
  // clef（Cloudflare Workers AI）。アカウントIDと、Workers AI の権限だけを持つ API トークン
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/, "Cloudflare のアカウントID（32桁の英数字）").optional(),
  CLOUDFLARE_AI_TOKEN: z.string().optional(),
  // relevant の確率がこれ以上なら知らせる（0〜1）。合わせ方は scripts/eval.ts で試す
  CLEF_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 0.3 : Number(v)))
    .pipe(z.number().min(0).max(1)),
  // 重要度（0〜3）がこれ以上でも知らせる（確率がしきい値に届かなくても）。3 を超える値（例 4）にすると重要度では知らせない
  CLEF_PRIORITY_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 1 : Number(v)))
    .pipe(z.number().min(0).max(4)),
  // openrouter で、データを残さないエンドポイントだけに送る
  OPENROUTER_ZDR: flag(true),

  DUET_SEND_PATH: z.string().min(1, "DUET_SEND_PATH（duet-send の send.ts のフルパス）が未設定"),
  DUET_TAG: z.string().default("[Discord]"),
  // Duet への送信の最短間隔（秒）。間に溜まった通知は1通にまとめる
  NOTIFY_MIN_INTERVAL_SECONDS: int(30, 0, 3600),
  // サーバーID・チャンネルIDごとの duet-send の宛先（<ID>=<宛先名>,…）。載っていないものは既定の宛先
  DUET_ROUTES: routeMap,
  // 1 なら Duet に送らず標準出力に出すだけ
  DUET_DRY_RUN: flag(false),
  // debug なら、無視した投稿の理由（本文は出さない）もログに出す
  LOG_LEVEL: z.enum(["info", "debug"]).default("info"),
});

// 判定モデルの既定のモデル名
export const DEFAULT_MODEL: Record<string, string | undefined> = {
  clef: "clef-flash",
  openrouter: "google/gemini-3.5-flash-lite",
};

export type Config = z.infer<typeof schema> & { decisionProfile: string; decisionModel: string };

export class ConfigError extends Error {}

export async function loadConfig(env: Record<string, string | undefined> = process.env, readFile = (p: string) => Bun.file(p).text()): Promise<Config> {
  // .env の「KEY=」（空）は未設定として扱う
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "").map(([k, v]) => [k, v!.trim()]));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`.env の設定に問題があります:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  const model = c.DECISION_MODEL ?? DEFAULT_MODEL[c.DECISION_PROVIDER] ?? "";
  if (c.DECISION_PROVIDER !== "none" && !model) throw new ConfigError("DECISION_MODEL を設定してください");
  if (c.DECISION_PROVIDER === "clef") {
    if (model !== "clef" && model !== "clef-flash") throw new ConfigError("clef の DECISION_MODEL は clef か clef-flash");
    if (!c.CLOUDFLARE_ACCOUNT_ID || !c.CLOUDFLARE_AI_TOKEN)
      throw new ConfigError("CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_AI_TOKEN を設定してください（Workers AI の権限だけを持つトークン）");
  }
  if (c.DECISION_PROVIDER === "openrouter" && !c.DECISION_API_KEY) throw new ConfigError("DECISION_API_KEY（OpenRouter の API キー）を設定してください");
  if (c.DECISION_PROVIDER === "openai-compatible" && !c.DECISION_BASE_URL)
    throw new ConfigError("DECISION_BASE_URL を設定してください（例: http://192.168.1.20:1234/v1）");
  if (c.DECISION_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) throw new ConfigError("ANTHROPIC_API_KEY を設定してください");

  let profile = c.DECISION_PROFILE ?? "";
  if (c.DECISION_PROFILE_FILE) {
    try {
      profile = (await readFile(c.DECISION_PROFILE_FILE)).trim();
    } catch {
      throw new ConfigError(`DECISION_PROFILE_FILE を読めません: ${c.DECISION_PROFILE_FILE}`);
    }
  }
  if (c.DECISION_PROVIDER !== "none" && !profile)
    throw new ConfigError("DECISION_PROFILE か DECISION_PROFILE_FILE に、あなたの担当や関心を書いてください");
  return { ...c, decisionProfile: profile, decisionModel: model };
}
