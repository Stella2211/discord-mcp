#!/usr/bin/env bun
// discord-mcp の通知Bot（常駐PCで動かす）。
//   bun src/main.ts          起動
//   bun src/main.ts --check  設定・Botトークン・権限・duet-send・判定モデルを確かめて終わる（Duet には送らない）
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { createRest, DiscordApiError, type APIPartialGuild, type APIUser } from "@discord-mcp/discord";
import { Notifier } from "./app";
import { ConfigError, loadConfig, type Config } from "./config";
import { createDecisionModel } from "./decision";
import { Directory } from "./directory";
import { childEnv, DuetQueue, DuetRouter, duetSender, FAILURE_STREAK, killInflightSends } from "./duet";
import { Gateway } from "./gateway";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// アプリのフラグ（https://docs.discord.com/developers/resources/application#application-object-application-flags）
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

// 同じPCで2つ動くと通知が重複するので、ロックファイルで1つに限る。
// 作るときは排他（wx）で作る。残っていたロックは、書いた pid が動いていないか、PC の起動より前に書かれたものなら捨てる
const LOCK = join(tmpdir(), "pulsar-bot-notifier.lock");

function lockIsStale(): boolean {
  let pid: number;
  let mtime: number;
  try {
    pid = Number(readFileSync(LOCK, "utf8").trim());
    mtime = statSync(LOCK).mtimeMs;
  } catch {
    return true;
  }
  if (!pid || pid === process.pid) return true;
  // 再起動のあとは pid が使い回されるので、起動より前のロックは中身を見ずに捨てる
  if (mtime < Date.now() - uptime() * 1000) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") throw new Error(`別のユーザーで動いています（pid ${pid}）`);
    return code === "ESRCH";
  }
}

function takeLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!lockIsStale()) {
        throw new Error(`すでに動いています（pid ${readFileSync(LOCK, "utf8").trim()}）。二重に起動すると通知が重複します`);
      }
      rmSync(LOCK, { force: true });
    }
  }
  throw new Error("ロックファイルを作れない（ほかのプロセスと同時に起動した）");
}

function releaseLock(): void {
  try {
    if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK);
  } catch {
    // 消せなくても、次の起動で pid と作成時刻を見て捨てる
  }
}

