import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayGateway } from "../src/adapters/pi/relay-gateway.ts";
import { RelayClient } from "../src/adapters/pi/relay-client.ts";
import type { RelayTransport } from "../src/adapters/pi/relay-output.ts";
import { ASK_ACTION, formatAskDetails, formatAskText } from "../src/feishu/ask-card.ts";
import type { FeishuCardAction, FeishuMessage } from "../src/feishu/types.ts";

type FakeTransport = ReturnType<typeof fakeTransport>;

function fakeTransport() {
  const text: Array<{ root: string; text: string }> = [];
  const cards: Array<{ root: string; card: object }> = [];
  const cardUpdates: Array<{ messageId: string; card: object }> = [];
  const transport: RelayTransport = {
    async verifyTopicChat(chat, owner) { assert.equal(chat, "oc_test"); assert.equal(owner, "ou_owner"); },
    async createRelayTopic(_chat, title) { return { threadId: "omt_1", rootMessageId: "om_1" }; },
    async replyRelayText(root, value) { text.push({ root, text: value }); },
    async replyRelayCard(root, card) { cards.push({ root, card }); return `om_card${cards.length}`; },
    async updateRelayCard(messageId, card) { cardUpdates.push({ messageId, card }); },
    async renameRelayTitle() {},
  };
  return { text, cards, cardUpdates, transport };
}

function incoming(threadId: string, messageId: string, text: string): FeishuMessage {
  return { chatId: "oc_test", chatType: "group", threadId, messageId, senderOpenId: "ou_owner", msgType: "text", content: JSON.stringify({ text }) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }, bind = true, limits?: () => { timeoutMs: number; notifyMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ask-test-"));
  const endpoint = join(dir, "endpoint.json");
  const fake = fakeTransport();
  const gateway = new RelayGateway(join(dir, "state.json"), endpoint, "app_test", fake.transport, undefined, limits);
  await gateway.start();
  const inputs: Array<{ method: string; params: unknown }> = [];
  const client = new RelayClient(endpoint, "session-a", async (method, params) => {
    inputs.push({ method, params });
    return { accepted: true };
  });
  t.after(async () => { client.close(); await gateway.stop(); rmSync(dir, { recursive: true, force: true }); });
  await client.request("configure", { chatId: "oc_test", ownerOpenId: "ou_owner" });
  if (bind) await client.request("autobindTopic", { title: "会话 A", firstInput: "首条输入" });
  return { ...fake, gateway, client, inputs };
}

function answerFor(updated: object | undefined, text: string) {
  return updated !== undefined && JSON.stringify(updated).includes(text);
}

const singleQuestion = [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }];

test("接力 ask：单选按钮点按即作答并回灌终端", async (t) => {
  const f = await fixture(t);
  const ask = f.client.request("ask", { runId: "r1", questions: singleQuestion }, 5000);
  await waitFor(() => f.cards.length === 1);
  const updated = await f.gateway.handleAskAction({
    messageId: "om_card1", chatId: "oc_test", operatorOpenId: "ou_owner",
    value: { action: ASK_ACTION, runId: "r1", questionId: "q1", kind: "option", label: "B" },
  });
  assert.ok(answerFor(updated, "已选：B"), `回调要返回标记已答的卡片，实际：${JSON.stringify(updated)}`);
  const answers = await ask;
  assert.deepEqual(answers.answers.q1.selectedOptions, ["B"]);
  assert.equal(answers.answers.q1.timedOut, undefined);
});

