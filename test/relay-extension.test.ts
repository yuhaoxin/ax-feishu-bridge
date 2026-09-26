import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { registerRelayExtension, relayTitle } from "../src/adapters/pi/relay-extension.ts";
import { ASK_ACTION } from "../src/feishu/ask-card.ts";
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
  const journal: string[] = [];
  // 扩展主动发到话题的内容（输入镜像、正式回复、无答案说明）；不含网关自己的投递状态回执
  const outbound = () => journal.filter((entry) => entry.startsWith("card:") || entry.startsWith("text:🖥 输入：") || entry.startsWith("text:本轮没有正式回复"));
  const cardUpdates: Array<{ messageId: string; card: any }> = [];
  /** 终端侧对话框：测试用 resolve 模拟用户选择，signal 中止即视为取消。 */
  const dialogs: Array<{ kind: "select" | "input"; title: string; options: string[]; aborted: boolean; resolve: (value: string | undefined) => void }> = [];
  const openDialog = (kind: "select" | "input", title: string, options: string[], signal?: AbortSignal) =>
    new Promise<string | undefined>((resolve) => {
      const entry = { kind, title, options, aborted: false, resolve };
      dialogs.push(entry);
      signal?.addEventListener("abort", () => { entry.aborted = true; resolve(undefined); }, { once: true });
    });
  const renames: Array<{ root: string; title: string }> = [];
  const uploads: Array<{ kind: string; path: string; name: string }> = [];
  const media: Array<{ root: string; kind: string; key: string }> = [];
  const status = new Map<string, string>();
  let busy = false;
  let id = "session-one";
  let sessionName: string | undefined;
  let cwd = "/ws/demo-project";
  let topic = 0;
  let sendFailure: string | undefined;
  let attempts = 0;
  const transport: RelayTransport = {
    async verifyTopicChat() {},
    async createRelayTopic() { topic++; return { threadId: `omt_${topic}`, rootMessageId: `om_${topic}` }; },
    async replyRelayText(_root, text) { attempts++; if (sendFailure) throw new Error(sendFailure); notices.push(text); journal.push(`text:${text}`); },
    async replyRelayCard(root, card) { attempts++; if (sendFailure) throw new Error(sendFailure); cards.push({ root, card }); journal.push(`card:${card.elements[0].content}`); return `card_${cards.length}`; },
    async updateRelayCard(messageId, card) { cardUpdates.push({ messageId, card }); },
    async uploadRelayMedia(kind, path, name) { uploads.push({ kind, path, name }); return `${kind}_key`; },
    async replyRelayMedia(root, kind, key) { media.push({ root, kind, key }); return `om_media${media.length}`; },
    async renameRelayTitle(root, title) { renames.push({ root, title }); },
  };
  const gateway = new RelayGateway(join(dir, "state.json"), join(dir, "endpoint.json"), "app", transport);
  await gateway.start();
  const pi: any = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    sendUserMessage(text: string, options: any) { inputs.push({ text, options }); },
    getSessionName() { return sessionName; },
    // omp 会把扩展命令送进 input 事件，插件用命令表区分命令与技能/模板
    getCommands: () => [
      { name: "feishu", source: "extension", description: "飞书" },
      { name: "skill:demo", source: "skill" },
      { name: "template", source: "prompt" },
    ],
  };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => id, getSessionFile: () => "/not-read/session.jsonl", getSessionName: () => sessionName },
    isIdle: () => !busy,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (key: string, text: string) => status.set(key, text),
      select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => openDialog("select", title, options, opts?.signal),
      input: (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => openDialog("input", title, [], opts?.signal),
    },
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
    emit, emitAsync, ctx, command, inputs, cards, cardUpdates, dialogs, gateway, renames, notices, incoming, handlers, tools, status, journal, outbound, uploads, media,
    answerDialog: (value: string) => dialogs.filter((dialog) => !dialog.aborted).pop()?.resolve(value),
    attempts: () => attempts,
    setSendFailure: (value: string | undefined) => { sendFailure = value; },
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

