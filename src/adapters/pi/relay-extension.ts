import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RelayClient } from "./relay-client.ts";
import { relayHelp } from "./feishu-help.ts";

/** 自动绑定只在真正新开的会话发生：全新启动、/new、fork；resume 复用原绑定。 */
const AUTOBIND_REASONS = new Set(["startup", "new", "fork"]);

/** 话题标题：会话名 ‖ 首条用户消息截断 ‖ 工作目录 basename；短 ID 由网关追加。 */
export function relayTitle(sessionName: string | undefined, firstMessage: string | undefined, cwd: string) {
  const fromMessage = (firstMessage || "").replace(/\s+/g, " ").trim().slice(0, 30);
  const fromCwd = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "Pi";
  return (sessionName?.trim() || fromMessage?.trim() || fromCwd).slice(0, 80);
}

export function registerRelayExtension(pi: ExtensionAPI, endpointPath: string) {
  let ctx: ExtensionContext | undefined;
  let client: RelayClient | undefined;
  let sessionId: string | undefined;
  let pendingAuto = false;
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
    pendingAuto = false;
    client?.close();
    client = undefined;
    ctx?.ui.setStatus("feishu-relay", undefined);
  }

  function attach(context: ExtensionContext, autoEligible = false) {
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
      // sendUserMessage 进入真实会话；仅通知或修改历史文件不会驱动终端渲染和执行。
      pi.sendUserMessage(params.text, { deliverAs: "steer" });
      received.add(params.messageId);
      ctx.ui.notify(busy ? "飞书消息已收到，将引导当前任务。" : "飞书消息已收到。", "info");
      return { accepted: true, busy };
    }, status);
    // 网关还没配置时 register 也能成功，binding 为 undefined；自动绑定延迟到首条消息。
    pendingAuto = autoEligible && !client.binding?.enabled;
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

  pi.on("session_start", (event, context) => attach(context, AUTOBIND_REASONS.has(event.reason)));
  pi.on("session_shutdown", () => detach());

  pi.on("input", async (event) => {
    const active = client;
    if (!pendingAuto || !active || !ctx) return { action: "continue" };
    pendingAuto = false;
    try {
      const title = relayTitle(ctx.sessionManager.getSessionName(), event.text, ctx.cwd);
      // 阻塞首条消息直到绑定完成，避免第一轮回答赶不上话题建立而漏发。
      const result = await active.request("autobindTopic", { title });
      if (result?.created) status();
    } catch {
      // 网关未运行/未配置/创建失败：静默跳过，不打断用户输入；状态栏已是离线。
    }
    return { action: "continue" };
  });

  pi.on("session_info_changed", (event) => {
    const active = client;
    if (!event.name?.trim() || !active?.connected || !active.binding?.enabled) return;
    void active.request("rename", { title: event.name.trim() }).catch(() => {});
  });

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

  async function execute(action: string, params: { text?: string; enabled?: boolean; chatId?: string; ownerOpenId?: string }, context: ExtensionContext) {
    if (context.mode !== "tui" || !context.hasUI || !context.sessionManager.getSessionFile()) throw new Error("接力只能在 Pi TUI 会话中使用。");
    if (context.sessionManager.getSessionId() !== sessionId || !client) attach(context);
    const active = client!;
    const result = await active.request(action, params);
    status();
    return result;
  }

  pi.registerTool({
    name: "feishu_relay",
    label: "飞书会话接力",
    description: "查询/管理当前 Pi TUI 会话的飞书接力：状态、解绑（永久退出自动绑定）、向绑定话题推送文本、开关新会话自动绑定。新会话在首条消息时自动建话题；不能指定任意接收者或修改授权账号。绑定会话每轮正式回复自动同步。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("unbind"), Type.Literal("push"), Type.Literal("autobind")]),
      enabled: Type.Optional(Type.Boolean({ description: "action=autobind 时：true 开启新会话自动绑定，false 关闭" })),
      text: Type.Optional(Type.String({ description: "action=push 时推送的文本", maxLength: 100000 })),
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
    } else if (action === "autobind") {
      const on = text.trim().toLowerCase();
      if (!["on", "off"].includes(on)) throw new Error(relayHelp());
      const result = await execute("autobind", { enabled: on === "on" }, context);
      context.ui.notify(`新会话自动绑定已${result.autobind ? "开启" : "关闭"}。`, "info");
    } else if (["unbind", "status", "push"].includes(action)) {
      const result = await execute(action, { text }, context);
      context.ui.notify(formatResult(action, result), "info");
    } else if (action === "help") {
      context.ui.notify(relayHelp(), "info");
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
  if (action === "autobind") return `新会话自动绑定：${result?.autobind ? "开启" : "关闭"}`;
  if (action === "push") return "已推送到当前会话的话题。";
  if (!result || result.unbound) return "当前会话未绑定；已记录退出，新会话自动绑定不会再包含它。";
  if (!result.enabled) return `已解绑并永久退出接力：${result.title}`;
  return `已绑定：${result.title}\n话题：${result.threadId}`;
}
