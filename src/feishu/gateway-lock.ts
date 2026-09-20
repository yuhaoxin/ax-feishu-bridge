import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { debugLog } from "./debug.ts";
import { ompAgentDir, getRuntimeSource } from "./config.ts";

/** 兼容旧版锁（未按 appId 区分时的固定 key）。 */
const LEGACY_LOCK_KEY = "pi-feishu-lark.feishu-gateway";
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * 锁文件选址：按当前 runtime source 区分。
 * pi 沿用老位置（~/.pi/agent/locks.json），omp 用 ~/.omp/agent/locks.json，
 * 纯 dsh 环境放进 dsh 家目录，不再凭空创建 ~/.pi。
 * omp 与 pi 各持一份锁文件：同一机器人在两个 runtime 里的连接互不协商，
 * 用户需自行保证同一 appId 只在一个 runtime 启用（跨 runtime 抢同一
 * 飞书长连接时，两端都会显示连接成功，实际事件只会送达其中一边）。
 */
let locksPath: string | undefined;

function resolveLocksPath(): string {
  let runtimeId: "pi" | "harness" | "omp" = "pi";
  try {
    runtimeId = getRuntimeSource().id;
  } catch {
    // currentSource 尚未初始化时按 pi 兜底
  }
  if (runtimeId === "omp") return join(ompAgentDir(), "locks.json");
  if (existsSync(PI_AGENT_DIR)) return join(PI_AGENT_DIR, "locks.json");
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, "locks.json");
}
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 40;
const HEARTBEAT_MS = 5_000;

/**
 * 锁按机器人凭证（appId）区分：不同机器人各拿各的钥匙，可并行；
 * 同一机器人（误配）仍互斥，避免抢同一个飞书连接。
 */
function lockKeyFor(appId: string | undefined) {
  return appId ? `ax-feishu-bridge.gateway.${appId}` : LEGACY_LOCK_KEY;
}

function currentLocksPath(): string {
  locksPath ??= resolveLocksPath();
  return locksPath;
}

export type GatewayOwner = {
  key: string;
  pid: number;
  token: string;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  status: "starting" | "connected" | "disconnected";
};

type LocksFile = Record<string, unknown>;

export type GatewayLockResult =
  | { status: "acquired"; handle: GatewayLockHandle }
  | { status: "busy"; owner: GatewayOwner };

export class GatewayLockHandle {
  private heartbeat: NodeJS.Timeout | undefined;
  private onLost: (() => void | Promise<void>) | undefined;
  readonly owner: GatewayOwner;

  constructor(owner: GatewayOwner) {
    this.owner = owner;
  }

  setOnLost(handler: () => void | Promise<void>) {
    this.onLost = handler;
  }

  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.update("connected").catch((error) => {
        debugLog("feishu.gateway.heartbeat_error", { error: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async update(status: GatewayOwner["status"]) {
    let lostOwnership = false;
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[this.owner.key], this.owner.key);
      if (!current || current.token !== this.owner.token || current.pid !== this.owner.pid) {
        this.stopHeartbeat();
        lostOwnership = true;
        return;
      }
      const next: GatewayOwner = {
        ...current,
        heartbeatAt: new Date().toISOString(),
        status,
      };
      locks[this.owner.key] = next;
      writeLocksFile(locks);
    });
    if (lostOwnership) {
      debugLog("feishu.gateway.lock_lost", { pid: this.owner.pid });
      await this.onLost?.();
    }
  }

  async release() {
    this.stopHeartbeat();
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[this.owner.key], this.owner.key);
      if (current?.token === this.owner.token && current.pid === this.owner.pid) {
        delete locks[this.owner.key];
        writeLocksFile(locks);
        debugLog("feishu.gateway.lock_released", { pid: this.owner.pid });
      }
    });
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export async function acquireGatewayLock(cwd: string, force = false, appId?: string): Promise<GatewayLockResult> {
  const key = lockKeyFor(appId);
  return withLocksFileLock(() => {
    const locks = readLocksFile();
    const existing = asGatewayOwner(locks[key], key);
    if (existing && !force && !isStale(existing)) {
      debugLog("feishu.gateway.lock_busy", {
        ownerPid: existing.pid,
        heartbeatAt: existing.heartbeatAt,
        currentPid: process.pid,
      });
      return { status: "busy", owner: existing };
    }

    const owner: GatewayOwner = {
      key,
      pid: process.pid,
      token: randomToken(),
      cwd,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "starting",
    };
    locks[key] = owner;
    writeLocksFile(locks);
    debugLog("feishu.gateway.lock_acquired", {
      pid: owner.pid,
      cwd,
      replacedPid: existing?.pid,
      force,
    });
    return { status: "acquired", handle: new GatewayLockHandle(owner) };
  });
}

export function readGatewayOwner(appId?: string): GatewayOwner | undefined {
  const key = lockKeyFor(appId);
  const owner = asGatewayOwner(readLocksFile()[key], key);
  return owner && !isStale(owner) ? owner : undefined;
}

export function gatewayLockPath() {
  return currentLocksPath();
}

function asGatewayOwner(value: unknown, expectedKey: string): GatewayOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GatewayOwner>;
  if (raw.key !== expectedKey) return undefined;
  if (typeof raw.pid !== "number" || typeof raw.token !== "string") return undefined;
  if (typeof raw.cwd !== "string" || typeof raw.startedAt !== "string" || typeof raw.heartbeatAt !== "string") return undefined;
  if (raw.status !== "starting" && raw.status !== "connected" && raw.status !== "disconnected") return undefined;
  return raw as GatewayOwner;
}

function isStale(owner: GatewayOwner) {
  if (!isProcessAlive(owner.pid)) return true;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return true;
  return Date.now() - heartbeatAt > LOCK_STALE_MS;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readLocksFile(): LocksFile {
  const path = currentLocksPath();
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as LocksFile;
  } catch {
    return {};
  }
}

function writeLocksFile(locks: LocksFile) {
  const path = currentLocksPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
}

async function withLocksFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${currentLocksPath()}.lock`;
  mkdirSync(dirname(currentLocksPath()), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (tryAcquireFileLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(LOCK_RETRY_MS);
  }

  debugLog("feishu.gateway.file_lock_timeout", { lockPath });
  return await fn();
}

function tryAcquireFileLock(lockPath: string) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
