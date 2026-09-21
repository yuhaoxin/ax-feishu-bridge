import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  parseAskQuestions,
  formatAskDetails,
  formatAskText,
  type AskAnswer,
  type AskQuestion,
  type AskResult,
} from "../../feishu/ask-card.ts";
import { RelayClient } from "./relay-client.ts";
import { relayHelp } from "./feishu-help.ts";

/**
 * omp 用独立的 session_switch 事件表达会话切换（pi 没有该事件，用 session_start 的
 * reason 表达）。这里只声明用到的那一个重载：本包的编译依赖是 pi 的 ExtensionAPI，
 * 为一个 omp 事件放宽整个宿主类型得不偿失。两个宿主的 on() 都不校验事件名
 * （pi 存进 Map，omp 的签名是 event: string），所以该订阅在 pi 上只是永不触发。
 */
type SessionSwitchHost = {
  on(event: "session_switch", handler: (event: { reason?: string }, context: ExtensionContext) => void): unknown;
};

/**
 * 网关拒绝同一会话重复注册时的错误片段。旧连接关闭到网关摘除 sessions 之间只隔一个
 * 异步 socket close 事件，detach 后立刻重连同一会话可能撞上这段窗口。
 */
const DUPLICATE_SESSION_ERROR = "同一会话已在另一个终端连接";

/** 本地终端输入的镜像前缀：话题里必须一眼看出这是本机输入而不是模型回复。 */
const ECHO_PREFIX = "🖥 输入：";

/** 退出 TUI 时推送的对话关闭提示：会话结束但话题保留，重新打开该会话即可继续接力。 */
const EXIT_NOTICE = "🔚 对话已关闭：Pi TUI 已退出，重新打开该会话后可继续接力。";

/** 退出提示的等待上限：pi 会等 session_shutdown 处理完才退出，网关或网络异常时不能让退出卡住。 */
const EXIT_NOTICE_TIMEOUT_MS = 1500;

/** /feishu relay 的开关命令：命令名映射网关方法名、返回值字段与提示文案。 */
const RELAY_TOGGLES: Record<string, { method: string; label: string; field: string }> = {
  autobind: { method: "autobind", label: "新会话自动绑定", field: "autobind" },
  echo: { method: "echo", label: "输入镜像", field: "echo" },
  "exit-notice": { method: "exitNotice", label: "退出通知", field: "exitNotice" },
};

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

/**
 * 输入是不是斜杠命令。omp 把宿主命令（/new、/feishu …）也当作 interactive 输入
 * 送进 input 事件，pi 则在输入事件之前拦截：命令不建话题也不镜像，否则话题里会
 * 出现「🖥 输入：/new」这类命令行文本，标题也可能取自命令行。
 *
 * 判断口径：首 token 形如 `/名字`（名字里不再出现 `/`，所以 "/Users/me/x.md 看看"
 * 这类以路径开头的正常输入不会误判）；再查命令表——技能与模板（source 为
 * skill/prompt）按文档要继续镜像为输入原文，其余（扩展命令与宿主内建命令）都算命令。
 */
function isCommandInput(pi: ExtensionAPI, text: string) {
  const name = /^\s*\/([A-Za-z][\w:-]*)(?:\s|$)/.exec(text)?.[1];
  if (!name || typeof pi.getCommands !== "function") return false;
  try {
    const known = pi.getCommands().find((command) => command.name === name);
    return known ? known.source === "extension" : true;
  } catch {
    // 宿主未提供命令表时按普通输入处理，不拦。
    return false;
  }
}

/** 订阅 omp 的会话切换事件；pi 没有这个事件，注册后不会触发。 */
function onSessionSwitch(pi: ExtensionAPI, handler: (context: ExtensionContext) => void) {
  // pi 的类型里没有 session_switch，取用 omp 侧的形状；运行时两个宿主都只是登记回调。
  (pi as unknown as SessionSwitchHost).on("session_switch", (_event, context) => handler(context));
}

/** ping 失败于重复注册时重试一次，其余错误原样抛出（未启动网关等按原路径提示）。 */
async function connectRelay(active: RelayClient) {
  try {
    await active.request("ping");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(DUPLICATE_SESSION_ERROR)) throw error;
    await delay(300);
    await active.request("ping");
  }
}

