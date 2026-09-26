import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { RelayClient } from "../src/adapters/pi/relay-client.ts";
import type { RelayTransport } from "../src/adapters/pi/relay-output.ts";
import type { FeishuMessage } from "../src/feishu/types.ts";

export function fakeTransport() {
  const topics: string[] = [];
  const renames: Array<{ root: string; title: string }> = [];
  const text: Array<{ root: string; text: string }> = [];
  const cards: Array<{ root: string; card: any }> = [];
  const uploads: Array<{ kind: string; path: string; name: string }> = [];
  const media: Array<{ root: string; kind: string; key: string }> = [];
  const transport: RelayTransport = {
    async verifyTopicChat(chat, owner) { assert.equal(chat, "oc_test"); assert.equal(owner, "ou_owner"); },
    async createRelayTopic(_chat, title) {
      topics.push(title);
      return { threadId: `omt_${topics.length}`, rootMessageId: `om_${topics.length}` };
    },
    async replyRelayText(root, value) { text.push({ root, text: value }); },
    async replyRelayCard(root, card) { cards.push({ root, card }); return `om_card${cards.length}`; },
    async uploadRelayMedia(kind, path, name) { uploads.push({ kind, path, name }); return `${kind}_key`; },
    async replyRelayMedia(root, kind, key) { media.push({ root, kind, key }); return `om_media${media.length}`; },
    async updateRelayCard() {},
    async renameRelayTitle(root, title) { renames.push({ root, title }); },
  };
  return { topics, renames, text, cards, uploads, media, transport };
}

function incoming(threadId: string, messageId: string, senderOpenId = "ou_owner"): FeishuMessage {
  return { chatId: "oc_test", chatType: "group", threadId, messageId, senderOpenId, msgType: "text", content: JSON.stringify({ text: "继续任务" }) };
}

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-test-"));
  const state = join(dir, "state.json");
  const endpoint = join(dir, "endpoint.json");
  const fake = fakeTransport();
  const gateway = new RelayGateway(state, endpoint, "app_test", fake.transport);
  await gateway.start();
  const clients: RelayClient[] = [];
  const client = (id: string, receive = async (_method: string, _params: any) => ({ accepted: true })) => {
    const result = new RelayClient(endpoint, id, receive);
    clients.push(result);
    return result;
  };
  t.after(async () => { clients.forEach((c) => c.close()); await gateway.stop(); rmSync(dir, { recursive: true, force: true }); });
  const a = client("session-a");
  await a.request("configure", { chatId: "oc_test", ownerOpenId: "ou_owner" });
  return { ...fake, gateway, state, endpoint, client, a };
}

test("接力：两个真实 TCP 客户端独立自动绑定，授权、去重及忙时回执", async (t) => {
  const f = await fixture(t);
  const first = await f.a.request("autobindTopic", { title: "会话 A", firstInput: "首条输入 A" });
  assert.equal(first.created, true);
  const bindingA = first.binding;
  const inputs: any[] = [];
  const b = f.client("session-b", async (method, params) => { inputs.push({ method, params }); return { accepted: true, busy: true }; });
  await b.request("configure", { chatId: "oc_test", ownerOpenId: "ou_owner" });
  const second = await b.request("autobindTopic", { title: "会话 B", firstInput: "首条输入 B" });
  const binding = second.binding;
  assert.notEqual(bindingA.threadId, binding.threadId);
  // 已绑定后重复自动绑定幂等，不新建话题
  const again = await b.request("autobindTopic", { title: "会话 B", firstInput: "首条输入 B" });
  assert.equal(again.binding.threadId, binding.threadId);
  assert.equal(f.topics.length, 2);
  assert.equal(await f.gateway.handleMessage(incoming(binding.threadId, "unauthorized", "ou_stranger")), true);
  assert.equal(inputs.length, 0);
  assert.equal(await f.gateway.handleMessage(incoming(binding.threadId, "message-1")), true);
  await f.gateway.handleMessage(incoming(binding.threadId, "message-1"));
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].params.sessionId, "session-b");
  assert.match(f.text[0].text, /引导当前任务/);
  assert.equal(await f.gateway.handleMessage(incoming("omt_unbound", "message-2")), false);
  await assert.rejects(b.request("configure", { chatId: "oc_another", ownerOpenId: "ou_owner" }), /不允许更换/);
  assert.equal(statSync(f.endpoint).mode & 0o777, 0o600);
  assert.equal(statSync(f.state).mode & 0o777, 0o600);
});

