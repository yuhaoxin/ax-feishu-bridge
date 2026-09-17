import test from "node:test";
import assert from "node:assert/strict";

// 必须在导入前设置 HOME：debugLog 的落盘路径在模块加载时基于它计算，
// 否则 CardKitStream 的调试日志会写入真实 ~/.pi/agent/feishu/debug.pi.log。
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const homeDir = mkdtempSync(join(tmpdir(), "feishu-cardkit-test-"));
process.env.HOME = homeDir;
const { CardKitStream } = await import("../src/feishu/cardkit-stream.ts");

test("CardKit creates a reply-in-progress card before the first text delta", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }));
    }
    if (url.endsWith("/cardkit/v1/cards")) {
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card-1" } }));
    }
    if (url.endsWith("/messages/incoming-1/reply")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "outgoing-1" } }));
    }
    if (url.endsWith("/card-1/settings")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    if (url.endsWith("/cardkit/v1/cards/card-1")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const stream = new CardKitStream(
      "app-id",
      "app-secret",
      "feishu",
      "incoming-1",
      async () => {},
      { conversationKey: "p2p:user", runId: "run-1" },
    );

    await stream.startImmediately();

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /tenant_access_token\/internal$/);
    assert.match(calls[1].url, /cardkit\/v1\/cards$/);
    assert.match(calls[2].url, /messages\/incoming-1\/reply$/);

    const createPayload = JSON.parse(String(calls[1].init?.body));
    const waitingCard = JSON.parse(createPayload.data);
    assert.equal(waitingCard.header.title.content, "回复中");
    assert.equal(waitingCard.body.elements[0].content, "正在回复…");

    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
