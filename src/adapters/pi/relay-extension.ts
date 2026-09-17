import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RelayClient } from "./relay-client.ts";
import { relayHelp } from "./feishu-help.ts";


export function registerRelayExtension(pi: ExtensionAPI, endpointPath: string) {
  let ctx: ExtensionContext | undefined;
  let client: RelayClient | undefined;
  let sessionId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let turnId: string | undefined;
  let finalText = "";

  function notify(error: unknown) {
    ctx?.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }

  function status() {
    ctx?.ui.setStatus("feishu-relay", client?.connected
      ? client.binding?.enabled ? `飞书接力：${client.binding.title}` : "飞书接力：未绑定"
      : "飞书接力：离线");
  }

  function detach() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    turnId = undefined;
    finalText = "";
    client?.close();
    client = undefined;
    ctx?.ui.setStatus("feishu-relay", undefined);
  }

  function attach(context: ExtensionContext) {
    detach();
    ctx = context;
    sessionId = ctx.sessionManager.getSessionId();
    if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.sessionManager.getSessionFile()) return;
    const id = sessionId;
    const received = new Set<string>();
    client = new RelayClient(endpointPath, id, (method, params) => {
      if (method !== "input") throw new Error("未知的终端接力请求。");
      if (!client?.binding?.enabled || !ctx || ctx.sessionManager.getSessionId() !== id || params?.sessionId !== id) return { accepted: false };
      if (typeof params?.messageId !== "string" || typeof params?.text !== "string" || !params.text.trim()) throw new Error("无效的飞书输入。");
      if (received.has(params.messageId)) return { accepted: true };
      const busy = !ctx.isIdle();
      // 即使此刻空闲也声明 steer，防止异步输入钩子期间另一条消息先启动任务。
      pi.sendUserMessage(params.text, { deliverAs: "steer" });
      received.add(params.messageId);
      ctx.ui.notify(busy ? "飞书消息已收到，将引导当前任务。" : "飞书消息已收到。", "info");
      return { accepted: true, busy };
    }, status);
    const active = client;
    let checking = false;
    const check = async () => {
      if (checking || active !== client) return;
      checking = true;
      try { await active.request("ping"); }
      catch (error) {
        // 未启动网关时不重复弹窗；状态栏显示离线，显式命令返回具体错误。
        if (active.connected) { notify(error); active.close(); }
      } finally { checking = false; if (active === client) status(); }
    };
    void check();
    heartbeat = setInterval(() => void check(), 10_000);
    heartbeat.unref?.();
  }

  pi.on("session_start", (_event, context) => attach(context));
  pi.on("session_shutdown", () => detach());
  pi.on("agent_start", () => { turnId = randomUUID(); finalText = ""; });
  pi.on("message_end", (event) => {
    if (!turnId || event.message.role !== "assistant") return;
    const message = event.message;
    // 含工具调用的中间消息、思考、失败草稿都不是正式回复；只保留最后一条正常答案。
    finalText = message.stopReason === "stop" && !message.content.some((part) => part.type === "toolCall")
      ? formalReplyText(message.content)
      : "";
  });
  pi.on("agent_end", () => {
    const active = client;
    if (turnId && finalText.trim() && active?.binding?.enabled) {
      void active.output({ id: turnId, text: finalText }).catch(notify);
    }
    turnId = undefined;
    finalText = "";
  });

  async function execute(action: string, params: { title?: string; text?: string; chatId?: string; ownerOpenId?: string }, context: ExtensionContext) {
    if (context.mode !== "tui" || !context.hasUI || !context.sessionManager.getSessionFile()) throw new Error("接力只能绑定正在运行且保存历史的 Pi TUI 会话。");
    if (context.sessionManager.getSessionId() !== sessionId || !client) attach(context);
    const active = client!;
    const result = await active.request(action, action === "bind" ? { title: params.title || pi.getSessionName() || "Pi 会话" } : params);
    status();
    return result;
  }

  pi.registerTool({
    name: "feishu_relay",
    label: "飞书会话接力",
    description: "显式绑定当前 Pi TUI 到已配置话题群，查询绑定、解绑或向自己的绑定话题推送文本。仅在用户明确要求时绑定或外发；不能指定任意接收者或修改授权账号。绑定后只同步每轮正式回复。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("bind"), Type.Literal("status"), Type.Literal("unbind"), Type.Literal("push")]),
      title: Type.Optional(Type.String({ description: "话题名称，不填写本地完整路径", maxLength: 80 })),
      text: Type.Optional(Type.String({ description: "主动推送的文本", maxLength: 100000 })),
    }),
    async execute(_id, params, _signal, _onUpdate, context) {
      const result = await execute(params.action, params, context);
      return { content: [{ type: "text", text: formatResult(params.action, result) }], details: result || {} };
    },
  });

  return async (args: string, context: ExtensionContext) => {
    const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const action = match?.[1] || "status";
    const text = match?.[2] || "";
    if (action === "setup") {
      const parts = text.split(/\s+/);
      if (parts.length !== 2) throw new Error(relayHelp());
      await execute("configure", { chatId: parts[0], ownerOpenId: parts[1] }, context);
      context.ui.notify("接力目标及授权账号已配置。", "info");
    } else if (action === "help") {
      context.ui.notify(relayHelp(), "info");
    } else if (["bind", "unbind", "status", "push"].includes(action)) {
      const result = await execute(action, { title: text || undefined, text }, context);
      context.ui.notify(formatResult(action, result), "info");
    } else throw new Error(relayHelp());
  };
}

function formalReplyText(content: Array<{ type: string; text?: string; textSignature?: string }>) {
  const parts = content.filter((part) => part.type === "text").map((part) => {
    let phase: string | undefined;
    // Pi 的 TextSignatureV1 在同一助手消息内区分过程说明和正式答案。
    try {
      const signature = JSON.parse(part.textSignature || "null");
      if (signature?.v === 1 && typeof signature.id === "string") phase = signature.phase;
    } catch {}
    return { text: part.text || "", phase };
  });
  const hasFinal = parts.some((part) => part.phase === "final_answer");
  return parts.filter((part) => hasFinal ? part.phase === "final_answer" : part.phase !== "commentary").map((part) => part.text).join("");
}

function formatResult(action: string, result: any) {
  if (action === "push") return "已推送到当前会话的话题。";
  if (!result) return "当前会话未绑定。";
  return `${result.enabled ? "已绑定" : "已解绑"}：${result.title}\n话题：${result.threadId}`;
}