test("接力：开关关闭 / 退出名单 / 改名同步", async (t) => {
  const f = await fixture(t);
  // 全局关闭：不创建话题
  await f.a.request("autobind", { enabled: false });
  assert.equal((await f.a.request("autobindTopic", { title: "X", firstInput: "关闭时输入" })).created, false);
  await f.a.request("autobind", { enabled: true });
  const created = await f.a.request("autobindTopic", { title: "来自终端", firstInput: "来自终端" });
  assert.equal(created.created, true);
  const binding = created.binding;
  assert.match(binding.title, /来自终端 \[session-/);
  // 会话名变化：patch 根消息改名，话题不变
  await f.a.request("rename", { title: "新会话名" });
  assert.equal(f.renames.at(-1)!.root, binding.rootMessageId);
  assert.equal((await f.a.request("status")).binding.title, "新会话名 [session-]");
  // unbind：解绑并进退出名单；旧话题继续拦截
  await f.a.request("unbind");
  await f.gateway.handleMessage(incoming(binding.threadId, "after-unbind"));
  assert.match(f.text.at(-1)!.text, /解绑/);
  assert.equal((await f.a.request("autobindTopic", { title: "想回来", firstInput: "想回来" })).created, false);
  assert.equal(f.topics.length, 1);
  const state = JSON.parse(readFileSync(f.state, "utf8"));
  assert.ok(state.optOut.includes("session-a"));
});

test("接力：离线拒绝，不回落后台，不在重连后重放", async (t) => {
  const f = await fixture(t);
  const created = await f.a.request("autobindTopic", { title: "A", firstInput: "首条输入 A" });
  const binding = created.binding;
  f.a.close();
  // status 请求提供一个事件循环屏障，确保服务端已处理断开。
  const observer = f.client("observer");
  await observer.request("status");
  await f.gateway.handleMessage(incoming(binding.threadId, "offline"));
  assert.match(f.text.at(-1)!.text, /离线/);
  const received: any[] = [];
  const reopened = f.client("session-a", async (_method, params) => { received.push(params); return { accepted: true }; });
  assert.equal((await reopened.request("status")).binding.threadId, binding.threadId);
  await f.gateway.handleMessage(incoming(binding.threadId, "offline"));
  assert.equal(received.length, 0);
  await f.gateway.handleMessage(incoming(binding.threadId, "new"));
  assert.equal(received.length, 1);
});

test("接力：活跃会话不可被第二个终端抢占；错误 token 被拒绝", async (t) => {
  const f = await fixture(t);
  const duplicate = f.client("session-a");
  await assert.rejects(duplicate.request("status"), /另一个终端/);
  const endpoint = JSON.parse(readFileSync(f.endpoint, "utf8"));
  const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
  await once(socket, "connect");
  const closed = once(socket, "close");
  socket.write(JSON.stringify({ id: "bad", method: "register", params: { sessionId: "evil" }, token: "wrong" }) + "\n");
  await closed;
  assert.equal(f.topics.length, 0);
});

test("接力：收讫前断联提示不确定，不能自动重试", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const b = f.client("b", async () => { calls++; b.close(); return { accepted: true }; });
  const created = await b.request("autobindTopic", { title: "B", firstInput: "首条输入 B" });
  await f.gateway.handleMessage(incoming(created.binding.threadId, "uncertain"));
  assert.match(f.text.at(-1)!.text, /未确认/);
  await f.gateway.handleMessage(incoming(created.binding.threadId, "uncertain"));
  assert.equal(calls, 1);
});

test("接力：正式答案只发一次，长内容分块且保持同一话题", async (t) => {
  const f = await fixture(t);
  const created = await f.a.request("autobindTopic", { title: "A", firstInput: "首条输入 A" });
  const binding = created.binding;
  const answer = "正式回复".repeat(4000);
  await f.a.output({ id: "turn-1", text: answer });
  assert.equal(f.cards.map((c) => c.card.elements[0].content).join(""), answer);
  assert.ok(f.cards.every((c) => c.root === binding.rootMessageId));
  const count = f.cards.length;
  await assert.rejects(f.a.output({ id: "turn-1", text: answer }), /不会重复发送/);
  assert.equal(f.cards.length, count);
  await f.a.request("push", { text: "主动通知" });
  assert.equal(f.text.at(-1)!.text, "主动通知");
});

test("接力：出站媒体按本地校验上传后回到同一话题", async (t) => {
  const f = await fixture(t);
  const created = await f.a.request("autobindTopic", { title: "A", firstInput: "首条输入 A" });
  const root = created.binding.rootMessageId;
  const dir = mkdtempSync(join(tmpdir(), "relay-media-gateway-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shot = join(dir, "shot.png");
  writeFileSync(shot, Buffer.alloc(32, 3));
  await f.a.request("push_image", { path: shot });
  assert.deepEqual(f.uploads.at(-1), { kind: "image", path: shot, name: "shot.png" });
  assert.deepEqual(f.media.at(-1), { root, kind: "image", key: "image_key" });
  await f.a.request("push_file", { path: shot });
  assert.deepEqual(f.uploads.at(-1), { kind: "file", path: shot, name: "shot.png" });
  assert.deepEqual(f.media.at(-1), { root, kind: "file", key: "file_key" });
  // 网关不信任终端传来的路径：不存在、类型不符或未绝对化的都在上传前拦掉
  const before = f.uploads.length;
  await assert.rejects(f.a.request("push_image", { path: join(dir, "missing.png") }), /文件不存在/);
  await assert.rejects(f.a.request("push_file", { path: join(dir, "missing.png") }), /文件不存在/);
  const note = join(dir, "note.txt");
  writeFileSync(note, "hi");
  await assert.rejects(f.a.request("push_image", { path: note }), /不是图片/);
  await assert.rejects(f.a.request("push_file", { path: dir }), /不是普通文件/);
  await assert.rejects(f.a.request("push_image", { path: "relative.png" }), /必须是绝对路径/);
  await assert.rejects(f.a.request("push_image", {}), /需要非空文本/);
  assert.equal(f.uploads.length, before, "校验失败不能产生上传");
});

test("接力：话题创建超时后持久阻断重试及普通后台回落", async (t) => {
  const f = await fixture(t);
  let creates = 0;
  f.transport.createRelayTopic = async () => { creates++; throw new Error("远端创建结果未确认"); };
  await assert.rejects(f.a.request("autobindTopic", { title: "不确定话题", firstInput: "重试输入" }), /未确认/);
  await assert.rejects(f.a.request("autobindTopic", { title: "再次尝试", firstInput: "再次尝试" }), /暂停创建/);
  assert.equal(creates, 1);
  assert.equal(await f.gateway.handleMessage(incoming("omt_unknown", "orphan")), true);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).pendingTopic.sessionId, "session-a");
});