test("relayTitle：目录名打头，显式会话名优先于首条输入", () => {
  assert.equal(relayTitle(undefined, "帮我修 relay bug\n第二行内容", "/ws/demo-project"), "demo-project:帮我修 relay bug 第二行内容");
  assert.equal(relayTitle("命名会话", "首条消息", "/ws/x"), "x:命名会话");
  assert.equal(relayTitle(undefined, "   ", "/ws/demo-project"), "demo-project:未命名");
  assert.equal(relayTitle(undefined, "", "/"), "Pi:未命名");
  // 目录名截 20、首条输入截 30，避免长标题在飞书侧被截得看不出重点
  assert.equal(relayTitle(undefined, "x".repeat(40), `/ws/${"d".repeat(30)}`), `${"d".repeat(20)}:${"x".repeat(30)}`);
});

test("接力扩展：只有终端输入建话题并镜像本地输入，飞书输入不回显", async (t) => {
  const f = await fixture(t);
  assert.equal(f.topicCount(), 0, "未输入不建话题");
  // 其它扩展或 RPC 注入的消息不是用户输入：不建话题也不镜像
  await f.emitAsync("input", { text: "扩展注入的内容", source: "extension" });
  await f.emitAsync("input", { text: "RPC 注入的内容", source: "rpc" });
  assert.equal(f.topicCount(), 0, "非终端输入不建话题");
  assert.deepEqual(f.outbound(), [], "非终端输入不镜像");
  await f.emitAsync("input", { text: "帮我修 relay bug\n第二行", source: "interactive" });
  // 镜像与建话题在同一次输入里完成；先等镜像送达再断言话题标题
  await waitFor(() => f.outbound().length === 1);
  assert.match(f.status.get("feishu-relay")!, /demo-project:帮我修 relay bug 第二行/);
  assert.equal(f.topicCount(), 1);
  assert.deepEqual(f.outbound(), ["text:🖥 输入：帮我修 relay bug\n第二行"], "首条输入也要镜像");
  // 后续输入不重复建话题
  await f.emitAsync("input", { text: "第二条", source: "interactive" });
  await waitFor(() => f.outbound().length === 2);
  assert.equal(f.topicCount(), 1);
  // 飞书输入进入 TUI，忙时也走 steer；来源是飞书，所以不回显
  await f.incoming("first");
  assert.deepEqual(f.inputs, [{ text: "来自飞书", options: { deliverAs: "steer" } }]);
  f.setBusy(true);
  await f.incoming("second");
  assert.deepEqual(f.inputs[1], { text: "来自飞书", options: { deliverAs: "steer" } });
  assert.equal(f.outbound().length, 2, "飞书来源的输入不回显");
  // 镜像先入队、正式回复排在其后：话题内顺序与终端一致
  await f.emit("agent_start");
  await f.emit("message_end", assistant("第一轮答案"));
  await f.emit("agent_end");
  await waitFor(() => f.outbound().length === 3);
  assert.deepEqual(f.outbound().slice(1), ["text:🖥 输入：第二条", "card:第一轮答案"]);
});

test("接力扩展：图片输入用占位符镜像", async (t) => {
  const f = await fixture(t);
  const image = { type: "image", data: "aGk=", mimeType: "image/png" };
  await f.emitAsync("input", { text: "看看这张图", source: "interactive", images: [image, image] });
  await waitFor(() => f.outbound().length === 1);
  assert.deepEqual(f.outbound(), ["text:🖥 输入：看看这张图 [图片 ×2]"], "图片数量要写进镜像");
  // 只贴图不打字时镜像不能是空的，否则话题里会出现一条没有内容的输入
  await f.emitAsync("input", { text: "", source: "interactive", images: [image] });
  await waitFor(() => f.outbound().length === 2);
  assert.deepEqual(f.outbound()[1], "text:🖥 输入：[图片 ×1]");
});

test("接力扩展：会话名变化同步标题，清空后回退到首条输入", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "初始工作", source: "interactive" });
  await waitFor(() => (f.status.get("feishu-relay") || "").startsWith("飞书接力："));
  f.setSessionName("重构飞书接力");
  await f.emit("session_info_changed", { name: "重构飞书接力" });
  await waitFor(() => f.renames.length === 1);
  assert.match(f.renames[0].title, /^demo-project:重构飞书接力 \[session-\]$/);
  f.setSessionName(undefined);
  await f.emit("session_info_changed", { name: undefined });
  await waitFor(() => f.renames.length === 2);
  assert.match(f.renames[1].title, /^demo-project:初始工作 \[session-\]$/, "名字清空回退到首条输入");
});

