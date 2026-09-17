import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { registerRelayExtension } from "../src/adapters/pi/relay-extension.ts";

// 真实 Pi SDK、真实模型 HTTP 请求、真实环回通信；模型与飞书服务使用本地替身，不接触凭证。
test("接力端到端：飞书输入写入真实 Pi 会话并触发回答，订阅者实时收到事件", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-sdk-"));
  const cards: any[] = [];
  const events: any[] = [];
  const errors: any[] = [];
  let modelRequests = 0;
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const modelServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    modelRequests++;
    assert.ok(payload.messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("来自飞书的真实输入")));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: any, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: "正式" }));
    await modelGate;
    res.write(chunk({ content: "答案" }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const port = (modelServer.address() as any).port;
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "relay-test": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test-only", models: [{ id: "test-model", reasoning: false, contextWindow: 32000, maxTokens: 1024 }] } } }));
  const endpoint = join(dir, "endpoint.json");
  const gateway = new RelayGateway(join(dir, "relay.json"), endpoint, "app", {
    async verifyTopicChat() {},
    async createRelayTopic() { return { threadId: "omt_test", rootMessageId: "om_root" }; },
    async replyRelayText() {},
    async replyRelayCard(_root, card) { cards.push(card); return "om_reply"; },
  });
  await gateway.start();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false });
  let command: any;
  let context: any;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi: any) => {
      command = registerRelayExtension(pi, endpoint);
      pi.on("session_start", (_event: any, ctx: any) => { context = ctx; });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("relay-test", "test-model"), resourceLoader: loader, sessionManager: SessionManager.create(dir), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), noTools: "all" });
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setStatus() {} } as any, onError: (error) => errors.push(error) });
  t.after(async () => {
    releaseModel();
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await gateway.stop();
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await command("setup oc_test ou_owner", context);
  await command("bind SDK 验收", context);
  await gateway.handleMessage({ chatId: "oc_test", chatType: "group", threadId: "omt_test", messageId: "om_in", senderOpenId: "ou_owner", msgType: "text", content: JSON.stringify({ text: "来自飞书的真实输入" }) });
  for (let i = 0; i < 200 && !events.some((e) => e.type === "message_update"); i++) await delay(10);
  assert.ok(events.some((e) => e.type === "message_end" && e.message.role === "user"));
  assert.ok(events.some((e) => e.type === "message_update"), JSON.stringify(errors));
  assert.equal(cards.length, 0, "流式增量不得向飞书外发");
  releaseModel();
  for (let i = 0; i < 200 && !cards.length; i++) await delay(10);
  assert.equal(modelRequests, 1);
  assert.equal(cards.length, 1, JSON.stringify(errors));
  assert.equal(cards[0].elements[0].content, "正式答案");
  assert.ok(session.messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("来自飞书的真实输入")));
  assert.deepEqual(errors, []);
});
