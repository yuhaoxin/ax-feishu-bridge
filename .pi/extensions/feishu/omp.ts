/**
 * omp 扩展入口（薄 bootstrap）：与 pi 入口共用适配器，只额外声明 omp 运行时。
 *
 * 运行时身份放在入口而不是环境变量，是因为 daemon 用 `-e <入口文件>` 重新加载同一份
 * 入口：入口自身声明了 runtime，daemon 就必然继承 omp 的配置/状态/锁，不需要用户
 * 在启动 omp 时额外导出变量。pi 侧入口同理显式声明 "pi"。
 */
import { fileURLToPath } from "node:url";
import createPiFeishuExtension from "../../../src/adapters/pi/index.ts";

type HostApi = Parameters<typeof createPiFeishuExtension>[0];

export default function feishuOmpExtension(pi: HostApi) {
  return createPiFeishuExtension(pi, { extensionPath: fileURLToPath(import.meta.url), runtime: "omp" });
}