async function check(c: Config): Promise<boolean> {
  const rest = createRest({ token: c.DISCORD_BOT_TOKEN });
  let ok = true;
  const step = (good: boolean, msg: string) => {
    console.log(`${good ? "ok  " : "NG  "} ${msg}`);
    if (!good) ok = false;
  };
  try {
    const me = await rest.get<APIUser>("/users/@me");
    step(true, `Botトークン: ${me.username}（id ${me.id}）としてログインできる`);
    step(me.id !== c.TARGET_USER_ID, "TARGET_USER_ID が Bot 自身ではない（あなた自身のユーザーIDを入れる）");
    const app = await rest.get<{ flags?: number }>("/applications/@me");
    const flags = app.flags ?? 0;
    step(
      (flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0,
      "Message Content Intent がオン（Developer Portal の Bot ページ）",
    );
    const guilds = await rest.get<APIPartialGuild[]>("/users/@me/guilds", { limit: 200 });
    step(guilds.length > 0, `参加しているサーバー: ${guilds.map((g) => g.name).join(", ") || "なし"}`);
    for (const id of c.ALLOWED_GUILD_IDS) step(guilds.some((g) => g.id === id), `ALLOWED_GUILD_IDS の ${id} に Bot が入っている`);
    const targets = c.ALLOWED_GUILD_IDS.length > 0 ? c.ALLOWED_GUILD_IDS : guilds.map((g) => g.id);
    for (const id of targets) {
      try {
        await rest.get(`/guilds/${id}/members/${c.TARGET_USER_ID}`);
        step(true, `TARGET_USER_ID はサーバー ${id} のメンバー`);
      } catch (err) {
        step(false, `TARGET_USER_ID がサーバー ${id} に見つからない（${(err as Error).message}）`);
      }
    }
  } catch (err) {
    step(false, `Discord に接続できない（${err instanceof DiscordApiError && err.status === 401 ? "Botトークンが正しくない" : (err as Error).message}）`);
  }

  step(existsSync(c.DUET_SEND_PATH), `DUET_SEND_PATH が存在する: ${c.DUET_SEND_PATH}`);
  if (existsSync(c.DUET_SEND_PATH)) {
    // 本番と同じく、duet-send のフォルダで、この Bot のシークレットを渡さずに動かす
    const dryRun = async (label: string, to?: string) => {
      const args = ["--dry-run", "--tag", c.DUET_TAG, ...(to !== undefined ? ["--to", to] : []), "discord-mcp の設定確認"];
      const proc = Bun.spawn([process.execPath, c.DUET_SEND_PATH, ...args], {
        cwd: dirname(c.DUET_SEND_PATH),
        env: childEnv(process.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      step(code === 0, `${label}${code === 0 ? "" : `: ${(err || out).trim().slice(0, 300)}`}`);
    };
    await dryRun("duet-send の dry run");
    // 宛先の名前が duet-send の routes に無いと送れないので、設定した宛先を1つずつ確かめる
    for (const route of new Set(c.DUET_ROUTES.values())) await dryRun(`duet-send の dry run（宛先 ${route}）`, route);
  }

  const model = createDecisionModel(c);
  if (!model) {
    step(true, "判定モデル: なし（判定せず、すべての投稿をそのまま通知する）");
  } else {
    try {
      const d = await model.decide({
        guildName: "テスト",
        channelName: "general",
        messages: [
          { author: "Aさん", at: "", content: "今日のお昼どうする？", isNew: false },
          { author: "Bさん", at: "", content: "カレーにしよう", isNew: true },
        ],
      });
      step(true, `判定モデル ${model.name} が応答した（雑談の例に relevant=${d.relevant}）`);
    } catch (err) {
      step(false, `判定モデル ${model.name} を呼べない（${(err as Error).message}）`);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(2);
  }

  if (process.argv.includes("--check")) process.exit((await check(config)) ? 0 : 1);

  takeLock();
  const rest = createRest({ token: config.DISCORD_BOT_TOKEN });
  // 宛先（duet-send の --to）ごとのキュー。宛先が違う通知は1通にまとめない
  const queue = new DuetRouter(
    (route) =>
      new DuetQueue({
        send: duetSender({ scriptPath: config.DUET_SEND_PATH, tag: config.DUET_TAG, route, dryRun: config.DUET_DRY_RUN }),
        minIntervalMs: config.NOTIFY_MIN_INTERVAL_SECONDS * 1000,
        log: route === undefined ? log : (m) => log(`${m}（宛先 ${route}）`),
        // 宛先つきのキューが続けて失敗したら、既定の宛先に1回だけ知らせる（既定のキュー自身は知らせる先がない）
        onFailureStreak:
          route === undefined
            ? undefined
            : (err) =>
                queue.push(
                  `Duet の宛先「${route}」に Discord の通知を送れていません（${FAILURE_STREAK}回続けて失敗）。duet-send の宛先表にその名前があるか確かめてください。最後のエラー: ${err.message.slice(0, 200)}`,
                ),
      }),
  );
  const model = createDecisionModel(config);
  const directory = new Directory(rest, config.TARGET_USER_ID);
  const notifier = new Notifier({ config, rest, directory, model, queue, log, debug: config.LOG_LEVEL === "debug" ? log : undefined });
  const gateway = new Gateway({
    token: config.DISCORD_BOT_TOKEN,
    rest,
    log,
    onDispatch: (event, data) => notifier.onDispatch(event, data),
    onFatal: (reason) => {
      // 設定を直すまで再接続しても無駄なので、止まったことを知らせて待機する（サービスの自動再起動で Identify を浪費しない）
      queue.push(`Discord 通知Botが止まりました: ${reason}。設定を直してから、サービスを再起動してください。`);
    },
  });

  // 終了時は、未送信の通知をできるだけ送ってから終える（送信中なら終わるのを待つ）。最大60秒
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("notifier: 終了します");
    gateway.stop();
    const deadline = Date.now() + 60_000;
    let failed = 0;
    while ((queue.size > 0 || queue.busy) && Date.now() < deadline && failed < 2) {
      // 送信中のキューは flush が何もしないので、毎回呼んで、ほかの宛先の待機中のキューも送る
      const before = queue.size;
      const wasBusy = queue.busy;
      await queue.flush();
      if (wasBusy || queue.busy) {
        await Bun.sleep(500);
        continue;
      }
      if (queue.size >= before) failed += 1;
    }
    // 待ち時間が過ぎても送信中なら、duet-send を子ごと止める（専用のプロセスグループで動くので、終了のシグナルは届かない）
    if (queue.busy) {
      const killed = killInflightSends();
      if (killed > 0) log(`notifier: 送信中の duet-send ${killed} 件を止めて終了`);
    }
    if (queue.size > 0) log(`notifier: 未送信の ${queue.size} 件を残して終了`);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log(`notifier: 起動（判定モデル: ${model?.name ?? "なし"}${config.DUET_DRY_RUN ? "、DUET_DRY_RUN" : ""}）`);
  await gateway.start();
  // Gateway が止まっても（致命的なエラー）プロセスは残す。ハートビート代わりに定期ログ
  setInterval(() => log(`notifier: 稼働中（接続 ${gateway.connected ? "あり" : "なし"}、判定待ち ${notifier.pendingChannels} チャンネル、未送信 ${queue.size} 件）`), 3600_000);
}

await main();
