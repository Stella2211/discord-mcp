// 自動起動の設定ファイルの中身。install.ts から使い、テストで中身を確かめる
import { join } from "node:path";

export const NAME = "pulsar-bot-notifier";
export const LABEL = "local.pulsar-bot.notifier";
export const WINDOWS_TASK = "pulsar-bot-notifier";

export function servicePath(platform: "linux" | "darwin", home: string): string {
  return platform === "linux"
    ? join(home, ".config", "systemd", "user", `${NAME}.service`)
    : join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

const uniq = (xs: string[]) => [...new Set(xs)];

// systemd の書き方（https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html）:
//   ExecStart= と Environment= は引用符で囲める。どちらも % は %% にする。ExecStart= では $ が変数展開されるので $$ にする
//   WorkingDirectory= は引用符を外さない（空白はそのまま書ける）。% だけ %% にする
const sdEscape = (s: string) => s.replace(/%/g, "%%");
const sdQuote = (s: string) => `"${sdEscape(s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))}"`;
const sdExecQuote = (s: string) => sdQuote(s).replace(/\$/g, "$$$$");

export function buildSystemdUnit(o: { pkgDir: string; bun: string; pathDirs: string[] }): string {
  const path = uniq([...o.pathDirs, "/usr/local/bin", "/usr/bin", "/bin"]).join(":");
  return [
    "[Unit]",
    "Description=discord-mcp Discord notifier",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${sdEscape(o.pkgDir)}`,
    `ExecStart=${sdExecQuote(o.bun)} src/main.ts`,
    `Environment=${sdQuote(`PATH=${path}`)}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildLaunchdPlist(o: { pkgDir: string; bun: string; pathDirs: string[]; logFile: string }): string {
  const path = uniq([...o.pathDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.bun)}</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(o.pkgDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(o.logFile)}</string>
</dict>
</plist>
`;
}

// PowerShell の単一引用符の文字列
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

// 動いているタスクを止める。ループの中の bun は PowerShell を止めても残ることがあるので、ロックファイルの pid も止める
export function buildWindowsStopScript(): string {
  return [
    `Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -ErrorAction SilentlyContinue`,
    `$lock = Join-Path ([System.IO.Path]::GetTempPath()) ${ps(`${NAME}.lock`)}`,
    // pid が別のプロセスに使い回されていることがあるので、bun のときだけ止める
    "if (Test-Path -LiteralPath $lock) { $p = Get-Process -Id ([int](Get-Content -LiteralPath $lock)) -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'bun') { Stop-Process -InputObject $p -Force } }",
  ].join("\n");
}

export function buildWindowsTaskScript(o: { pkgDir: string; bun: string; logFile: string; atStartup: boolean }): string {
  // 窓を出さずに起動し、出力をログファイルに追記する。タスク スケジューラの再起動は「起動に失敗したとき」しか効かないので、
  // プロセスが終わったら30秒後に起動し直すループを PowerShell の中で回す
  // *>> は Windows PowerShell 5 だと UTF-16 で書くので、Out-File で UTF-8 にする
  const inner = `Set-Location -LiteralPath ${ps(o.pkgDir)}; while ($true) { & ${ps(o.bun)} 'src/main.ts' *>&1 | Out-File -Append -Encoding utf8 -FilePath ${ps(o.logFile)}; Start-Sleep -Seconds 30 }`;
  const command = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${inner.replace(/"/g, '\\"')}"`;
  return [
    buildWindowsStopScript(),
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(command)} -WorkingDirectory ${ps(o.pkgDir)}`,
    o.atStartup
      ? "$trigger = New-ScheduledTaskTrigger -AtStartup"
      : "$trigger = New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\"",
    o.atStartup
      ? "$principal = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType S4U -RunLevel Limited"
      : "$principal = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK)}`,
  ].join("\n");
}
