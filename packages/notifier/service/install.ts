#!/usr/bin/env bun
// 通知Botを OS の起動（ログイン）時に自動で立ち上げる設定を入れる / 外す。
//   bun run service:install            入れる（すでにあれば置き換える）
//   bun run service:uninstall          外す
//   bun service/install.ts install --dry-run   書く内容を表示するだけ
//   bun service/install.ts install --at-startup  Windows のみ：ログイン前の起動時に動かす（管理者の PowerShell から）
//
// Linux: systemd のユーザーサービス（~/.config/systemd/user/pulsar-bot-notifier.service）。
//        ログインしていなくても起動時に動かすには `loginctl enable-linger` が要る（下で案内する）。
// macOS: LaunchAgent（~/Library/LaunchAgents/local.pulsar-bot.notifier.plist）。ログイン時に起動する。
// Windows: タスク スケジューラのタスク「pulsar-bot-notifier」。ログオン時に起動し、落ちたら30秒後に起動し直す。
//
// どれも、落ちたら自動で再起動する。プロセスの中でも Discord との切断から自動で再接続する。
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildLaunchdPlist, buildSystemdUnit, buildWindowsStopScript, buildWindowsTaskScript, LABEL, NAME, servicePath, WINDOWS_TASK } from "./templates";

const args = process.argv.slice(2);
const action = args[0];
const dryRun = args.includes("--dry-run");
const atStartup = args.includes("--at-startup");
if (action !== "install" && action !== "uninstall") {
  console.error("usage: bun service/install.ts install|uninstall [--dry-run] [--at-startup]");
  process.exit(2);
}

const pkgDir = resolve(import.meta.dir, "..");
const bun = process.execPath;
const claude = Bun.which("claude");
const pathDirs = [dirname(bun), ...(claude ? [dirname(claude)] : [])];
const home = homedir();

if (action === "install" && !existsSync(join(pkgDir, ".env"))) {
  console.error(`先に ${join(pkgDir, ".env")} を作ってください（.env.example をコピー）。`);
  process.exit(1);
}
if (action === "install" && !claude) console.warn("注意: PATH に claude が見つかりません。.env に DUET_CLAUDE_BIN（claude のフルパス）を書いてください。");

async function run(cmd: string[], allowFail = false): Promise<number> {
  console.log(`$ ${cmd.join(" ")}`);
  if (dryRun) return 0;
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0 && !allowFail) {
    console.error(`失敗しました（終了コード ${code}）`);
    process.exit(code);
  }
  return code;
}

function write(path: string, content: string): void {
  console.log(`--- ${path}\n${content}`);
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

if (process.platform === "linux") {
  const unit = servicePath("linux", home);
  if (action === "install") {
    write(unit, buildSystemdUnit({ pkgDir, bun, pathDirs }));
    await run(["systemctl", "--user", "daemon-reload"]);
    await run(["systemctl", "--user", "enable", "--now", `${NAME}.service`]);
    await run(["systemctl", "--user", "restart", `${NAME}.service`]);
    console.log(
      `\n入れました。ログ: journalctl --user -u ${NAME} -f\n` +
        `ログインしていなくても起動時に動かすには、一度だけ次を実行してください:\n  sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    );
  } else {
    await run(["systemctl", "--user", "disable", "--now", `${NAME}.service`], true);
    if (!dryRun) rmSync(unit, { force: true });
    await run(["systemctl", "--user", "daemon-reload"], true);
    console.log("外しました。");
  }
} else if (process.platform === "darwin") {
  const plist = servicePath("darwin", home);
  const uid = process.getuid?.() ?? 0;
  const logFile = join(home, "Library", "Logs", `${NAME}.log`);
  await run(["launchctl", "bootout", `gui/${uid}/${LABEL}`], true);
  // bootout は非同期に終わるので、すぐ bootstrap すると失敗することがある
  if (!dryRun) await Bun.sleep(1500);
  if (action === "install") {
    write(plist, buildLaunchdPlist({ pkgDir, bun, pathDirs, logFile }));
    await run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
    console.log(`\n入れました。ログ: tail -f "${logFile}"`);
  } else {
    if (!dryRun) rmSync(plist, { force: true });
    console.log("外しました。");
  }
} else if (process.platform === "win32") {
  const logFile = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), NAME, `${NAME}.log`);
  const script =
    action === "install"
      ? buildWindowsTaskScript({ pkgDir, bun, logFile, atStartup })
      : `${buildWindowsStopScript()}\nUnregister-ScheduledTask -TaskName '${WINDOWS_TASK}' -Confirm:$false -ErrorAction SilentlyContinue`;
  console.log(`--- PowerShell\n${script}`);
  if (!dryRun) {
    if (action === "install") mkdirSync(dirname(logFile), { recursive: true });
    await run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  }
  console.log(action === "install" ? `\n入れました。ログ: ${logFile}` : "外しました。");
} else {
  console.error(`この OS（${process.platform}）には対応していません`);
  process.exit(1);
}
