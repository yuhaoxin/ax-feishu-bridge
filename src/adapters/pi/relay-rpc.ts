import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

const MAX_FRAME_BYTES = 1024 * 1024;
export type RelayHandler = (method: string, params: any) => unknown | Promise<unknown>;

/** 仅在本机环回连接上传输；每个请求都校验当前网关的随机凭证。 */
export class RelayPeer {
  private buffer = "";
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(
    readonly socket: Socket,
    private readonly token: string,
    private readonly handler: RelayHandler,
    private readonly onClose: () => void = () => {},
  ) {
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("data", (data) => this.receive(String(data)));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  get connected() { return !this.closed; }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("接力连接已断开，未确认是否接收；请检查终端后再操作。"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("接力请求超时，未确认是否接收；请检查终端后再操作。"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params, token: this.token });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("接力连接中断，未确认是否接收；请检查终端后再操作。"));
    }
    this.pending.clear();
    this.onClose();
  }

  private send(frame: unknown) {
    const data = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES || this.socket.writableLength > MAX_FRAME_BYTES * 2) {
      this.close();
      return;
    }
    this.socket.write(data);
  }

  private receive(data: string) {
    this.buffer += data;
    let end: number;
    while (!this.closed && (end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.close();
      let frame: any;
      try { frame = JSON.parse(line); } catch { return this.close(); }
      if (!frame || typeof frame.id !== "string") return this.close();
      if (typeof frame.method === "string") {
        if (frame.token !== this.token) return this.close();
        // 响应不能排在请求处理队列后，否则双向请求会互相等待。
        void Promise.resolve().then(() => this.handler(frame.method, frame.params)).then(
          (result) => this.send({ id: frame.id, result }),
          (error) => this.send({ id: frame.id, error: error instanceof Error ? error.message : "接力请求失败。" }),
        );
      } else {
        const item = this.pending.get(frame.id);
        if (!item) continue;
        clearTimeout(item.timer);
        this.pending.delete(frame.id);
        if (typeof frame.error === "string") item.reject(new Error(frame.error));
        else item.resolve(frame.result);
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.close();
  }
}