test("接力扩展：unbind 永久退出名单；其它会话仍自动绑定", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一轮", source: "interactive" });
  await waitFor(() => (f.status.get("feishu-relay") || "").startsWith("飞书接力："));
  await f.command("unbind", f.ctx);
  await f.incoming("blocked", "omt_1");
  assert.match(f.notices.at(-1)!, /解绑/);
  // 原会话退出名单：即使重新 attach（resume/new）也不再自动绑定
  await f.emitAsync("session_start", { reason: "resume" });
  await f.emitAsync("input", { text: "想回来", source: "interactive" });
  assert.equal(f.topicCount(), 1);
  // 新会话不受退出名单影响
  f.switchTo("session-two");
  await f.emitAsync("session_start", { reason: "new" });
  await f.emitAsync("input", { text: "第二会话工作", source: "interactive" });
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
  // 输入镜像开关决定本机输入是否外发，只能由终端命令控制
  assert.doesNotMatch(JSON.stringify(tool.parameters), /echo/);
  await f.command("autobind off", f.ctx);
  assert.ok(f.notices.some((text) => text.includes("关闭")));
  await f.emitAsync("input", { text: "关闭开关后的输入", source: "interactive" });
  assert.equal(f.topicCount(), 0, "开关关闭时输入不建话题");
  assert.deepEqual(f.journal, [], "没有话题就没有镜像去处");
  await assert.rejects(f.command("autobind", f.ctx), /relay/);
  await assert.rejects(f.command("push 内容", { ...f.ctx, hasUI: false }), /Pi TUI/);
});

test("接力扩展：feishu_relay 推送图片与文件，相对路径按会话工作目录解析", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.outbound().length === 1);
  const tool = f.tools.find((item) => item.name === "feishu_relay");
  // 模型只看到这两个新动作和 path 参数；工具不接受收件人等配置
  assert.match(JSON.stringify(tool.parameters), /push_image/);
  assert.match(JSON.stringify(tool.parameters), /push_file/);
  assert.match(JSON.stringify(tool.parameters), /"path"/);
  const dir = mkdtempSync(join(tmpdir(), "relay-media-extension-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "shot.png"), Buffer.alloc(8, 1));
  f.ctx.cwd = dir;
  const image = await tool.execute("call-image", { action: "push_image", path: "shot.png" }, undefined, undefined, f.ctx);
  assert.match(image.content[0].text, /图片已推送到当前会话的话题/);
  assert.deepEqual(f.uploads.at(-1), { kind: "image", path: join(dir, "shot.png"), name: "shot.png" });
  assert.equal(f.media.at(-1).kind, "image");
  await tool.execute("call-file", { action: "push_file", path: join(dir, "shot.png") }, undefined, undefined, f.ctx);
  assert.deepEqual(f.uploads.at(-1), { kind: "file", path: join(dir, "shot.png"), name: "shot.png" });
  // 本地能发现的错误在终端侧就报出，不依赖网关往返
  await assert.rejects(tool.execute("call-missing", { action: "push_image", path: "missing.png" }, undefined, undefined, f.ctx), /文件不存在/);
  await assert.rejects(tool.execute("call-nopath", { action: "push_file" }, undefined, undefined, f.ctx), /需要媒体文件路径/);
  const uploads = f.uploads.length;
  await assert.rejects(tool.execute("call-empty", { action: "push_image", path: "" }, undefined, undefined, f.ctx), /需要媒体文件路径/);
  assert.equal(f.uploads.length, uploads, "校验失败不产生上传");
  // 命令行入口与工具同一套解析，带空格的路径不被截断
  const spaced = join(dir, "my shot.png");
  writeFileSync(spaced, Buffer.alloc(4, 2));
  await f.command("push_image my shot.png", f.ctx);
  assert.deepEqual(f.uploads.at(-1), { kind: "image", path: spaced, name: "my shot.png" });
  assert.ok(f.notices.some((text) => text.includes("图片已推送到当前会话的话题")));
});