export function registerRelayExtension(pi: ExtensionAPI, endpointPath: string) {
  let ctx: ExtensionContext | undefined;
  let client: RelayClient | undefined;
  let sessionId: string | undefined;
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

  /**
   * 退出通知单独入队：排在已排队内容之后才能保持话题内顺序，且不能像普通出站那样在 detach 时被丢弃。
   * 异常必须在此吞掉：outbox 一旦 reject，后续 enqueue 的发送会被整体跳过。
   */
  function enqueueFinal(work: (active: RelayClient) => Promise<unknown>) {
    const active = client;
    if (!active) return Promise.resolve();
    outbox = outbox.then(async () => {
      try { await work(active); } catch {}
    });
    return outbox;
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
    client?.close();
    client = undefined;
    ctx?.ui.setStatus("feishu-relay", undefined);
  }

  /**
   * 连接当前会话的接力：进程启动、重开旧会话、进程内切会话、显式 /feishu relay 都走这里。
   * 同一会话重复触发（扩展触发的 ctx.reload()、重复命令）沿用现有连接：重注册既无必要，
   * 又会在旧连接尚未被网关摘除时被拒。
   */
  function attach(context: ExtensionContext) {
    const target = context.sessionManager.getSessionId();
    if (sessionId === target && client?.connected) {
      ctx = context;
      status();
      return;
    }
    detach();
    ctx = context;
    sessionId = target;
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
    const active = client;
    let checking = false;
    const check = async () => {
      if (checking || active !== client) return;
      checking = true;
      try {
        // ping 顺带刷新输入镜像开关，终端不必额外探测。
        await connectRelay(active);
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

  // 会话边界统一走 attach()：进程启动与重开旧会话走 session_start（两个宿主都有），
  // omp 进程内切会话走 session_switch（/new、/resume、/fork 都只发这一个事件）。
  pi.on("session_start", (_event, context) => attach(context));
  onSessionSwitch(pi, attach);
  pi.on("session_shutdown", async (event) => {
    const active = client;
    // omp 的 session_shutdown 没有 reason 且只在退出时发出；pi 的带 reason，
    // 切会话（new/resume/fork）与 /reload 复用同一事件，只有 quit 才是真退出。
    const reason = (event as { reason?: string } | undefined)?.reason;
    if ((reason === undefined || reason === "quit") && active?.binding?.enabled && active.exitNotice) {
      await Promise.race([
        enqueueFinal((current) => current.request("push", { text: EXIT_NOTICE }, EXIT_NOTICE_TIMEOUT_MS)),
        delay(EXIT_NOTICE_TIMEOUT_MS, undefined, { ref: false }),
      ]);
    }
    detach();
  });

  pi.on("input", async (event) => {
    // 只有用户在终端里真正敲进来的输入才算：飞书注入（extension）与 RPC 既不建话题也不回显。
    if (!ctx || event.source !== "interactive") return { action: "continue" };
    // 斜杠命令不是用户输入：既不建话题也不镜像。
    if (isCommandInput(pi, event.text)) return { action: "continue" };
    const active = client;
    // 建话题只看当前有没有启用中的绑定，不看这是第几条输入：omp 会把扩展命令
    // （如 /feishu relay setup）也送进 input 事件，一次性标志会让这类会话永远建不出话题。
    if (active && active.binding?.enabled !== true) {
      try {
        // 阻塞首条消息直到绑定完成，避免第一轮回答赶不上话题建立而漏发。
        const title = relayTitle(ctx.sessionManager.getSessionName(), event.text, ctx.cwd);
        const result = await active.request("autobindTopic", { title, firstInput: storedInput(event.text) });
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
  // omp 没有 session_info_changed 事件：omp 上标题只在建话题时定型，改名不同步
  // （见 docs/pi-session-relay.md 的 omp 差异一节）。

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
  pi.on("agent_end", (event) => {
    // omp 在自动续跑（自动重试、空回复重试等）时也会发 agent_end，并用 willContinue 说明这不是
    // 用户可见的终态。这里若照常清账，续跑里的正式答案会因为 turnId 已清空而漏发，话题里还会多出
    // 一条「没有正式回复」的噪声提示。
    if ((event as { willContinue?: boolean } | undefined)?.willContinue) return;
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

  /**
   * 遮蔽内置 ask：接力绑定后问题同时发到飞书话题与终端对话框，任一侧先作答即返回；
   * 未绑定时委托原生同名工具，TUI 用户的使用体验完全不变。
   * 只接管本接力会话，子 agent 等其它会话仍走原生行为。
   */
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Prompts the user for one or more option-picker or free-form answers. 接力绑定后问题会同时出现在飞书话题与终端，任一侧先作答即返回；未绑定时使用终端原生对话框。",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable identifier used in multi-question results." }),
          question: Type.String({ description: "Prompt text shown to the user." }),
          options: Type.Array(
            Type.Union([
              Type.String(),
              Type.Object({
                label: Type.String(),
                description: Type.Optional(Type.String()),
                preview: Type.Optional(Type.String()),
              }),
            ]),
            { description: "Picker choices; 2–5 options are typical." },
          ),
          header: Type.Optional(Type.String()),
          multi: Type.Optional(Type.Boolean()),
          recommended: Type.Optional(Type.Number()),
        }),
        { minItems: 1 },
      ),
    }),
    // 原生 ask 是独占工具（同批只跑它一个），宿主只提供 sequential/parallel，取更接近的一项。
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, context) {
      if (!context.hasUI) {
        // 与原生一致：没有交互界面时中止本轮，而不是挂在没人能回答的问题上。
        context.abort();
        throw new Error("Ask tool requires interactive mode");
      }
      const questions = parseAskQuestions(params.questions);
      // 工具自身的 abort 信号可能缺省（宿主不传），统一收敛到内部 controller 上，对话框才有稳定的取消入口。
      const controller = new AbortController();
      const onToolAbort = () => controller.abort();
      signal?.addEventListener("abort", onToolAbort, { once: true });
      try {
        const active = client;
        // 网关 35 秒无流量会关掉连接，心跳每 10 秒补一次：恰好落在重连窗口里的提问会被
        // 瞬时断链静默降级成只用终端对话框。这里先补一次连接再判定绑定。
        if (active && !active.connected) {
          try { await active.connect(); } catch {}
        }
        const bound =
          active?.connected === true &&
          active.binding?.enabled === true &&
          context.sessionManager.getSessionId() === sessionId;
        if (!bound) {
          const native = nativeAskInvoker(context);
          if (native) return await native(params, { signal, onUpdate });
          const fallback = await runTuiChannel(context, questions, controller.signal);
          if (!fallback) askCancelled(context);
          return askToolResult(fallback.results);
        }
        const runId = randomUUID();
        // 提问没有等待上限：只有连接真正断开（网关/终端退出）才结束，请求超时只作为传输层兜底。
        const feishu = active.request("ask", { runId, questions }, ASK_REQUEST_TIMEOUT_MS)
          .then((response) => {
            const results = readAskAnswers(response, questions);
            return results ? { source: "feishu" as const, results } : undefined;
          })
          // 飞书通道失败不能静默：否则用户只看到终端对话框，不知道话题里为什么没有卡片。
          .catch((error) => {
            ctx?.ui.notify(askChannelNotice(error), "warning");
            return undefined;
          });
        const tui = runTuiChannel(context, questions, controller.signal);
        const winner = await raceFirst([feishu, tui]);
        if (winner?.source === "feishu") controller.abort();
        else if (winner) void active.request("askCancel", { runId }, 8_000).catch(() => {});
        if (!winner) {
          void active.request("askCancel", { runId }, 8_000).catch(() => {});
          askCancelled(context);
        }
        return askToolResult(winner.results);
      } finally {
        signal?.removeEventListener("abort", onToolAbort);
      }
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
    } else if (RELAY_TOGGLES[action]) {
      const on = text.trim().toLowerCase();
      if (!["on", "off"].includes(on)) throw new Error(relayHelp());
      const toggle = RELAY_TOGGLES[action];
      const result = await execute(toggle.method, { enabled: on === "on" }, context);
      context.ui.notify(`${toggle.label}已${result[toggle.field] ? "开启" : "关闭"}。`, "info");
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

type ChannelResult = { source: "feishu" | "tui"; results: AskResult[] };

/** 传输层兜底：正常路径由连接断开或用户作答结束，这里只防住一个永不回来的请求。 */
const ASK_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * 宿主提供的同名内置工具委托入口。omp 在扩展工具 ctx 上暴露 invokeTool（指向被遮蔽的内置 ask），
 * pi 的旧版本类型里没有这个方法，因此按运行时形状探测：拿不到就退回本扩展的对话框实现。
 */
function nativeAskInvoker(context: ExtensionContext) {
  const candidate = (context as { invokeTool?: unknown }).invokeTool;
  if (typeof candidate !== "function") return undefined;
  // 调用签名由宿主保证（同名内置工具、参数已被 schema 校验），这里只补类型声明。
  return candidate as (
    params: unknown,
    options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

/** 取消与原生一致：中止当前操作并抛错，让上层看到的是「被用户取消」。 */
function askCancelled(context: ExtensionContext): never {
  context.abort();
  throw new Error("原始 ask 已被用户取消（Ask tool was cancelled by the user）。");
}

/** 校验网关回来的答案：跨进程边界只认结构，题目按 id 对齐，缺失按空答案处理。 */
function readAskAnswers(response: unknown, questions: AskQuestion[]): AskResult[] | undefined {
  const answers = asRecord(asRecord(response)?.answers);
  if (!answers) return undefined;
  return questions.map((question) => {
    const entry = asRecord(answers[question.id]);
    const selected = entry?.selectedOptions;
    return {
      question,
      answer: {
        selectedOptions: Array.isArray(selected) ? selected.filter((label): label is string => typeof label === "string") : [],
        customInput: typeof entry?.customInput === "string" ? entry.customInput : undefined,
        note: typeof entry?.note === "string" ? entry.note : undefined,
      },
    };
  });
}

/** 双通道竞速：先给出结果的一侧胜出；一侧失败不影响另一侧继续等待。 */
function raceFirst(candidates: Array<Promise<ChannelResult | undefined>>): Promise<ChannelResult | undefined> {
  return new Promise((resolve) => {
    let remaining = candidates.length;
    for (const candidate of candidates) {
      void candidate.then((value) => {
        if (value !== undefined) resolve(value);
        else if (--remaining === 0) resolve(undefined);
      });
    }
  });
}

/** 终端侧对话框：复刻原生 ask 的选择器回退（单选 + Other、多选勾选循环）。 */
async function runTuiChannel(context: ExtensionContext, questions: AskQuestion[], signal: AbortSignal): Promise<ChannelResult | undefined> {
  const results: AskResult[] = [];
  for (const question of questions) {
    if (signal.aborted) return undefined;
    const answer = await askOnce(context, question, signal);
    if (!answer) return undefined;
    results.push({ question, answer });
  }
  return { source: "tui", results };
}

async function askOnce(context: ExtensionContext, question: AskQuestion, signal: AbortSignal): Promise<AskAnswer | undefined> {
  const title = `${question.header ? `【${question.header}】` : ""}${question.question}`;
  const dialog = { signal };
  if (!question.options.length) {
    const text = await context.ui.input(title, "输入答案 / type your answer", dialog);
    return text === undefined ? undefined : { selectedOptions: [], customInput: text };
  }
  const otherLabel = "Other (type your own)";
  const labels = question.options.map((option, index) => `${option.label}${question.recommended === index ? " (Recommended)" : ""}`);
  if (!question.multi) {
    const picked = await context.ui.select(title, [...labels, otherLabel], dialog);
    if (picked === undefined) return undefined;
    if (picked !== otherLabel) {
      const index = labels.indexOf(picked);
      return { selectedOptions: [question.options[index >= 0 ? index : 0].label] };
    }
    const text = await context.ui.input(title, "输入答案 / type your answer", dialog);
    return text === undefined ? undefined : { selectedOptions: [], customInput: text };
  }
  // 多选：勾选循环，至少选一项后才出现完成项，与原生回退一致。
  const selected: string[] = [];
  for (;;) {
    const entries = labels.map((label, index) => `${selected.includes(question.options[index].label) ? "✅ " : ""}${label}`);
    const doneLabel = "Done selecting";
    const picked = await context.ui.select(title, selected.length ? [...entries, doneLabel, otherLabel] : [...entries, otherLabel], dialog);
    if (picked === undefined) return undefined;
    if (picked === doneLabel) return { selectedOptions: [...selected] };
    if (picked === otherLabel) {
      const text = await context.ui.input(title, "输入答案 / type your answer", dialog);
      return text === undefined ? undefined : { selectedOptions: [...selected], customInput: text };
    }
    const index = entries.indexOf(picked);
    if (index < 0) continue;
    const label = question.options[index].label;
    const at = selected.indexOf(label);
    if (at >= 0) selected.splice(at, 1);
    else selected.push(label);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 飞书通道失败时的终端提示：保留网关返回的原因，便于区分未绑定、离线与飞书接口报错。 */
function askChannelNotice(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return `提问未送到飞书：${reason} 本轮仅在终端作答。`;
}

/** ask 结果的统一外形：text 给模型看，details 给 TUI 渲染，与原生 ask 的返回结构对齐。 */
function askToolResult(results: AskResult[]) {
  return {
    content: [{ type: "text" as const, text: formatAskText(results) }],
    details: formatAskDetails(results),
  };
}
