import { describeMediaFile, type MediaKind } from "../../feishu/media.ts";
import type { RelayTopicHistory } from "../../feishu/relay-topic.ts";

export type RelayBinding = {
  sessionId: string;
  chatId: string;
  threadId: string;
  rootMessageId: string;
  title: string;
  /** 创建话题时的首条本地输入，会话名被清空后据此回退标题。 */
  firstInput: string;
  enabled: boolean;
};

export type RelayTransport = {
  verifyTopicChat(chatId: string, ownerOpenId: string): Promise<void>;
  /**
   * 以调用方给定的 uuid 创建话题。同一 uuid 在飞书的去重窗口内只会落一条消息，
   * 因此用同一个 uuid 重放要么补建、要么取回原话题，都不会产生重复话题。
   */
  createRelayTopic(chatId: string, title: string, uuid: string): Promise<{ threadId: string; rootMessageId: string }>;
  /**
   * 在时间窗口内查找标题匹配的现存话题根消息，用于对账"上次创建到底有没有落下话题"。
   * 找不到且 `complete` 为 true 时，可以认定该话题没有创建。
   */
  findRelayTopicRoot(chatId: string, title: string, fromMs: number, toMs: number): Promise<RelayTopicHistory>;
  replyRelayText(rootMessageId: string, text: string): Promise<void>;
  replyRelayCard(rootMessageId: string, card: object): Promise<string>;
  /** 上传本地媒体并返回平台文件标识（图片 image_key / 文件 file_key）。 */
  uploadRelayMedia(kind: MediaKind, filePath: string, fileName: string): Promise<string>;
  /** 把已上传的媒体作为话题回复投递。 */
  replyRelayMedia(rootMessageId: string, kind: MediaKind, key: string): Promise<string>;
  /** 原地刷新已发出的交互卡（ask 提问卡的作答状态）。 */
  updateRelayCard(messageId: string, card: object): Promise<void>;
  renameRelayTitle(rootMessageId: string, title: string): Promise<void>;
};

/**
 * 出站媒体：本地校验 → 上传 → 话题回复。路径必须已经绝对化，网关无法按终端工作目录解析相对路径。
 */
export async function sendRelayMedia(transport: RelayTransport, binding: RelayBinding, kind: MediaKind, filePath: string) {
  const file = describeMediaFile(filePath, kind);
  const key = await transport.uploadRelayMedia(kind, file.path, file.name);
  await transport.replyRelayMedia(binding.rootMessageId, kind, key);
}

/** 正式回复按 Unicode 字符分块，保留完整文本并避免超出飞书卡片大小限制。 */
export async function sendRelayAnswer(transport: RelayTransport, binding: RelayBinding, text: string) {
  const chars = Array.from(text);
  const count = Math.ceil(chars.length / 6000);
  for (let i = 0; i < count; i++) {
    await transport.replyRelayCard(binding.rootMessageId, {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: `${binding.title}${count > 1 ? ` (${i + 1}/${count})` : ""}` } },
      elements: [{ tag: "markdown", content: chars.slice(i * 6000, (i + 1) * 6000).join("") }],
    });
  }
}