test("接力扩展：每条正式答案都推送，整轮没有答案时说明一声", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  await f.emit("agent_start");
  // 含工具调用的中间消息与思考块都不是正式答案
  await f.emit("message_end", assistant("先看看文件", "stop", [{ type: "toolCall", id: "t1", name: "read", arguments: {} }]));
  await f.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "过程说明", textSignature: JSON.stringify({ v: 1, id: "s1", phase: "commentary" }) }] } });
  await f.emit("message_end", assistant("第一段答案"));
  await f.emit("message_end", assistant("第二段答案"));
  await f.emit("agent_end");
  await waitFor(() => f.journal.length === 3);
  assert.deepEqual(f.journal.slice(1), ["card:第一段答案", "card:第二段答案"], "同一轮的每条正式答案都要推送");
  // 下一轮被中止：没有正式答案，推一条状态文本而不是静默
  await f.emit("agent_start");
  await f.emit("message_end", assistant("被中断的草稿", "aborted"));
  await f.emit("agent_end");
  await waitFor(() => f.journal.length === 4);
  assert.match(f.journal[3], /^text:本轮没有正式回复/);
});

test("接力扩展：omp 自动续跑的 agent_end 不清账、也不提示没有回复", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  await f.emit("agent_start");
  await f.emit("message_end", assistant("先看看文件", "stop", [{ type: "toolCall", id: "t1", name: "read", arguments: {} }]));
  // 模型自动重试/续跑：omp 的 agent_end 带 willContinue，表示这不是用户可见的终态
  await f.emit("agent_end", { willContinue: true });
  await f.emit("agent_end", { willContinue: true });
  assert.deepEqual(f.journal.slice(1), [], "续跑期间不得推送「没有正式回复」");
  // 续跑产生的正式答案仍要推送：turnId 没有被续跑的 agent_end 清掉
  await f.emit("message_end", assistant("续跑后的答案"));
  await f.emit("agent_end");
  await waitFor(() => f.journal.length === 2);
  assert.deepEqual(f.journal.slice(1), ["card:续跑后的答案"], "续跑里的正式答案不能漏发");
});

test("接力扩展：关闭输入镜像只停镜像，话题与正式回复照常", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "首条", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  await f.command("echo off", f.ctx);
  assert.ok(f.notices.some((text) => text.includes("输入镜像已关闭")));
  await f.emitAsync("input", { text: "第二条", source: "interactive" });
  await f.emit("agent_start");
  await f.emit("message_end", assistant("答案"));
  await f.emit("agent_end");
  await waitFor(() => f.journal.length === 2);
  assert.equal(f.topicCount(), 1);
  assert.equal(f.journal[1], "card:答案");
  await f.command("status", f.ctx);
  assert.ok(f.notices.some((text) => text.includes("输入镜像：关闭")), "status 要显示输入镜像状态");
  await assert.rejects(f.command("echo", f.ctx), /relay/);
});

test("接力扩展：连续推送失败只提示首条与一条汇总，推送成功后恢复", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一条", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  f.setSendFailure("飞书不可用");
  for (const text of ["一", "二", "三", "四"]) await f.emitAsync("input", { text, source: "interactive" });
  await waitFor(() => f.attempts() === 5);
  assert.equal(f.notices.filter((text) => text === "飞书不可用").length, 1, "首次失败给出原始错误");
  assert.equal(f.notices.filter((text) => text.includes("连续 3 次推送失败")).length, 1, "第 3 次失败合并成一条");
  assert.equal(f.journal.length, 1, "失败期间没有任何内容进入话题");
  f.setSendFailure(undefined);
  await f.emitAsync("input", { text: "五", source: "interactive" });
  await waitFor(() => f.journal.length === 2);
  f.setSendFailure("飞书不可用");
  await f.emitAsync("input", { text: "六", source: "interactive" });
  await waitFor(() => f.attempts() === 7);
  assert.equal(f.notices.filter((text) => text === "飞书不可用").length, 2, "推送成功后失败提示重新逐条给出");
});

test("接力扩展：正常退出推送对话关闭提示（默认开），切换会话不发", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  // pi 的 /new、/resume、/fork、/reload 都会先发 session_shutdown，但话题仍由后继会话使用；
  // 只有 reason=quit 才是真退出。
  for (const reason of ["new", "resume", "fork", "reload"]) {
    await f.emitAsync("session_shutdown", { reason });
  }
  assert.equal(f.journal.length, 1, "切换会话与 reload 都不发关闭提示");
});