test("接力：网关重启恢复路由和收讫记录，不恢复旧连接", async (t) => {
  const f = await fixture(t);
  const created = await f.a.request("autobindTopic", { title: "A", firstInput: "首条输入 A" });
  const binding = created.binding;
  await f.gateway.handleMessage(incoming(binding.threadId, "before-restart"));
  await f.gateway.stop();
  const next = new RelayGateway(f.state, f.endpoint, "app_test", f.transport);
  await next.start();
  t.after(() => next.stop());
  const before = f.text.length;
  await next.handleMessage(incoming(binding.threadId, "before-restart"));
  assert.equal(f.text.length, before);
  await next.handleMessage(incoming(binding.threadId, "after-restart"));
  assert.match(f.text.at(-1)!.text, /离线/);
  assert.throws(() => new RelayGateway(f.state, f.endpoint, "another_app", f.transport), /其他机器人/);
});

test("接力：输入镜像开关默认开，可全局关闭并持久化", async (t) => {
  const f = await fixture(t);
  // register/ping/status 都带开关状态，终端不必额外探测就能决定是否镜像本地输入
  assert.equal((await f.a.request("status")).echo, true);
  await assert.rejects(f.a.request("echo", {}), /on 或 off/);
  assert.equal((await f.a.request("echo", { enabled: false })).echo, false);
  assert.equal((await f.a.request("ping")).echo, false);
  assert.equal((await f.a.request("status")).echo, false);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).settings.echo, false);
  // 关闭镜像不影响建话题：话题仍用于接收正式回复
  assert.equal((await f.a.request("autobindTopic", { title: "A", firstInput: "首条输入 A" })).created, true);
  // 开关是全局设置：另一个会话看到同一个值
  const b = f.client("session-b");
  assert.equal((await b.request("status")).echo, false);
});

test("接力：退出通知开关默认开，可全局关闭并持久化", async (t) => {
  const f = await fixture(t);
  // status 带开关状态，终端不必额外探测就知道退出时是否推送关闭提示
  assert.equal((await f.a.request("status")).exitNotice, true);
  await assert.rejects(f.a.request("exitNotice", {}), /on 或 off/);
  assert.equal((await f.a.request("exitNotice", { enabled: false })).exitNotice, false);
  assert.equal((await f.a.request("ping")).exitNotice, false);
  assert.equal((await f.a.request("status")).exitNotice, false);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).settings.exitNotice, false);
  // 开关是全局设置：另一个会话看到同一个值
  const b = f.client("session-b");
  assert.equal((await b.request("status")).exitNotice, false);
});

test("接力：缺少 firstInput 不建话题，也不留下 pendingTopic", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.a.request("autobindTopic", { title: "缺参数" }), /需要非空文本/);
  assert.equal(f.topics.length, 0);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).pendingTopic, undefined);
  // 参数补齐后仍能建话题，说明失败的创建没有阻断后续
  assert.equal((await f.a.request("autobindTopic", { title: "补齐", firstInput: "补齐" })).created, true);
});

test("接力：旧版本状态文件明确拒绝，缺 firstInput 的绑定拒绝启动", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, "state.json");
  const fake = fakeTransport();
  writeFileSync(state, JSON.stringify({ version: 1, appId: "app_test", bindings: [], receipts: {}, optOut: [] }));
  assert.throws(() => new RelayGateway(state, join(dir, "endpoint.json"), "app_test", fake.transport), /旧版本/);
  writeFileSync(state, JSON.stringify({ version: 2, appId: "app_test", bindings: [{ sessionId: "s", chatId: "oc_test", threadId: "omt", rootMessageId: "om", title: "A", enabled: true }], receipts: {}, optOut: [] }));
  assert.throws(() => new RelayGateway(state, join(dir, "endpoint.json"), "app_test", fake.transport), /绑定数据损坏/);
});
