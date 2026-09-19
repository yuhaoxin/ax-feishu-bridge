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
  createRelayTopic(chatId: string, title: string): Promise<{ threadId: string; rootMessageId: string }>;
  replyRelayText(rootMessageId: string, text: string): Promise<void>;
  replyRelayCard(rootMessageId: string, card: object): Promise<string>;
  renameRelayTitle(rootMessageId: string, title: string): Promise<void>;
};

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
