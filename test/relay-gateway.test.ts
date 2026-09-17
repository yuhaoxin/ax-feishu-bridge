import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  const text: Array<{ root: string; text: string }> = [];
  const cards: Array<{ root: string; card: any }> = [];
  const transport: RelayTransport = {
    async verifyTopicChat(chat, owner) { assert.equal(chat, "oc_test"); assert.equal(owner, "ou_owner"); },
    async createRelayTopic(_chat, title) {
      topics.push(title);
      return { threadId: `omt_${topics.length}`, rootMessageId: `om_${topics.length}` };
    },
    async replyRelayText(root, value) { text.push({ root, text: value }); },
    async replyRelayCard(root, card) { cards.push({ root, card }); return `om_card${cards.length}`; },
  };
  return { topics, text, cards, transport };
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

test("接力：两个真实 TCP 客户端独立绑定，授权、去重及忙时回执", async (t) => {
  const f = await fixture(t);
  const a = await f.a.request("bind", { title: "会话 A" });
  const inputs: any[] = [];
  const b = f.client("session-b", async (method, params) => { inputs.push({ method, params }); return { accepted: true, busy: true }; });
  const binding = await b.request("bind", { title: "会话 B" });
  assert.notEqual(a.threadId, binding.threadId);
  assert.equal((await b.request("bind", { title: "会话 B" })).threadId, binding.threadId);
  await assert.rejects(b.request("bind", { title: "不会新建" }), /已绑定/);
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

test("接力：解绑后换名创建新话题，旧话题继续拦截，状态指向新绑定", async (t) => {
  const f = await fixture(t);
  const first = await f.a.request("bind", { title: "旧名" });
  await f.a.request("unbind");
  const second = await f.a.request("bind", { title: "新名" });
  assert.notEqual(second.threadId, first.threadId);
  assert.equal((await f.a.request("status")).title, second.title);
  assert.equal(f.topics.length, 2);
  await f.gateway.handleMessage(incoming(first.threadId, "old-topic"));
  assert.match(f.text.at(-1)!.text, /解绑/);
  const before = f.text.length;
  await f.gateway.handleMessage(incoming(second.threadId, "new-topic"));
  assert.equal(f.text.length, before, "新话题正常送达时不产生拒绝提示");
  // 同名重绑仍复用，不产生第三条话题
  await f.a.request("unbind");
  const reused = await f.a.request("bind", { title: "新名" });
  assert.equal(reused.threadId, second.threadId);
  assert.equal(f.topics.length, 2);
});

test("接力：离线、解绑拒绝，不回落后台，不在重连后重放", async (t) => {
  const f = await fixture(t);
  const binding = await f.a.request("bind", { title: "A" });
  await f.a.request("unbind");
  await f.gateway.handleMessage(incoming(binding.threadId, "unbound"));
  assert.match(f.text.at(-1)!.text, /解绑/);
  await f.a.request("bind", { title: "A" });
  f.a.close();
  // status 请求提供一个事件循环屏障，确保服务端已处理断开。
  const observer = f.client("observer");
  await observer.request("status");
  await f.gateway.handleMessage(incoming(binding.threadId, "offline"));
  assert.match(f.text.at(-1)!.text, /离线/);
  const received: any[] = [];
  const reopened = f.client("session-a", async (_method, params) => { received.push(params); return { accepted: true }; });
  assert.equal((await reopened.request("status")).threadId, binding.threadId);
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
  const binding = await b.request("bind", { title: "B" });
  await f.gateway.handleMessage(incoming(binding.threadId, "uncertain"));
  assert.match(f.text.at(-1)!.text, /未确认/);
  await f.gateway.handleMessage(incoming(binding.threadId, "uncertain"));
  assert.equal(calls, 1);
});

test("接力：正式答案只发一次，长内容分块且保持同一话题", async (t) => {
  const f = await fixture(t);
  const binding = await f.a.request("bind", { title: "A" });
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
test("接力：话题创建超时后持久阻断重试及普通后台回落", async (t) => {
  const f = await fixture(t);
  let creates = 0;
  f.transport.createRelayTopic = async () => { creates++; throw new Error("远端创建结果未确认"); };
  await assert.rejects(f.a.request("bind", { title: "不确定话题" }), /未确认/);
  await assert.rejects(f.a.request("bind", { title: "再次尝试" }), /暂停创建/);
  assert.equal(creates, 1);
  assert.equal(await f.gateway.handleMessage(incoming("omt_unknown", "orphan")), true);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).pendingTopic.sessionId, "session-a");
});


test("接力：网关重启恢复路由和收讫记录，不恢复旧连接", async (t) => {
  const f = await fixture(t);
  const binding = await f.a.request("bind", { title: "A" });
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
