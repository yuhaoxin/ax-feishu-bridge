import assert from "node:assert/strict";
import { mkdtempSync, ReadStream, rmSync, writeFileSync } from "node:fs";
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
  (transport as any).sdkClient = { im: { v1: { chat: { get: call }, message: { patch: call } }, message: { create: call, reply: call } } };
  await transport.verifyTopicChat("oc_group", "ou_owner");
  await assert.rejects(transport.verifyTopicChat("oc_group", "ou_stranger"), /群主/);
  const topic = await transport.createRelayTopic("oc_group", "标题");
  assert.deepEqual(topic, { threadId: "omt_topic", rootMessageId: "om_root" });
  // 根消息正文就是话题标题的展示，同时说明本话题会收到什么
  assert.equal(JSON.parse(calls.at(-1).data.content).text, "标题\n本话题接收本机终端输入与每轮正式回复。");
  await transport.replyRelayCard(topic.rootMessageId, { elements: [] });
  assert.equal(calls.at(-1).data.reply_in_thread, true);
  assert.equal(calls.at(-1).path.message_id, "om_root");
  assert.ok(calls.at(-1).data.uuid);
  // 改名后话题说明必须与创建时一致
  await transport.renameRelayTitle(topic.rootMessageId, "新标题");
  assert.equal(calls.at(-1).path.message_id, "om_root");
  assert.equal(JSON.parse(calls.at(-1).data.content).text, "新标题\n本话题接收本机终端输入与每轮正式回复。");
  await transport.replyRelayText(topic.rootMessageId, "通知");
  assert.equal(calls.at(-1).data.reply_in_thread, true);
  response = { code: 999, msg: "internal details" };
  const count = calls.length;
  await assert.rejects(transport.createRelayTopic("oc_group", "失败"), /错误码 999/);
  assert.equal(calls.length, count + 1, "不能自动重试创建话题");
  response = { code: 0, data: { message_id: "om_created" } };
  await assert.rejects(transport.createRelayTopic("oc_group", "缺失话题标识"), /可能已创建但未绑定/);
});

test("飞书传输：出站媒体先上传再按话题回复，缺标识必须报错", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-media-transport-"));
  const shot = join(dir, "shot.png");
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // 只替换 sdkClient：上传与回复的请求体形状是本测试的断言对象。
  type SdkCall = { data: Record<string, unknown>; path?: Record<string, unknown> };
  const calls: SdkCall[] = [];
  // 上传接口在 SDK 1.65 里直接把响应体返回（键在顶层），v1 的其它接口仍是 { code, data }：两种形状都要覆盖。
  let response: unknown = { image_key: "img_key" };
  const call = async (params: SdkCall) => { calls.push(params); return response; };
  // 假 SDK 不会读完流，收尾必须自己关掉，否则临时目录先被删会得到 ENOENT
  t.after(() => {
    for (const entry of calls) {
      const stream = entry.data.image ?? entry.data.file;
      if (stream instanceof ReadStream) stream.destroy();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = new FeishuTransport(config, async () => {}, async () => {});
  const sdkClient = { im: { v1: { image: { create: call }, file: { create: call } }, message: { reply: call } } };
  // 测试替身：FeishuTransport 的 sdkClient 由 start() 从 lark SDK 构造，这里直接注入同形状的假客户端。
  (transport as unknown as { sdkClient: unknown }).sdkClient = sdkClient;
  assert.equal(await transport.uploadRelayMedia("image", shot, "shot.png"), "img_key");
  const uploaded = calls.at(-1)!;
  assert.equal(uploaded.data.image_type, "message", "图片必须按消息图片上传，否则飞书不给渲染");
  assert.ok(uploaded.data.image instanceof ReadStream, "上传要传流，不能整文件读进内存");
  // 有的 SDK 版本把上传响应包成 { code, data }：同样要取到 key，不能当失败
  response = { code: 0, data: { image_key: "nested_key" } };
  assert.equal(await transport.uploadRelayMedia("image", shot, "shot.png"), "nested_key");
  response = { file_key: "file_key" };
  assert.equal(await transport.uploadRelayMedia("file", shot, "报告.pdf"), "file_key");
  const uploadedFile = calls.at(-1)!;
  assert.equal(uploadedFile.data.file_type, "stream");
  assert.equal(uploadedFile.data.file_name, "报告.pdf");
  assert.ok(uploadedFile.data.file instanceof ReadStream);
  response = { code: 0, data: { message_id: "om_media" } };
  assert.equal(await transport.replyRelayMedia("om_root", "image", "img_key"), "om_media");
  const imageReply = calls.at(-1)!;
  assert.equal(imageReply.data.msg_type, "image");
  assert.equal(imageReply.data.reply_in_thread, true);
  assert.equal(imageReply.path?.message_id, "om_root");
  assert.deepEqual(JSON.parse(String(imageReply.data.content)), { image_key: "img_key" });
  await transport.replyRelayMedia("om_root", "file", "file_key");
  const fileReply = calls.at(-1)!;
  assert.equal(fileReply.data.msg_type, "file");
  assert.deepEqual(JSON.parse(String(fileReply.data.content)), { file_key: "file_key" });
  // 平台没返回标识或消息 id 时必须报错，不能让调用方以为发出去了
  response = {};
  await assert.rejects(transport.uploadRelayMedia("image", shot, "shot.png"), /未返回图片标识/);
  await assert.rejects(transport.uploadRelayMedia("file", shot, "shot.png"), /未返回文件标识/);
  response = { code: 0, data: {} };
  await assert.rejects(transport.replyRelayMedia("om_root", "file", "file_key"), /未返回消息标识/);
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
