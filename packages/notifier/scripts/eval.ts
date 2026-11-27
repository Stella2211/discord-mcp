// 判定モデルの試験。Discord に投稿せずに、用意した投稿（eval/cases.json）を .env の判定モデルに判定させ、
// 期待どおりかと、Clef なら確率・重要度を表にする。プロフィールを替えて比べられる。
// 知らせるかどうかは通知Botと同じ judge() で決める（判定モデルの呼び出しに失敗したら未判定で知らせる）。
// fail の付いた投稿は、判定モデルを呼ばずに失敗させて、未判定で知らせることを確かめる。
//
//   cd packages/notifier
//   bun scripts/eval.ts                                   # .env の DECISION_PROFILE で試す
//   bun scripts/eval.ts --profile-file eval/my-profile.md # 別のプロフィールでも試して比べる（何度でも指定できる）
//   bun scripts/eval.ts --cases eval/my-cases.json        # 自分で作った投稿で試す
//
// 判定モデルの呼び出しは本番と同じく料金がかかる（Clef なら 1件数百トークン。無料枠で足りる）。
// Discord のトークンと duet-send は使わない。
import { createDecisionModel, judge, type Decision, type DecisionInput, type DecisionModel } from "../src/decision";
import { ConfigError, loadConfig, type Config } from "../src/config";

interface Case {
  name: string;
  expect: boolean;
  // あれば、判定モデルを呼ばずにこの理由で失敗させる（"timeout" なら時間切れ）
  fail?: string;
  messages: { author: string; content: string; isNew: boolean; isTarget?: boolean }[];
}

interface Result {
  c: Case;
  d: Decision | null;
  error?: string;
}

const THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
// 重要度のしきい値。4 は「重要度では知らせない」
const PRIORITY_THRESHOLDS = [0.5, 1.0, 1.3, 1.5, 2.0, 4];

// 失敗させるときの判定モデル。本物のモデルと同じく例外を投げる
function failing(name: string, reason: string): DecisionModel {
  return {
    name,
    decide: async () => {
      throw reason === "timeout" ? Object.assign(new Error("timeout"), { name: "TimeoutError" }) : new Error(reason);
    },
  };
}

function parseArgs(argv: string[]): { profiles: string[]; cases: string } {
  const profiles: string[] = [];
  let cases = new URL("../eval/cases.json", import.meta.url).pathname;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === "--profile-file" || a === "--cases") && !v) throw new Error(`${a} の後にファイルを指定する`);
    if (a === "--profile-file") profiles.push(v!), i++;
    else if (a === "--cases") (cases = v!), i++;
    else throw new Error(`知らない引数: ${a}`);
  }
  return { profiles, cases };
}

// 試験では Discord と duet-send を使わないので、それらの必須の設定は仮の値で埋める（.env の値があればそちらを使う）
// .env にプロフィールがなく --profile-file だけで試すときは、仮のプロフィールで設定の検査を通す（その仮の値では試さない）
async function baseConfig(placeholderProfile: boolean): Promise<Config> {
  return loadConfig({
    DISCORD_BOT_TOKEN: "x".repeat(60),
    TARGET_USER_ID: "1".repeat(18),
    DUET_SEND_PATH: "-",
    ...(placeholderProfile ? { DECISION_PROFILE: "-" } : {}),
    ...process.env,
  });
}

async function run(c: Config, cases: Case[]): Promise<Result[]> {
  const model = createDecisionModel(c);
  if (!model) throw new Error("DECISION_PROVIDER が none なので試せない");
  const out: Result[] = [];
  for (const k of cases) {
    const input: DecisionInput = {
      guildName: "試験",
      channelName: "general",
      messages: k.messages.map((m) => ({ author: m.author, at: "2026-01-01 12:00", content: m.content, isNew: m.isNew, isTarget: m.isTarget === true })),
    };
    const j = await judge(k.fail !== undefined ? failing(model.name, k.fail) : model, input);
    out.push(j.error !== undefined ? { c: k, d: null, error: j.error } : { c: k, d: j.decision });
  }
  return out;
}

const mark = (ok: boolean) => (ok ? "○" : "×");

