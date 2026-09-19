import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RelayClient } from "./relay-client.ts";
import { relayHelp } from "./feishu-help.ts";

/** 自动绑定只在真正新开的会话发生：全新启动、/new、fork；resume 复用原绑定。 */
const AUTOBIND_REASONS = new Set(["startup", "new", "fork"]);

/** 本地终端输入的镜像前缀：话题里必须一眼看出这是本机输入而不是模型回复。 */
const ECHO_PREFIX = "🖥 输入：";

/** 连续推送失败到第几次时，把逐条错误提示合并成一条，避免离线期间淹掉终端。 */
const AGGREGATE_AFTER_FAILURES = 3;

/** 折叠空白：飞书标题必须单行，否则换行会被显示成多行标题。 */
function fold(text: string | undefined) {
  return (text || "").replace(/\s+/g, " ").trim();
}

/** 状态文件里保存的首条输入：折叠空白并截断，只用于会话名清空后重建标题。 */
function storedInput(text: string) {
  return fold(text).slice(0, 200) || "未命名";
}

/**
 * 话题标题：工作目录最后一级 + ":" + 首条用户输入前 30 字。
 * 用户显式命名过会话（/name、-n）时改用会话名，让标题跟随用户自己的叫法；短 ID 由网关追加。
 */
export function relayTitle(sessionName: string | undefined, firstInput: string | undefined, cwd: string) {
  const folder = (cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "Pi").slice(0, 20);
  const name = fold(sessionName);
  const input = fold(firstInput).slice(0, 30);
  return `${folder}:${name || input || "未命名"}`.slice(0, 80);
}

