import { expect, test } from "bun:test";
import { buildLaunchdPlist, buildSystemdUnit, buildWindowsTaskScript, LABEL } from "../service/templates";

test("systemd unit quotes paths and restarts", () => {
  const u = buildSystemdUnit({ pkgDir: "/home/a b/discord-mcp/packages/notifier", bun: "/home/a b/.bun/bin/bun", pathDirs: ["/home/a b/.bun/bin"] });
  expect(u).toContain("WorkingDirectory=/home/a b/discord-mcp/packages/notifier\n");
  expect(u).toContain('ExecStart="/home/a b/.bun/bin/bun" src/main.ts');
  expect(u).toContain("Restart=always");
  expect(u).toContain("WantedBy=default.target");
});

test("systemd unit escapes % and $", () => {
  const u = buildSystemdUnit({ pkgDir: "/srv/50%/pb", bun: "/opt/$x/bun", pathDirs: [] });
  expect(u).toContain("WorkingDirectory=/srv/50%%/pb\n");
  expect(u).toContain('ExecStart="/opt/$$x/bun" src/main.ts');
});

test("launchd plist escapes XML", () => {
  const p = buildLaunchdPlist({ pkgDir: "/Users/x/a&b", bun: "/opt/bun", pathDirs: [], logFile: "/tmp/l.log" });
  expect(p).toContain(`<string>${LABEL}</string>`);
  expect(p).toContain("/Users/x/a&amp;b");
  expect(p).toContain("<key>KeepAlive</key><true/>");
});

test("windows script restarts in a loop and quotes single quotes", () => {
  const s = buildWindowsTaskScript({ pkgDir: "C:\\Users\\o'neil\\pb", bun: "C:\\bun.exe", logFile: "C:\\l.log", atStartup: false });
  expect(s).toContain("while ($true)");
  expect(s).toContain("o''''neil"); // 内側と外側の2回、単一引用符を重ねる
  expect(s).toContain("-AtLogOn");
  expect(s).toContain("Stop-ScheduledTask");
  expect(buildWindowsTaskScript({ pkgDir: "C:\\pb", bun: "C:\\bun.exe", logFile: "C:\\l.log", atStartup: true })).toContain("-LogonType S4U");
});
