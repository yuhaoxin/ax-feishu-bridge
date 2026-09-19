import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { RelayPeer, type RelayHandler } from "./relay-rpc.ts";
import type { RelayBinding } from "./relay-output.ts";

export class RelayClient {
  private peer?: RelayPeer;
  private opening?: Promise<void>;
  private epoch = 0;
  binding?: RelayBinding;
  /** 输入镜像开关（网关全局设置，缺省为开）；随 register/ping/status/echo 刷新。 */
  echo = true;
  constructor(
    private readonly endpointPath: string,
    private readonly sessionId: string,
    private readonly receive: RelayHandler,
    private readonly disconnected: () => void = () => {},
  ) {}

  get connected() { return this.peer?.connected === true && !this.opening; }

  async connect() {
    if (this.opening) return this.opening;
    if (this.peer?.connected) return;
    const epoch = this.epoch;
    const opening = this.open(epoch);
    this.opening = opening;
    try { await opening; } finally { if (this.opening === opening) this.opening = undefined; }
  }

  private async open(epoch: number) {
    let endpoint: any;
    try { endpoint = JSON.parse(readFileSync(this.endpointPath, "utf8")); }
    catch { throw new Error("飞书接力网关未运行，请先执行 /feishu start。"); }
    if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) {
      throw new Error("本机接力连接信息无效。");
    }
    const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
    const peer = new RelayPeer(socket, endpoint.token, (method, params) => {
      if (epoch !== this.epoch || peer !== this.peer) return { accepted: false };
      return this.receive(method, params);
    }, () => {
      if (this.peer === peer) {
        this.peer = undefined;
        this.binding = undefined;
        this.disconnected();
      }
    });
    this.peer = peer;
    try {
      const registered = await peer.request("register", { sessionId: this.sessionId }, 5000);
      if (epoch !== this.epoch || !peer.connected) throw new Error("会话已切换或接力连接已关闭。");
      this.applyView(registered);
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  async request(method: string, params: unknown = {}) {
    await this.connect();
    if (!this.peer?.connected) throw new Error("当前接力连接已离线。");
    const result = await this.peer.request(method, params);
    if (method === "register" || method === "ping" || method === "status") this.applyView(result);
    else if (method === "echo") this.echo = result?.echo !== false;
    else if (method === "unbind" || method === "rename") this.binding = result;
    else if (method === "autobindTopic" && result?.created) this.binding = result.binding;
    return result;
  }

  /** register/ping/status 返回绑定与全局开关；echo 缺省视为开。 */
  private applyView(view: any) {
    this.binding = view?.binding;
    this.echo = view?.echo !== false;
  }

  /** 输出只能走现有连接，不允许断线后自动重发。 */
  output(snapshot: unknown) {
    if (!this.connected || !this.binding?.enabled) return Promise.reject(new Error("接力输出未发送：连接已离线或会话已解绑。"));
    return this.peer!.request("output", snapshot);
  }

  close() {
    this.epoch++;
    this.peer?.close();
    this.binding = undefined;
  }
}
