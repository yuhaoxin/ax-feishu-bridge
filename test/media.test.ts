import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeMediaFile, resolveMediaPath } from "../src/feishu/media.ts";

test("出站媒体：相对路径按会话目录解析，~ 展开为家目录", () => {
  assert.equal(resolveMediaPath("shot.png", "/ws/demo"), "/ws/demo/shot.png");
  assert.equal(resolveMediaPath("  /abs/shot.png  ", undefined), "/abs/shot.png");
  assert.equal(resolveMediaPath("~/Pictures/a.png", "/ws/demo"), join(homedir(), "Pictures/a.png"));
  assert.equal(resolveMediaPath("~", "/ws/demo"), homedir());
  assert.equal(resolveMediaPath("../上翻/shot.png", "/ws/demo"), "/ws/上翻/shot.png");
  // 没有工作目录时相对路径无法确定含义，必须在本地报错而不是猜
  assert.throws(() => resolveMediaPath("shot.png", undefined), /绝对路径或 ~\//);
  assert.throws(() => resolveMediaPath("   ", "/ws/demo"), /需要媒体文件路径/);
});

test("出站媒体：校验存在性、目录、空文件、体积与图片后缀", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-media-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = join(dir, "shot.png");
  writeFileSync(png, Buffer.alloc(64, 7));
  assert.deepEqual(describeMediaFile(png, "image"), { path: png, name: "shot.png", size: 64 });
  // 任意后缀都能当文件发，但 push_image 只接受图片后缀
  const txt = join(dir, "note.txt");
  writeFileSync(txt, "hello");
  assert.equal(describeMediaFile(txt, "file").size, 5);
  assert.throws(() => describeMediaFile(txt, "image"), /不是图片/);
  assert.throws(() => describeMediaFile(join(dir, "missing.png"), "image"), /文件不存在/);
  assert.throws(() => describeMediaFile(dir, "file"), /不是普通文件/);
  const empty = join(dir, "empty.png");
  writeFileSync(empty, "");
  assert.throws(() => describeMediaFile(empty, "image"), /文件为空/);
  // 上限判定用稀疏文件，避免测试写入几十 MB
  const bigImage = join(dir, "big.png");
  writeFileSync(bigImage, Buffer.alloc(1));
  truncateSync(bigImage, 10 * 1024 * 1024 + 1);
  assert.throws(() => describeMediaFile(bigImage, "image"), /图片超过飞书 10 MB 上限/);
  const bigFile = join(dir, "big.bin");
  writeFileSync(bigFile, Buffer.alloc(1));
  truncateSync(bigFile, 30 * 1024 * 1024 + 1);
  assert.throws(() => describeMediaFile(bigFile, "file"), /文件超过飞书 30 MB 上限/);
  // 非绝对路径只可能来自协议误用：拒绝而不是按网关进程的 cwd 猜
  assert.throws(() => describeMediaFile("shot.png", "image"), /必须是绝对路径/);
  const sub = join(dir, "sub");
  mkdirSync(sub);
  assert.throws(() => describeMediaFile(sub, "image"), /不是普通文件/);
});