test("接力 ask：多选题必须点提交才算答完", async (t) => {
  const f = await fixture(t);
  const ask = f.client.request("ask", {
    runId: "r2",
    questions: [{ id: "q1", question: "可多选", options: [{ label: "A" }, { label: "B" }], multi: true }],
  }, 5000);
  await waitFor(() => f.cards.length === 1);
  const toggle = (label: string) => f.gateway.handleAskAction({
    messageId: "om_card1", chatId: "oc_test", operatorOpenId: "ou_owner",
    value: { action: ASK_ACTION, runId: "r2", questionId: "q1", kind: "toggle", label },
  });
  // 勾选后卡片必须仍带提交入口，否则用户在飞书侧无法结束多选题（曾把该题当已答渲染）
  const toggled = await toggle("A");
  const labels = (toggled as any).elements
    .filter((element: any) => element.tag === "action")
    .flatMap((element: any) => element.actions.map((action: any) => action.text.content));
  assert.ok(labels.some((label: string) => String(label).includes("提交")), `勾选后要有提交按钮，实际：${JSON.stringify(labels)}`);
  assert.ok(!String(JSON.stringify(toggled)).includes("已选："), "勾选未提交时不能显示成已作答");
  await toggle("B");
  const settledEarly = await Promise.race([ask.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
  assert.equal(settledEarly, false, "未提交前不能结束提问");
  await f.gateway.handleAskAction({
    messageId: "om_card1", chatId: "oc_test", operatorOpenId: "ou_owner",
    value: { action: ASK_ACTION, runId: "r2", questionId: "q1", kind: "submit" },
  });
  const answers = await ask;
  assert.deepEqual(answers.answers.q1.selectedOptions, ["A", "B"]);
});

test("接力 ask：其他文本在话题里被消费，不会当作 steer 送进会话", async (t) => {
  const f = await fixture(t);
  const ask = f.client.request("ask", { runId: "r3", questions: singleQuestion }, 5000);
  await waitFor(() => f.cards.length === 1);
  const awaiting = await f.gateway.handleAskAction({
    messageId: "om_card1", chatId: "oc_test", operatorOpenId: "ou_owner",
    value: { action: ASK_ACTION, runId: "r3", questionId: "q1", kind: "other" },
  });
  assert.ok(answerFor(awaiting, "请在话题里直接回复"), "其他按钮要提示用户在话题里回复文本");
  const handled = await f.gateway.handleMessage(incoming("omt_1", "m_ask_answer", "我想要 C 方案"));
  assert.equal(handled, true);
  assert.equal(f.inputs.filter((item) => item.method === "input").length, 0, "答案文本不能作为 steer 送进会话");
  const answers = await ask;
  assert.equal(answers.answers.q1.customInput, "我想要 C 方案");
  assert.deepEqual(answers.answers.q1.selectedOptions, []);
});

test("接力 ask：未绑定会话拒绝发卡", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    () => f.client.request("ask", { runId: "r4", questions: singleQuestion }, 3000),
    /没有启用的绑定话题/,
  );
});

test("接力 ask：终端断线结束提问并作废卡片", async (t) => {
  const f = await fixture(t);
  // 先挂上失败处理：断线拒绝在 close() 时同步排队，晚挂会变成未处理的 rejection。
  const failure = f.client.request("ask", { runId: "r5", questions: singleQuestion }, 5000)
    .then(() => undefined, (error: Error) => error);
  await waitFor(() => f.cards.length === 1);
  f.client.close();
  await waitFor(() => f.cardUpdates.length === 1);
  assert.ok(answerFor(f.cardUpdates[0].card, "提问已结束"), `断线后卡片要标为已结束，实际：${JSON.stringify(f.cardUpdates[0].card)}`);
  const error = await failure;
  assert.match(error!.message, /接力连接中断/);
});

test("接力 ask：超时按推荐项自动作答并先催单", async (t) => {
  const f = await fixture(t, true, () => ({ timeoutMs: 120, notifyMs: 40 }));
  const ask = f.client.request("ask", {
    runId: "r6",
    questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }], recommended: 1 }],
  }, 8000);
  const answers = await ask;
  assert.deepEqual(answers.answers.q1.selectedOptions, ["B"]);
  assert.equal(answers.answers.q1.timedOut, true);
  assert.ok(f.text.some((entry) => entry.text.includes("提问已等待")), "到期前要先在话题里催单");
  assert.ok(f.cardUpdates.some((update) => answerFor(update.card, "超时自动作答")), "超时后要刷新卡片");
});

test("ask 结果文本与 details 对齐原生结构", () => {
  const question = { id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] };
  const single = formatAskText([{ question, answer: { selectedOptions: ["B"], note: "先看 B" } }]);
  assert.ok(single.includes("B") && single.includes("User added note: 先看 B"), single);
  const singleDetails = formatAskDetails([{ question, answer: { selectedOptions: ["B"] } }]);
  assert.deepEqual(Object.keys(singleDetails).sort(), ["multi", "options", "question", "selectedOptions"]);
  const multi = formatAskText([
    { question, answer: { selectedOptions: ["A"] } },
    { question: { id: "q2", question: "第二个", options: [] }, answer: { selectedOptions: [], customInput: "随便" } },
  ]);
  assert.ok(multi.startsWith("User answers:"), multi);
  assert.ok(multi.includes("q2: 随便"), multi);
  const multiDetails = formatAskDetails([
    { question, answer: { selectedOptions: ["A"], timedOut: true } },
    { question: { id: "q2", question: "第二个", options: [] }, answer: { selectedOptions: [], customInput: "随便" } },
  ]);
  assert.equal(Array.isArray(multiDetails.results), true);
  assert.equal(multiDetails.results[0].timedOut, true);
  assert.equal(multiDetails.results[1].customInput, "随便");
});
