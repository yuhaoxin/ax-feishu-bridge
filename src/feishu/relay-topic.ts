/**
 * 接力话题创建相关的共享判定：错误分类、历史消息匹配。
 *
 * 话题创建只有两种可处理的结局：确定没创建（可以安全重建），或结果不确定（必须留在待对账状态，
 * 靠同一 uuid 重放或历史查询定位）。把分类放在这里，传输层与接力网关用的是同一套判定。
 */

/** 错误文本：日志与用户提示共用同一种呈现。 */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 传输层能证明"请求没有离开本机"的错误码：DNS 解析失败、连接被拒/不可达、TLS 握手失败。 */
const PRE_SEND_CODES: Record<string, true> = {
  ENOTFOUND: true,
  EAI_AGAIN: true,
  ECONNREFUSED: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  CERT_HAS_EXPIRED: true,
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
};

/**
 * 失败是否发生在请求送达之前。只有返回 true 才能断定飞书侧没有落下消息，
 * 从而清掉待建占位、稍后正常重建；超时、连接重置、5xx 都可能已经执行，一律按不确定处理。
 * 错误码可能包在 cause 链里（各层包装会保留原始错误），所以逐层查找。
 */
export function isPreSendFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && PRE_SEND_CODES[code.toUpperCase()] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 话题创建失败。`certainNotCreated` 为 true 表示能确定飞书侧没有落下这条消息
 * （请求没离开本机，或服务端明确拒绝）：调用方可以清掉待建占位、稍后正常重建；
 * 为 false 表示消息可能已创建、响应或落盘丢失，必须留在待对账状态。
 */
export class RelayTopicCreateError extends Error {
  readonly certainNotCreated: boolean;

  constructor(message: string, options: { certainNotCreated: boolean }) {
    super(message);
    this.name = "RelayTopicCreateError";
    this.certainNotCreated = options.certainNotCreated;
  }
}

/** 群历史里按标题查找话题根消息的结果。 */
export type RelayTopicHistory = {
  /** 命中时的话题标识。 */
  topic?: { threadId: string; rootMessageId: string };
  /** 是否扫完了整个时间窗口；false 表示消息数超出分页上限，据此不能断定"未创建"。 */
  complete: boolean;
};

/** 一页历史消息：查询失败必须抛错，否则调用方会把"查不到"误当成"没有创建"。 */
export function parseMessageListPage(value: unknown): { items: unknown[]; pageToken?: string; hasMore: boolean } {
  const envelope = value as { code?: unknown; data?: unknown } | null | undefined;
  if (!envelope || typeof envelope !== "object" || envelope.code !== 0 || !envelope.data) {
    throw new Error(`飞书历史消息查询失败（错误码 ${String(envelope?.code ?? "未知")}）。`);
  }
  const data = envelope.data as { items?: unknown; page_token?: unknown; has_more?: unknown };
  return {
    items: Array.isArray(data.items) ? data.items : [],
    pageToken: typeof data.page_token === "string" && data.page_token ? data.page_token : undefined,
    hasMore: data.has_more === true,
  };
}

/**
 * 一条历史消息是不是本条话题的根消息：正文首行必须与标题完全一致
 * （标题里带会话短 ID，因此不会误认别的接力话题）。回复同样带 thread_id，
 * 所以必须排除 root_id / parent_id 非空的消息。
 */
export function matchRelayTopicRoot(item: unknown, title: string): { threadId: string; rootMessageId: string } | undefined {
  if (!item || typeof item !== "object") return undefined;
  const message = item as { message_id?: unknown; thread_id?: unknown; root_id?: unknown; parent_id?: unknown; body?: { content?: unknown } };
  if (typeof message.message_id !== "string" || typeof message.thread_id !== "string") return undefined;
  if (message.root_id || message.parent_id) return undefined;
  const text = relayTextOf(message.body?.content);
  if (!text || text.split("\n")[0].trim() !== title) return undefined;
  return { threadId: message.thread_id, rootMessageId: message.message_id };
}

/** 从单条消息查询的响应里取第一条消息：SDK 各版本把结果放在 items / message / data 下。 */
export function firstMessageOf(value: unknown): { thread_id?: unknown } | undefined {
  const data = (value as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== "object") return undefined;
  const envelope = data as { items?: unknown; message?: unknown };
  const item = Array.isArray(envelope.items) ? envelope.items[0] : envelope.message ?? data;
  return item && typeof item === "object" ? (item as { thread_id?: unknown }) : undefined;
}

function relayTextOf(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "text" in parsed) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  } catch {}
  return undefined;
}
