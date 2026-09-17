/**
 * 连接锁按机器人凭证（appId）区分的测试：
 * - 不同机器人：各拿各的钥匙，可并行获取
 * - 同一机器人：互斥，后来的拿不到
 * - 释放后同机器人可再次获取
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在导入前设置 HOME：LOCKS_PATH 在模块加载时基于它计算，
// 运行时再改 HOME 不会改变已定型的路径，会把测试写入真实 ~/.pi/agent/locks.json。
const homeDir = mkdtempSync(join(tmpdir(), "feishu-lock-test-"));
process.env.HOME = homeDir;
const { acquireGatewayLock, gatewayLockPath } = await import("../src/feishu/gateway-lock.ts");

test("gateway lock is per-appId: different bots can hold locks in parallel", async () => {
  try {
    const botA = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(botA.status, "acquired");
    const botB = await acquireGatewayLock("/tmp/ws", false, "app-bot-b");
    assert.equal(botB.status, "acquired", "different bot should get its own lock");

    await botA.handle.release();
    await botB.handle.release();
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("gateway lock is per-appId: same bot stays exclusive", async () => {
  const botA = await acquireGatewayLock("/tmp/ws", false, "app-same-bot");
  assert.equal(botA.status, "acquired");

  const botB = await acquireGatewayLock("/tmp/ws", false, "app-same-bot");
  assert.equal(botB.status, "busy", "same bot should be exclusive");
  if (botB.status === "busy") {
    assert.equal(botB.owner.pid, process.pid, "owner should be this process");
  }

  await botA.handle.release();
  const botC = await acquireGatewayLock("/tmp/ws", false, "app-same-bot");
  assert.equal(botC.status, "acquired", "after release, same bot can acquire again");
  await botC.handle.release();
  assert.ok(gatewayLockPath().startsWith(homeDir), "lock file must live in the isolated home");
});
