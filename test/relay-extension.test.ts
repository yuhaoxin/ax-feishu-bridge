import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { registerRelayExtension, relayTitle } from "../src/adapters/pi/relay-extension.ts";
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
  const renames: Array<{ root: string; title: string }> = [];
  const status = new Map<string, string>();
  let busy = false;
  let id = "session-one";
  let sessionName: string | undefined;
  let cwd = "/ws/demo-project";
  let topic = 0;
  const transport: RelayTransport = {
    async verifyTopicChat() {},
    async createRelayTopic() { topic++; return { threadId: `omt_${topic}`, rootMessageId: `om_${topic}` }; },
    async replyRelayText(_root, text) { notices.push(text); },
    async replyRelayCard(root, card) { cards.push({ root, card }); return `card_${cards.length}`; },
    async renameRelayTitle(root, title) { renames.push({ root, title }); },
  };
  const gateway = new RelayGateway(join(dir, "state.json"), join(dir, "endpoint.json"), "app", transport);
  await gateway.start();
  const pi: any = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    sendUserMessage(text: string, options: any) { inputs.push({ text, options }); },
    getSessionName() { return sessionName; },
  };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => id, getSessionFile: () => "/not-read/session.jsonl", getSessionName: () => sessionName },
    isIdle: () => !busy,
    ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, text: string) => status.set(key, text) },
  };
  const command = registerRelayExtension(pi, join(dir, "endpoint.json"));
  const emit = (event: string, value = {}) => handlers.get(event)?.(value, ctx);
  const emitAsync = async (event: string, value = {}) => await handlers.get(event)?.(value, ctx);
  await emitAsync("session_start", { reason: "startup" });
  await command("setup oc_test ou_owner", ctx);
  t.after(async () => { await emit("session_shutdown"); await gateway.stop(); rmSync(dir, { recursive: true, force: true }); });
  const incoming = (messageId: string, threadId = "omt_1") => gateway.handleMessage({
    chatId: "oc_test", chatType: "group", threadId, messageId, senderOpenId: "ou_owner", msgType: "text", content: JSON.stringify({ text: "来自飞书" }),
  });
  return {
    emit, emitAsync, ctx, command, inputs, cards, renames, notices, incoming, handlers, tools, status,
    topicCount: () => topic,
    setBusy: (value: boolean) => { busy = value; },
    setSessionName: (value: string | undefined) => { sessionName = value; },
    setCwd: (value: string) => { cwd = value; },
    switchTo: (value: string) => { id = value; },
  };
}

function assistant(text: string, stopReason = "stop", extra: any[] = []) {
  return { message: { role: "assistant", stopReason, content: [{ type: "text", text }, ...extra] } };
}

test("relayTitle：会话名优先，其次首条消息截断，最后工作目录", () => {
  assert.equal(relayTitle("命名会话", "首条消息", "/ws/x"), "命名会话");
  assert.equal(relayTitle(undefined, "帮我修 relay bug\n第二行内容", "/ws/x"), "帮我修 relay bug 第二行内容");
  assert.equal(relayTitle(undefined, "   ", "/ws/demo-project"), "demo-project");
  assert.equal(relayTitle(undefined, "", "/"), "Pi");
});

test("接力扩展：新会话首条消息自动建话题，标题取自首条消息", async (t) => {
  const f = await fixture(t);
  assert.equal(f.topicCount(), 0, "未输入不建话题");
  await f.emitAsync("input", { text: "帮我修 relay bug\n第二行", source: "user" });
  await waitFor(() => (f.status.get("feishu-relay") || "").startsWith("飞书接力："));
  assert.match(f.status.get("feishu-relay")!, /帮我修 relay bug/);
  assert.equal(f.topicCount(), 1);
  // 后续输入不重复建话题
  await f.emitAsync("input", { text: "第二条", source: "user" });
  assert.equal(f.topicCount(), 1);
  // 飞书输入进入 TUI，忙时也走 steer
  await f.incoming("first");
  assert.deepEqual(f.inputs, [{ text: "来自飞书", options: { deliverAs: "steer" } }]);
  f.setBusy(true);
  await f.incoming("second");
  assert.deepEqual(f.inputs[1], { text: "来自飞书", options: { deliverAs: "steer" } });
});

test("接力扩展：会话名中途变化自动同步话题标题；清空名字保持不变", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "初始工作", source: "user" });
  await waitFor(() => (f.status.get("feishu-relay") || "").startsWith("飞书接力："));
  f.setSessionName("重构飞书接力");
  await f.emit("session_info_changed", { name: "重构飞书接力" });
  await waitFor(() => f.renames.length === 1);
  assert.match(f.renames[0].title, /重构飞书接力 \[session-/);
  f.setSessionName(undefined);
  await f.emit("session_info_changed", { name: undefined });
  await delay(30);
  assert.equal(f.renames.length, 1, "名字清空不改话题标题");
});

test("接力扩展：unbind 永久退出名单；其它会话仍自动绑定", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一轮", source: "user" });
  await waitFor(() => (f.status.get("feishu-relay") || "").startsWith("飞书接力："));
  await f.command("unbind", f.ctx);
  await f.incoming("blocked", "omt_1");
  assert.match(f.notices.at(-1)!, /解绑/);
  // 原会话退出名单：即使重新 attach（resume/new）也不再自动绑定
  await f.emitAsync("session_start", { reason: "resume" });
  await f.emitAsync("input", { text: "想回来", source: "user" });
  assert.equal(f.topicCount(), 1);
  // 新会话不受退出名单影响
  f.switchTo("session-two");
  await f.emitAsync("session_start", { reason: "new" });
  await f.emitAsync("input", { text: "第二会话工作", source: "user" });
  await waitFor(() => (f.status.get("feishu-relay") || "").includes("第二会话工作"));
  assert.equal(f.topicCount(), 2);
  await f.emit("agent_start");
  await f.emit("message_end", assistant("第二会话答案"));
  await f.emit("agent_end");
  await waitFor(() => f.cards.some((c) => c.root === "om_2"));
  assert.equal(f.cards.find((c) => c.root === "om_2").card.elements[0].content, "第二会话答案");
});

test("接力扩展：autobind 开关与错误用法；配置入口不向模型暴露", async (t) => {
  const f = await fixture(t);
  const tool = f.tools.find((tool) => tool.name === "feishu_relay");
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /configure|ownerOpenId|chatId|"const":"bind"/);
  await f.command("autobind off", f.ctx);
  assert.ok(f.notices.some((text) => text.includes("关闭")));
  await f.emitAsync("input", { text: "关闭开关后的输入", source: "user" });
  assert.equal(f.topicCount(), 0, "开关关闭时输入不建话题");
  await assert.rejects(f.command("autobind", f.ctx), /relay/);
  await assert.rejects(f.command("push 内容", { ...f.ctx, hasUI: false }), /Pi TUI/);
});
