import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import type { FeishuMessage } from "../../feishu/types.ts";
import { parseMessageInput } from "../../feishu/messages.ts";
import { RelayPeer } from "./relay-rpc.ts";
import { sendRelayAnswer, type RelayBinding, type RelayTransport } from "./relay-output.ts";

export type RelayState = {
  version: 2;
  appId: string;
  /** autobind 缺省为开；echo（本地输入镜像）缺省为开。 */
  settings?: { chatId: string; ownerOpenId: string; autobind?: boolean; echo?: boolean };
  pendingTopic?: { sessionId: string; title: string };
  bindings: RelayBinding[];
  receipts: Record<string, number>;
  /** 主动退出接力的会话：不再自动绑定；旧话题记录保留以持续拦截。 */
  optOut: string[];
};

export function writeRelayJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class RelayGateway {
  private readonly token = randomBytes(32).toString("hex");
  private server?: Server;
  private peers = new Set<RelayPeer>();
  private sessions = new Map<string, RelayPeer>();
  private state: RelayState;
  private control: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly endpointPath: string,
    appId: string,
    private readonly transport: RelayTransport,
    private readonly isBackendSession: (sessionId: string) => Promise<boolean> = async () => false,
  ) {
    const parsed: any = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { version: 2, appId, bindings: [], receipts: {}, optOut: [] };
    this.state = parsed;
    if (!Array.isArray(this.state.optOut)) this.state.optOut = [];
    // 旧版本缺 firstInput，无法重建话题标题；直接拒绝比猜测回退规则安全。
    if (parsed.version === 1)
      throw new Error("接力状态文件是旧版本，不再兼容：请停止网关、备份 relay-state.pi.json 后删除该文件，再重新执行 /feishu relay setup。删除后旧接力话题会回落为普通后台会话，请先确认旧话题不再使用。");
    if (parsed.version !== 2 || parsed.appId !== appId || !Array.isArray(parsed.bindings) || !parsed.receipts)
      throw new Error("接力状态无效或属于其他机器人，请检查接力状态文件。");
    for (const binding of this.state.bindings) {
      if (![binding.sessionId, binding.chatId, binding.threadId, binding.rootMessageId, binding.title, binding.firstInput].every((s) => typeof s === "string" && s.length) || typeof binding.enabled !== "boolean") {
        throw new Error("接力绑定数据损坏；为避免消息进入错误会话，已停止接力服务。");
      }
    }
  }

  async start() {
    this.server = createServer((socket) => {
      let sessionId: string | undefined;
      const peer = new RelayPeer(socket, this.token, async (method, params) => {
        if (method === "register") {
          if (sessionId) throw new Error("此连接已注册会话。");
          const id = requireString(params?.sessionId, 200);
          sessionId = id;
          if (await this.isBackendSession(id)) throw new Error("此会话已由飞书后台加载，请先在飞书切换到新会话并重启网关，再连接终端接力。");
          if (!peer.connected) throw new Error("终端连接已断开。");
          if (this.sessions.has(id)) throw new Error("同一会话已在另一个终端连接，请先断开原终端。");
          sessionId = id;
          this.sessions.set(id, peer);
          return this.relayView(id);
        }
        if (!sessionId || this.sessions.get(sessionId) !== peer) throw new Error("请先注册当前会话。");
        const id = sessionId;
        if (method === "ping" || method === "status") return this.relayView(id);
        if (method === "output") {
          const binding = this.binding(id);
          if (!binding?.enabled) throw new Error("当前会话尚未绑定或已解绑。");
          const outputId = requireString(params?.id, 200);
          const text = requireString(params?.text, 200_000);
          const receipt = `output:${id}:${outputId}`;
          if (this.state.receipts[receipt]) throw new Error("这条回复已有投递记录，不会重复发送；请检查飞书。");
          this.state.receipts[receipt] = Date.now();
          this.save();
          await sendRelayAnswer(this.transport, binding, text);
          return { delivered: true };
        }
        // 配置及绑定变更只有网关写入，串行执行避免重复创建话题或相互覆盖。
        const work = this.control.then(async () => {
          if (!peer.connected || this.sessions.get(id) !== peer) throw new Error("当前终端已离线。");
          return this.command(id, method, params);
        });
        this.control = work.catch(() => {});
        return work;
      }, () => {
        this.peers.delete(peer);
        if (sessionId && this.sessions.get(sessionId) === peer) this.sessions.delete(sessionId);
      });
      this.peers.add(peer);
      socket.setTimeout(35_000, () => peer.close());
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("无法建立本机接力端口。");
    writeRelayJson(this.endpointPath, { version: 1, port: address.port, token: this.token, pid: process.pid });
  }

  async stop() {
    for (const peer of this.peers) peer.close();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    try {
      if (JSON.parse(readFileSync(this.endpointPath, "utf8")).token === this.token) unlinkSync(this.endpointPath);
    } catch {}
  }

  /** 返回 true 表示属于接力话题，包括解绑、离线和无权限，不允许回落到后台模型。 */
  async handleMessage(msg: FeishuMessage): Promise<boolean> {
    const binding = this.state.bindings.find((b) => b.chatId === msg.chatId && (
      b.threadId === msg.threadId || b.rootMessageId === msg.rootId || b.rootMessageId === msg.parentId || b.rootMessageId === msg.messageId
    ));
    // 创建话题的响应或落盘结果不确定时，阻断目标群的后台回落，避免孤立话题执行到其他会话。
    if (!binding) return Boolean(this.state.pendingTopic && msg.chatId === this.state.settings?.chatId);
    if (msg.senderOpenId !== this.state.settings?.ownerOpenId) return true;
    if (this.state.receipts[msg.messageId]) return true;
    // 先落盘再投递。连接中断或进程崩溃也不自动重放可能已经执行过的指令。
    this.state.receipts[msg.messageId] = Date.now();
    this.save();
    const peer = this.sessions.get(binding.sessionId);
    if (!binding.enabled || !peer?.connected) {
      await this.transport.replyRelayText(binding.rootMessageId, binding.enabled ? "绑定的 Pi TUI 已离线，消息未执行，也不会排队或自动重放。" : "此话题已解绑，消息未执行。");
      return true;
    }
    const input = parseMessageInput(msg);
    if (input.attachments.length || !input.text.trim()) {
      await this.transport.replyRelayText(binding.rootMessageId, "接力话题目前仅接收文本消息，请在终端处理附件。");
      return true;
    }
    try {
      const result = await peer.request("input", { sessionId: binding.sessionId, messageId: msg.messageId, text: input.text }, 8_000);
      if (result?.accepted !== true) {
        await this.transport.replyRelayText(binding.rootMessageId, "当前终端已切换会话或正在退出，消息未执行。");
      } else if (result.busy) {
        await this.transport.replyRelayText(binding.rootMessageId, "已送达 Pi TUI，将在工具执行边界引导当前任务。");
      }
    } catch {
      await this.transport.replyRelayText(binding.rootMessageId, "未确认 Pi TUI 是否接收，消息不会自动重试。请检查终端后再决定是否重发。");
    }
    return true;
  }

  protectsSession(sessionId: string) { return this.sessions.has(sessionId) || Boolean(this.binding(sessionId)); }

  /** 会话可能有多个绑定记录（解绑后换名会新增）；状态与操作始终指向启用的那个。 */
  private binding(sessionId: string) {
    return this.state.bindings.find((b) => b.sessionId === sessionId && b.enabled)
      ?? [...this.state.bindings].reverse().find((b) => b.sessionId === sessionId);
  }

  /** register/ping/status 统一返回绑定与全局开关：终端据此决定是否镜像本地输入。 */
  private relayView(sessionId: string) {
    return { binding: this.binding(sessionId), echo: this.state.settings?.echo !== false };
  }
  private save() { writeRelayJson(this.statePath, this.state); }

  private async command(sessionId: string, method: string, params: any) {
    if (method === "configure") {
      const chatId = requireString(params?.chatId, 200);
      const ownerOpenId = requireString(params?.ownerOpenId, 200);
      if (!/^oc_[\w]+$/.test(chatId) || !/^ou_[\w]+$/.test(ownerOpenId)) throw new Error("请提供有效的群 chat_id 和个人 open_id。");
      if (this.state.bindings.length && (this.state.settings?.chatId !== chatId || this.state.settings?.ownerOpenId !== ownerOpenId)) {
        throw new Error("已有接力话题，不允许更换目标群或授权账号；请使用独立机器人。");
      }
      await this.transport.verifyTopicChat(chatId, ownerOpenId);
      this.state.settings = { chatId, ownerOpenId };
      this.save();
      return { configured: true };
    }
    const binding = this.binding(sessionId);
    if (method === "autobind") {
      if (!this.state.settings) throw new Error("请先在终端执行 /feishu relay setup <群chat_id> <你的open_id>。");
      this.state.settings.autobind = Boolean(params?.enabled);
      this.save();
      return { autobind: this.state.settings.autobind };
    }
    if (method === "echo") {
      if (!this.state.settings) throw new Error("请先在终端执行 /feishu relay setup <群chat_id> <你的open_id>。");
      if (typeof params?.enabled !== "boolean") throw new Error("输入镜像开关需要 on 或 off。");
      this.state.settings.echo = params.enabled;
      this.save();
      return { echo: this.state.settings.echo };
    }
    if (method === "autobindTopic") {
      if (!this.state.settings) return { created: false, reason: "unconfigured" };
      if (this.state.settings.autobind === false) return { created: false, reason: "disabled" };
      if (binding?.enabled) return { created: true, binding };
      if (this.state.optOut.includes(sessionId)) return { created: false, reason: "opted-out" };
      if (this.state.pendingTopic) throw new Error("上次话题创建结果未确认，已暂停创建及目标群的普通会话分派。请检查 relay-state.pi.json 中的 pendingTopic，不要反复重试。");
      // firstInput 先校验：参数不合格时不能留下 pendingTopic 把后续创建全部阻断。
      const title = `${requireString(params?.title, 120)} [${sessionId.slice(0, 8)}]`;
      const firstInput = requireString(params?.firstInput, 200);
      const { chatId } = this.state.settings;
      this.state.pendingTopic = { sessionId, title };
      this.save();
      const topic = await this.transport.createRelayTopic(chatId, title);
      const created = { sessionId, chatId, title, firstInput, enabled: true, ...topic };
      const next = { ...this.state, bindings: [...this.state.bindings, created] };
      delete next.pendingTopic;
      writeRelayJson(this.statePath, next);
      this.state = next;
      return { created: true, binding: created };
    }
    if (method === "rename") {
      if (!binding?.enabled) throw new Error("当前会话尚未绑定，没有可改名的话题。");
      const title = `${requireString(params?.title, 120)} [${sessionId.slice(0, 8)}]`;
      if (title === binding.title) return binding;
      await this.transport.renameRelayTitle(binding.rootMessageId, title);
      binding.title = title;
      this.save();
      return binding;
    }
    if (method === "unbind") {
      // unbind 即本会话永久退出接力：不再自动绑定；旧话题记录保留并继续拦截。
      if (binding?.enabled) { binding.enabled = false; }
      if (!this.state.optOut.includes(sessionId)) {
        this.state.optOut.push(sessionId);
      }
      this.save();
      return binding || { unbound: true };
    }
    if (!binding?.enabled) throw new Error("当前会话没有启用的绑定话题。");
    if (method === "push") {
      await this.transport.replyRelayText(binding.rootMessageId, requireString(params?.text, 100_000));
      return { delivered: true };
    }
    throw new Error("未知的接力操作。");
  }
}

export function requireString(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`需要非空文本，长度不能超过 ${max}。`);
  return value.trim();
}