// 確率と重要度のしきい値で知らせるか（判定モデルの呼び出しに失敗したものは未判定で知らせる）
function notifies(r: Result, t: number, s: number): boolean {
  if (!r.d) return true;
  if (r.d.probability === undefined) return r.d.relevant;
  return r.d.probability >= t || (r.d.priority !== undefined && r.d.priority >= s);
}

function count(rs: Result[], t: number, s: number): string {
  const miss = rs.filter((r) => r.c.expect && !notifies(r, t, s));
  const extra = rs.filter((r) => !r.c.expect && notifies(r, t, s));
  const names = (xs: Result[]) => (xs.length > 0 ? `（${xs.map((r) => r.c.name).join("、")}）` : "");
  return `見逃し ${miss.length}${names(miss)}、余計 ${extra.length}${names(extra)}`;
}

function report(label: string, thresholds: { p: number; s: number } | null, rs: Result[]): void {
  console.log(`\n=== ${label} ===`);
  for (const r of rs) {
    const want = r.c.expect ? "知らせる" : "知らせない";
    if (!r.d) {
      console.log(`  ${mark(r.c.expect)}  ${r.c.name}（期待: ${want} / 判定エラーのため未判定で知らせる: ${r.error}）`);
      continue;
    }
    const p = r.d.probability !== undefined ? ` 確率 ${r.d.probability.toFixed(2)}` : "";
    const s = r.d.priority !== undefined ? ` 重要度 ${r.d.priority.toFixed(1)}` : "";
    const got = r.d.relevant ? "知らせる" : "知らせない";
    console.log(`  ${mark(r.d.relevant === r.c.expect)}  ${r.c.name}（期待: ${want} / 判定: ${got}${p}${s}）`);
    if (r.d.probability === undefined && r.d.reason) console.log(`       理由: ${r.d.reason}`);
  }
  const right = rs.filter((r) => (r.d ? r.d.relevant : true) === r.c.expect).length;
  const errors = rs.filter((r) => !r.d).length;
  const at = thresholds ? `（確率 ${thresholds.p} 以上か、重要度 ${thresholds.s} 以上で知らせる）` : "";
  console.log(`  正解 ${right}/${rs.length}${errors > 0 ? `（うち未判定で知らせた ${errors} 件）` : ""}${at}`);

  // Clef なら、しきい値ごとに見逃しと余計な通知を数える（判定エラーは未判定で知らせる側に数える）
  if (!thresholds || !rs.some((r) => r.d?.probability !== undefined)) return;
  console.log("  見逃し = 知らせるべきなのに知らせない / 余計 = 知らせなくてよいのに知らせる");
  console.log(`  確率のしきい値ごと（重要度のしきい値は ${thresholds.s} のまま）:`);
  for (const t of THRESHOLDS) console.log(`    ${t.toFixed(1)}: ${count(rs, t, thresholds.s)}`);
  console.log(`  重要度のしきい値ごと（確率のしきい値は ${thresholds.p} のまま）:`);
  for (const s of PRIORITY_THRESHOLDS) console.log(`    ${s > 3 ? "使わない" : s.toFixed(1)}: ${count(rs, thresholds.p, s)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = ((await Bun.file(args.cases).json()) as { cases: Case[] }).cases;
  const envHasProfile = Boolean(process.env.DECISION_PROFILE?.trim() || process.env.DECISION_PROFILE_FILE?.trim());
  const base = await baseConfig(!envHasProfile && args.profiles.length > 0);
  const thresholds = base.DECISION_PROVIDER === "clef" ? { p: base.CLEF_THRESHOLD, s: base.CLEF_PRIORITY_THRESHOLD } : null;
  console.log(`判定モデル: ${base.DECISION_PROVIDER} / ${base.decisionModel}、投稿 ${cases.length} 件`);

  const runs: { label: string; config: Config }[] = [];
  if (envHasProfile) runs.push({ label: ".env のプロフィール", config: base });
  for (const f of args.profiles) {
    const profile = (await Bun.file(f).text()).trim();
    runs.push({ label: `プロフィール ${f}`, config: { ...base, decisionProfile: profile } });
  }
  if (runs.length === 0) throw new ConfigError("DECISION_PROFILE か --profile-file でプロフィールを指定する");
  for (const r of runs) report(r.label, thresholds, await run(r.config, cases));
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `失敗: ${(err as Error).message}`);
  process.exit(1);
});
