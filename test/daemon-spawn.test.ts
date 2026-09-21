import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { daemonShellCommand } from "../src/adapters/pi/index.ts";

/** 桩程序代替 omp/pi：stdin 读到 EOF 才退出，用来观察 daemon 的 stdin 是否被提前关闭。 */
function writeStub(dir: string) {
  const stub = join(dir, "stub-daemon.sh");
  writeFileSync(stub, `#!/bin/bash\ncat > /dev/null\necho eof > "${dir}/eof"\n`, "utf8");
  chmodSync(stub, 0o755);
  return stub;
}

function spawnWith(command: string, cwd: string) {
  const child = spawn("bash", ["-lc", command], {
    detached: true,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

function processCommand(pid: number) {
  const lines = execFileSync("ps", ["-wwaxo", "pid=,command="], { encoding: "utf8" }).split("\n");
  return lines.map((line) => line.trim()).find((line) => line.startsWith(`${pid} `)) || "";
}

/** 机器上已有的 tail -f /dev/null（旧实现遗留的孤儿），用来断言不再新增。 */
function orphanTails() {
  return execFileSync("ps", ["-wwaxo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("tail -f /dev/null"))
    .map((line) => Number(line.split(/\s+/)[0]))
    .sort((a, b) => a - b);
}

test("daemon 启动命令：stdin 由一次性 FIFO 提供，daemon 退出后不留孤儿进程", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-daemon-fifo-"));
  const stub = writeStub(dir);
  const tailsBefore = orphanTails();
  const { child } = spawnWith(daemonShellCommand(stub, []), dir);
  t.after(() => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  await delay(1000);
  // bash 已被 exec 替换：这个 pid 就是 daemon 本身，不再有 launcher 夹在中间
  assert.match(processCommand(child.pid!), /stub-daemon\.sh/, "命令必须 exec 成 daemon，不留 launcher");
  // stdin 没有 EOF：桩程序仍阻塞在 FIFO 上
  assert.equal(existsSync(join(dir, "eof")), false, "daemon 的 stdin 不应提前 EOF");
  // FIFO 打开后立即 unlink，不落盘
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".fifo")), [], "FIFO 不应留在磁盘上");

  process.kill(-child.pid!, "SIGTERM");
  await delay(300);
  assert.equal(processCommand(child.pid!), "", "daemon 退出后不应残留进程");
  assert.deepEqual(orphanTails(), tailsBefore, "不应新增孤儿 tail -f /dev/null");
});

test("daemon 启动命令：FIFO 建不起来时报可见错误并以非零码退出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-daemon-fifo-bad-"));
  try {
    const stub = writeStub(dir);
    // 不存在的目录：mkfifo 必然失败，此时必须给出可诊断的错误，而不是静默起一个没有 stdin 的 daemon
    const { child, stderr } = spawnWith(daemonShellCommand(stub, [], join(dir, "missing")), dir);
    const code: number | null = await new Promise((resolve) => child.on("exit", (value) => resolve(value)));
    assert.equal(code, 1);
    assert.match(stderr(), /daemon stdin FIFO 不可用/);
    assert.equal(existsSync(join(dir, "eof")), false, "FIFO 失败时不应启动 daemon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
