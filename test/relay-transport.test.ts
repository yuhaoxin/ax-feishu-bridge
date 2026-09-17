import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuTransport } from "../src/feishu/transport.ts";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";

const config: any = { appId: "app", appSecret: "unused-test-secret", domain: "feishu", groupPolicy: "mention", autoStart: false };

test("飞书传输：创建话题验证群主，出站指定 thread 且校验业务错误", async () => {
  const transport = new FeishuTransport(config, async () => {}, async () => {});
  const calls: any[] = [];
  let response: any = { code: 0, data: { message_id: "om_root", thread_id: "omt_topic", group_message_type: "thread", owner_id: "ou_owner" } };
  const call = async (params: any) => { calls.push(params); return response; };
  (transport as any).sdkClient = { im: { v1: { chat: { get: call } }, message: { create: call, reply: call } } };
  await transport.verifyTopicChat("oc_group", "ou_owner");
  await assert.rejects(transport.verifyTopicChat("oc_group", "ou_stranger"), /群主/);
  const topic = await transport.createRelayTopic("oc_group", "标题");
  assert.deepEqual(topic, { threadId: "omt_topic", rootMessageId: "om_root" });
  await transport.replyRelayCard(topic.rootMessageId, { elements: [] });
  assert.equal(calls.at(-1).data.reply_in_thread, true);
  assert.equal(calls.at(-1).path.message_id, "om_root");
  assert.ok(calls.at(-1).data.uuid);
  await transport.replyRelayText(topic.rootMessageId, "通知");
  assert.equal(calls.at(-1).data.reply_in_thread, true);
  response = { code: 999, msg: "internal details" };
  const count = calls.length;
  await assert.rejects(transport.createRelayTopic("oc_group", "失败"), /错误码 999/);
  assert.equal(calls.length, count + 1, "不能自动重试创建话题");
  response = { code: 0, data: { message_id: "om_created" } };
  await assert.rejects(transport.createRelayTopic("oc_group", "缺失话题标识"), /可能已创建但未绑定/);
});

test("飞书传输：接力在群聊触发过滤之前分派，异常不能回落后台", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-transport-"));
  const original = getRuntimeSource();
  setRuntimeSource({ ...original, configPath: join(dir, "config.json"), debugLogPath: join(dir, "debug.log") });
  t.after(() => { setRuntimeSource(original); rmSync(dir, { recursive: true, force: true }); });
  let relay = 0;
  let regular = 0;
  let shouldThrow = false;
  const transport = new FeishuTransport(config, async () => { regular++; }, async () => {}, async (msg) => {
    relay++;
    assert.equal(msg.senderOpenId, "ou_owner");
    if (shouldThrow) throw new Error("接力故障");
    return true;
  });
  const input = { sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } }, message: { message_id: "om_in", chat_id: "oc_group", chat_type: "group", message_type: "text", thread_id: "omt_topic", content: JSON.stringify({ text: "无需 @ 的输入" }) } };
  await (transport as any).handleRawMessage(input);
  assert.equal(relay, 1);
  assert.equal(regular, 0);
  shouldThrow = true;
  await assert.rejects((transport as any).handleRawMessage(input), /接力故障/);
  assert.equal(regular, 0);
});