export function registerRelayExtension(pi: ExtensionAPI, endpointPath: string) {
  let ctx: ExtensionContext | undefined;
  let client: RelayClient | undefined;
  let sessionId: string | undefined;
  let pendingAuto = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let turnId: string | undefined;
  let replies = 0;
  let answered = false;
  // 出站统一排队：同步入队、异步串行发送，保证话题内顺序与终端一致且不阻塞用户输入。
  let outbox: Promise<void> = Promise.resolve();
  let outEpoch = 0;
  let sendFailures = 0;

  function notify(error: unknown) {
    ctx?.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }

  function status() {
    ctx?.ui.setStatus("feishu-relay", client?.connected
      ? client.binding?.enabled ? `飞书接力：${client.binding.title}` : "飞书接力：未绑定"
      : "飞书接力：离线");
  }

  /**
   * 出站消息串行发送：先入队的先发出，话题内顺序因此与终端一致。
   * 切换会话或断连（epoch 变化）时丢弃排队项，不重连补发。推送失败不重试；连续失败时只提示第一条和一条汇总，
   * 任意一次发送成功即复位计数，所以网关恢复后不需要额外的重连事件。
   */
  function enqueue(work: (active: RelayClient) => Promise<unknown>) {
    const active = client;
    if (!active) return;
    const epoch = outEpoch;
    outbox = outbox.then(async () => {
      if (epoch !== outEpoch) return;
      try {
        await work(active);
        sendFailures = 0;
      } catch (error) {
        sendFailures++;
        if (sendFailures === 1) notify(error);
        else if (sendFailures === AGGREGATE_AFTER_FAILURES)
          notify(`飞书接力已连续 ${sendFailures} 次推送失败，期间内容只在本机可见；下一次推送成功后恢复逐条提示。`);
      }
    });
  }

  function detach() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    turnId = undefined;
    replies = 0;
    answered = false;
    // 断连后不再补发排队消息：旧话题已不可达，补发只会打乱话题内的顺序。
    outEpoch++;
    sendFailures = 0;
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
      try {
        // ping 顺带刷新输入镜像开关，终端不必额外探测。
        await active.request("ping");
      }
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
    // 只有用户在终端里真正敲进来的输入才算：飞书注入（extension）与 RPC 既不建话题也不回显。
    if (!ctx || event.source !== "interactive") return { action: "continue" };
    const active = client;
    if (pendingAuto) {
      pendingAuto = false;
      try {
        // 阻塞首条消息直到绑定完成，避免第一轮回答赶不上话题建立而漏发。
        const title = relayTitle(ctx.sessionManager.getSessionName(), event.text, ctx.cwd);
        const result = await active?.request("autobindTopic", { title, firstInput: storedInput(event.text) });
        if (result?.created) status();
      } catch {
        // 网关未运行/未配置/创建失败：静默跳过，不打断用户输入；状态栏已是离线。
      }
    }
    const bound = client;
    // 先同步入队再返回：镜像必须排在随后产生的正式回复之前。
    if (bound?.binding?.enabled && bound.echo) {
      // 镜像保留原文（含换行）：终端里敲进去什么，话题里就显示什么。
      // 图片没有文本可镜像，用数量占位，否则飞书侧只能看到一条空输入。
      const images = event.images?.length ? `[图片 ×${event.images.length}]` : "";
      const mirrored = [event.text, images].filter(Boolean).join(" ");
      enqueue((current) => current.request("push", { text: `${ECHO_PREFIX}${mirrored}` }));
    }
    return { action: "continue" };
  });

  pi.on("session_info_changed", (event) => {
    const active = client;
    if (!ctx || !active?.connected || !active.binding?.enabled) return;
    // 名字清空时回退到首条输入，否则标题会一直挂着旧名字。
    const title = relayTitle(event.name, active.binding.firstInput, ctx.cwd);
    void active.request("rename", { title }).catch(notify);
  });

  pi.on("agent_start", () => { turnId = randomUUID(); replies = 0; answered = false; });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (!turnId || message.role !== "assistant" || !client?.binding?.enabled) return;
    // 含工具调用的中间消息、思考、失败草稿都不是正式回复；每条合格答案都单独推送。
    if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return;
    const text = formalReplyText(message.content);
    if (!text.trim()) return;
    answered = true;
    // 同一轮可能有不止一条正式答案，投递 ID 必须逐条区分，否则第二条会被当成重复投递拒绝。
    const id = `${turnId}.${++replies}`;
    enqueue((active) => active.output({ id, text }));
  });
  pi.on("agent_end", () => {
    const active = client;
    // 整轮没有任何正式答案（中止、出错、只跑工具）时说明一声，避免飞书侧以为卡住。
    if (turnId && !answered && active?.binding?.enabled) {
      enqueue((current) => current.request("push", { text: "本轮没有正式回复（已中止或失败）。" }));
    }
    turnId = undefined;
    replies = 0;
    answered = false;
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
      return { content: [{ type: "text", text: formatResult(params.action, result, client?.echo !== false) }], details: result || {} };
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
    } else if (action === "autobind" || action === "echo") {
      const on = text.trim().toLowerCase();
      if (!["on", "off"].includes(on)) throw new Error(relayHelp());
      const result = await execute(action, { enabled: on === "on" }, context);
      context.ui.notify(action === "autobind"
        ? `新会话自动绑定已${result.autobind ? "开启" : "关闭"}。`
        : `输入镜像已${result.echo ? "开启" : "关闭"}。`, "info");
    } else if (["unbind", "status", "push"].includes(action)) {
      const result = await execute(action, { text }, context);
      context.ui.notify(formatResult(action, result, client?.echo !== false), "info");
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

function formatResult(action: string, result: any, echo: boolean) {
  if (action === "autobind") return `新会话自动绑定：${result?.autobind ? "开启" : "关闭"}`;
  if (action === "echo") return `输入镜像：${result?.echo ? "开启" : "关闭"}`;
  if (action === "push") return "已推送到当前会话的话题。";
  // register/ping/status 返回 { binding, echo }，unbind 直接返回绑定本身。
  const binding = action === "status" ? result?.binding : result;
  if (!binding || binding.unbound) return "当前会话未绑定；已记录退出，新会话自动绑定不会再包含它。";
  if (!binding.enabled) return `已解绑并永久退出接力：${binding.title}`;
  const bound = `已绑定：${binding.title}\n话题：${binding.threadId}`;
  return action === "status" ? `${bound}\n输入镜像：${echo ? "开启" : "关闭"}` : bound;
}