test("接力扩展：退出时话题收到关闭提示，exit-notice off 后不再推送", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  await f.emitAsync("session_shutdown", { reason: "quit" });
  assert.match(f.journal[1], /^text:🔚 对话已关闭/, "退出时话题里收到一条关闭提示");
  // 开关关闭后退出保持安静；参数不合法时返回完整说明而不是静默失败
  await f.command("exit-notice off", f.ctx);
  assert.ok(f.notices.some((text) => text.includes("退出通知已关闭")));
  await f.emitAsync("session_shutdown", { reason: "quit" });
  assert.equal(f.journal.length, 2, "关闭开关后退出不再推送");
  await assert.rejects(f.command("exit-notice", f.ctx), /relay/);
});

test("接力扩展：omp 进程内切换会话跟随新会话，旧会话连接被释放", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一会话", source: "interactive" });
  await waitFor(() => (f.status.get("feishu-relay") ?? "").includes("第一会话"));
  assert.equal(f.topicCount(), 1);

  // omp 的 /new 只发 session_switch（没有 session_start），接力要跟着换会话
  f.switchTo("session-two");
  await f.emitAsync("session_switch", { reason: "new", previousSessionFile: "/ws/demo-project/first.jsonl" });
  await waitFor(() => (f.status.get("feishu-relay") ?? "").includes("未绑定"));
  await f.emitAsync("input", { text: "第二会话", source: "interactive" });
  await waitFor(() => f.topicCount() === 2);
  await waitFor(() => (f.status.get("feishu-relay") ?? "").includes("第二会话"));
  assert.equal(f.inputs.length, 0, "新会话尚未收到飞书输入");

  // 旧话题不再有终端接管：网关给出明确回执，而不是静默丢弃
  await f.incoming("after-switch", "omt_1");
  assert.ok(
    f.notices.some((text) => text.includes("已离线")),
    "旧会话的话题应由网关回执终端已离线",
  );
});

test("接力扩展：session_switch resume 复用原话题，不重复建话题", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一会话", source: "interactive" });
  await waitFor(() => f.journal.length === 1);

  f.switchTo("session-two");
  await f.emitAsync("session_switch", { reason: "new" });
  await f.emitAsync("input", { text: "第二会话", source: "interactive" });
  await waitFor(() => f.topicCount() === 2);

  // 切回第一会话：网关按 sessionId 返回既有绑定，状态栏直接回到原话题
  f.switchTo("session-one");
  await f.emitAsync("session_switch", { reason: "resume" });
  await waitFor(() => (f.status.get("feishu-relay") ?? "").includes("demo-project:第一会话"));
  assert.equal(f.topicCount(), 2, "resume 不新建话题");

  await f.emitAsync("input", { text: "回到第一会话", source: "interactive" });
  await f.emit("agent_start");
  await f.emit("message_end", assistant("第一会话答案"));
  await f.emit("agent_end");
  await waitFor(() => f.cards.some((card) => card.card.elements[0].content === "第一会话答案"));
  assert.equal(
    f.cards.find((card) => card.card.elements[0].content === "第一会话答案")?.root,
    "om_1",
    "正式回复回到原话题",
  );
});

test("接力扩展：同一会话重复触发沿用原连接（ctx.reload 语义）", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "第一条", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  const bound = f.status.get("feishu-relay");

  // omp 的 ctx.reload() 就是 session_switch reason=resume，且会话 id 不变：
  // 重注册既无必要，又可能被网关以「同一会话已在另一个终端连接」拒绝
  await f.emitAsync("session_switch", { reason: "resume" });
  await f.emitAsync("session_switch", { reason: "resume" });
  assert.equal(f.status.get("feishu-relay"), bound, "同一会话沿用原连接");
  assert.equal(
    f.notices.filter((text) => text.includes("已在另一个终端连接")).length,
    0,
    "重复触发不重注册，也不会拿到重复注册错误",
  );

  await f.incoming("after-reload");
  assert.deepEqual(f.inputs, [{ text: "来自飞书", options: { deliverAs: "steer" } }], "沿用连接后飞书输入仍然可用");
  assert.equal(f.topicCount(), 1);
});

test("接力扩展：omp 的无 reason 关闭事件按退出处理", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "开始", source: "interactive" });
  await waitFor(() => f.journal.length === 1);
  // omp 的 session_shutdown 没有 reason 字段，且只在进程退出时发出
  await f.emitAsync("session_shutdown", {});
  assert.match(f.journal[1], /^text:🔚 对话已关闭/, "无 reason（omp）同样推关闭提示");
});

