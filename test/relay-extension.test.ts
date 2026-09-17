import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { registerRelayExtension } from "../src/adapters/pi/relay-extension.ts";
import type { RelayTransport } from "../src/adapters/pi/relay-output.ts";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("接力事件未在测试期限内到达");
}

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-extension-"));
  const handlers = new Map<string, Function>();
  const tools: any[] = [];
  const inputs: any[] = [];
  const notices: string[] = [];
  const cards: any[] = [];
  const status = new Map<string, string>();
  let busy = false;
  let id = "session-one";
  let topic = 0;
  const transport: RelayTransport = {
    async verifyTopicChat() {},
    async createRelayTopic() { topic++; return { threadId: `omt_${topic}`, rootMessageId: `om_${topic}` }; },
    async replyRelayText(_root, text) { notices.push(text); },
    async replyRelayCard(root, card) { cards.push({ root, card }); return `card_${cards.length}`; },
  };
  const gateway = new RelayGateway(join(dir, "state.json"), join(dir, "endpoint.json"), "app", transport);
  await gateway.start();
  const pi: any = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    sendUserMessage(text: string, options: any) { inputs.push({ text, options }); },
    getSessionName() { return "开发会话"; },
  };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => "/not-read/session.jsonl" },
    isIdle: () => !busy,
    ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, text: string) => status.set(key, text) },
  };
  const command = registerRelayExtension(pi, join(dir, "endpoint.json"));
  const emit = (event: string, value = {}) => handlers.get(event)?.(value, ctx);
  await emit("session_start");
  await command("setup oc_test ou_owner", ctx);
  await command("bind", ctx);
  t.after(async () => { await emit("session_shutdown"); await gateway.stop(); rmSync(dir, { recursive: true, force: true }); });
  const incoming = (messageId: string, threadId = "omt_1") => gateway.handleMessage({
    chatId: "oc_test", chatType: "group", threadId, messageId, senderOpenId: "ou_owner", msgType: "text", content: JSON.stringify({ text: "来自飞书" }),
  });
  return { emit, ctx, command, inputs, cards, notices, incoming, handlers, tools, setBusy: (value: boolean) => { busy = value; }, switchTo: (value: string) => { id = value; } };
}

function assistant(text: string, stopReason = "stop", extra: any[] = []) {
  return { message: { role: "assistant", stopReason, content: [{ type: "text", text }, ...extra] } };
}

test("接力扩展：输入进入 sendUserMessage，忙时使用 steer，不执行第二个后台模型", async (t) => {
  const f = await fixture(t);
  await f.incoming("first");
  assert.deepEqual(f.inputs, [{ text: "来自飞书", options: { deliverAs: "steer" } }]);
  f.setBusy(true);
  await f.incoming("second");
  assert.deepEqual(f.inputs[1], { text: "来自飞书", options: { deliverAs: "steer" } });
  assert.ok(f.notices.some((text) => text.includes("引导当前任务")));
});

test("接力扩展：只发送 agent_end 前最后一条正式回复，过程和工具输出不外发", async (t) => {
  const f = await fixture(t);
  assert.equal(f.handlers.has("message_update"), false);
  await f.emit("agent_start");
  await f.emit("message_end", assistant("我正在分析", "toolUse", [{ type: "toolCall", id: "1", name: "bash", arguments: {} }]));
  await f.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] } });
  await f.emit("message_end", assistant("中间回复"));
  assert.equal(f.cards.length, 0);
  await f.emit("message_end", assistant("最终正式回复", "stop", [{ type: "thinking", thinking: "private reasoning" }]));
  assert.equal(f.cards.length, 0);
  await f.emit("agent_end");
  await waitFor(() => f.cards.length === 1);
  assert.equal(f.cards[0].card.elements[0].content, "最终正式回复");
  assert.doesNotMatch(JSON.stringify(f.cards), /secret|private|正在分析|中间回复/);
  await f.emit("agent_end");
  await delay(20);
  assert.equal(f.cards.length, 1);
});
test("接力扩展：同一助手消息混合 commentary 与 final_answer 时只发正式答案", async (t) => {
  const f = await fixture(t);
  await f.emit("agent_start");
  await f.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [
    { type: "text", text: "过程说明", textSignature: JSON.stringify({ v: 1, id: "msg-1", phase: "commentary" }) },
    { type: "text", text: "未分类片段" },
    { type: "text", text: "正式答案", textSignature: JSON.stringify({ v: 1, id: "msg-2", phase: "final_answer" }) },
  ] } });
  await f.emit("agent_end");
  await waitFor(() => f.cards.length === 1);
  assert.equal(f.cards[0].card.elements[0].content, "正式答案");
  await f.emit("agent_start");
  await f.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [
    { type: "text", text: "只有过程，没有答案", textSignature: JSON.stringify({ v: 1, id: "msg-3", phase: "commentary" }) },
  ] } });
  await f.emit("agent_end");
  await delay(20);
  assert.equal(f.cards.length, 1);
});


test("接力扩展：失败、取消和工具调用草稿不能被当作正式回复", async (t) => {
  const f = await fixture(t);
  for (const reason of ["aborted", "error", "toolUse", "length"]) {
    await f.emit("agent_start");
    await f.emit("message_end", assistant("不该发送的草稿", reason));
    await f.emit("agent_end");
  }
  await delay(20);
  assert.equal(f.cards.length, 0);
});

test("接力扩展：切换会话立刻拒绝旧话题，重新绑定新会话不串话", async (t) => {
  const f = await fixture(t);
  f.switchTo("session-two");
  await f.incoming("race-with-switch");
  assert.equal(f.inputs.length, 0);
  assert.ok(f.notices.some((text) => text.includes("已切换会话")));
  await f.emit("session_shutdown");
  await f.emit("session_start");
  await f.command("bind 第二会话", f.ctx);
  await f.incoming("old-topic");
  assert.equal(f.inputs.length, 0);
  await f.incoming("new-topic", "omt_2");
  assert.equal(f.inputs.length, 1);
  await f.emit("agent_start");
  await f.emit("message_end", assistant("第二会话的答案"));
  await f.emit("agent_end");
  await waitFor(() => f.cards.length === 1);
  assert.equal(f.cards[0].root, "om_2");
});

test("接力扩展：显式工具仅操作本会话；配置入口不向模型暴露", async (t) => {
  const f = await fixture(t);
  const tool = f.tools.find((tool) => tool.name === "feishu_relay");
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /configure|ownerOpenId|chatId/);
  await f.command("unbind", f.ctx);
  await f.emit("agent_start");
  await f.emit("message_end", assistant("解绑之后不自动外发"));
  await f.emit("agent_end");
  assert.equal(f.cards.length, 0);
  await assert.rejects(f.command("push 内容", { ...f.ctx, hasUI: false }), /Pi TUI/);
});