test("接力扩展：omp 送进来的斜杠命令不建话题也不镜像", async (t) => {
  const f = await fixture(t);
  // omp 把宿主命令也当成 interactive 输入送进 input 事件（pi 在输入事件之前拦截）：
  // 扩展命令与内建命令都不能当话题标题，也不能出现在话题里
  for (const text of ["/feishu relay setup oc_smoke ou_owner", "/new", "/model gpt-5"]) {
    await f.emitAsync("input", { text, source: "interactive" });
  }
  assert.equal(f.topicCount(), 0, "命令不建话题");
  assert.deepEqual(f.outbound(), [], "命令不镜像");
  // 真正的第一条输入照常建话题，标题取自它而不是命令
  await f.emitAsync("input", { text: "真正的第一条", source: "interactive" });
  await waitFor(() => f.topicCount() === 1);
  assert.match(f.status.get("feishu-relay") ?? "", /demo-project:真正的第一条/);
});

test("接力扩展：以路径开头的正常输入不会被当成命令", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "/Users/me/notes.md 看看这个", source: "interactive" });
  await waitFor(() => f.outbound().length === 1);
  assert.deepEqual(f.outbound(), ["text:🖥 输入：/Users/me/notes.md 看看这个"]);
});

test("接力扩展：技能与模板仍按输入原文处理", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "/skill:demo 用法", source: "interactive" });
  await waitFor(() => f.topicCount() === 1);
  await waitFor(() => f.outbound().length === 1);
  assert.deepEqual(f.outbound(), ["text:🖥 输入：/skill:demo 用法"], "技能输入镜像原文");
});

/** 从 ask 卡片的按钮里取回复用 runId：它由扩展每次提问随机生成。 */
function cardRunId(card: any): string {
  for (const element of card.elements) {
    for (const action of element.actions || []) {
      if (action?.value?.action === ASK_ACTION) return action.value.runId;
    }
  }
  assert.fail("卡片里没有 ask 按钮");
}

test("接力 ask：终端作答胜出并作废飞书卡片", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "首条输入", source: "interactive" });
  await waitFor(() => f.topicCount() === 1);
  const ask = f.tools.find((tool) => tool.name === "ask");
  assert.ok(ask, "扩展要注册 ask 工具遮蔽内置实现");
  const run = ask.execute("call-1", { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, f.ctx);
  await waitFor(() => f.cards.length === 1 && f.dialogs.length === 1);
  f.answerDialog("B");
  const result = await run;
  assert.match(result.content[0].text, /B/, "终端选择要回到工具结果里");
  assert.equal(result.details.selectedOptions[0], "B");
  await waitFor(() => f.cardUpdates.length === 1);
  assert.match(JSON.stringify(f.cardUpdates[0].card), /已在终端回答/, "终端先答后飞书卡片要作废");
});

test("接力 ask：飞书作答胜出并收起终端对话框", async (t) => {
  const f = await fixture(t);
  await f.emitAsync("input", { text: "首条输入", source: "interactive" });
  await waitFor(() => f.topicCount() === 1);
  const ask = f.tools.find((tool) => tool.name === "ask");
  const run = ask.execute("call-2", { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, f.ctx);
  await waitFor(() => f.cards.length === 1 && f.dialogs.length === 1);
  await f.gateway.handleAskAction({
    messageId: "card_1", chatId: "oc_test", operatorOpenId: "ou_owner",
    value: { action: ASK_ACTION, runId: cardRunId(f.cards[0].card), questionId: "q1", kind: "option", label: "A" },
  });
  const result = await run;
  assert.match(result.content[0].text, /A/, "飞书选择要回到工具结果里");
  await waitFor(() => f.dialogs[0].aborted);
});

test("接力 ask：未绑定时只走终端对话框，不发飞书卡片", async (t) => {
  const f = await fixture(t);
  const ask = f.tools.find((tool) => tool.name === "ask");
  const run = ask.execute("call-3", { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, f.ctx);
  await waitFor(() => f.dialogs.length === 1);
  f.answerDialog("A");
  const result = await run;
  assert.match(result.content[0].text, /A/);
  assert.equal(f.cards.length, 0, "未绑定不能发飞书卡片");
});
