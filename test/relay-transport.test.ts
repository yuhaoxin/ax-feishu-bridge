import assert from "node:assert/strict";
import { mkdtempSync, ReadStream, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuTransport } from "../src/feishu/transport.ts";
import { RelayTopicCreateError, isPreSendFailure } from "../src/feishu/relay-topic.ts";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";

const config: any = { appId: "app", appSecret: "unused-test-secret", domain: "feishu", groupPolicy: "mention", autoStart: false };

test("飞书传输：创建话题验证群主，出站指定 thread 且校验业务错误", async () => {
  const transport = new FeishuTransport(config, async () => {}, async () => {});
  const calls: any[] = [];
  let response: any = { code: 0, data: { message_id: "om_root", thread_id: "omt_topic", group_message_type: "thread", owner_id: "ou_owner" } };
  const call = async (params: any) => { calls.push(params); return response; };
  const getCalls: any[] = [];
  const get = async (params: any) => { getCalls.push(params); return { code: 0, data: { items: [{ message_id: "om_created", thread_id: "omt_fetched" }] } }; };
  (transport as any).sdkClient = { im: { v1: { chat: { get: call }, message: { patch: call } }, message: { create: call, reply: call, get } } };
  await transport.verifyTopicChat("oc_group", "ou_owner");
  await assert.rejects(transport.verifyTopicChat("oc_group", "ou_stranger"), /群主/);
  const topic = await transport.createRelayTopic("oc_group", "标题", "uuid-1");
  assert.deepEqual(topic, { threadId: "omt_topic", rootMessageId: "om_root" });
  // 幂等键必须透传：调用方靠同一个 uuid 重放才能拿回原话题而不是又建一个
  assert.equal(calls.at(-1).data.uuid, "uuid-1");
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
  await assert.rejects(transport.createRelayTopic("oc_group", "失败", "uuid-2"), /错误码 999/);
  assert.equal(calls.length, count + 1, "不能自动重试创建话题");
  // 业务码非 0 是服务端明确拒绝：消息没有创建，调用方可以随后正常重建
  await assert.rejects(transport.createRelayTopic("oc_group", "失败", "uuid-3"), (error: unknown) => {
    assert.ok(error instanceof RelayTopicCreateError);
    assert.equal(error.certainNotCreated, true);
    return true;
  });
  // 消息已创建但响应缺话题标识：补查单条消息救回 thread_id，不能要求人工处理
  response = { code: 0, data: { message_id: "om_created" } };
  assert.deepEqual(await transport.createRelayTopic("oc_group", "缺标识", "uuid-4"), { threadId: "omt_fetched", rootMessageId: "om_created" });
  assert.equal(getCalls.at(-1).path.message_id, "om_created");
  // 补查也拿不到话题标识时才报"已创建但未绑定"，且必须按不确定处理
  delete (transport as any).sdkClient.im.message.get;
  await assert.rejects(transport.createRelayTopic("oc_group", "缺标识", "uuid-5"), (error: unknown) => {
    assert.ok(error instanceof RelayTopicCreateError);
    assert.equal(error.certainNotCreated, false);
    assert.match(error.message, /话题已创建但未绑定/);
    return true;
  });
});

test("飞书传输：只有确定没送出去的失败才允许当作未创建", async () => {
  // DNS 解析失败、连接被拒、TLS 握手失败都发生在请求送达之前
  assert.equal(isPreSendFailure(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), true);
  assert.equal(isPreSendFailure(Object.assign(new Error("tls"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })), true);
  // 错误码可能包在 cause 链里：各层包装都必须能判出来
  assert.equal(isPreSendFailure(new Error("fetch failed", { cause: Object.assign(new Error("dns"), { code: "EAI_AGAIN" }) })), true);
  // 超时、连接重置、5xx 都可能已经执行，必须按不确定处理
  assert.equal(isPreSendFailure(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), false);
  assert.equal(isPreSendFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), false);
  assert.equal(isPreSendFailure(new Error("boom")), false);
  assert.equal(isPreSendFailure(undefined), false);

  const transport = new FeishuTransport(config, async () => {}, async () => {});
  (transport as any).sdkClient = { im: { message: { create: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND open.feishu.cn"), { code: "ENOTFOUND" }); } } } };
  await assert.rejects(transport.createRelayTopic("oc_group", "断网", "uuid-a"), (error: unknown) => {
    assert.ok(error instanceof RelayTopicCreateError);
    assert.equal(error.certainNotCreated, true);
    return true;
  });
  (transport as any).sdkClient = { im: { message: { create: async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); } } } };
  await assert.rejects(transport.createRelayTopic("oc_group", "断链", "uuid-b"), (error: unknown) => {
    assert.ok(error instanceof RelayTopicCreateError);
    assert.equal(error.certainNotCreated, false);
    return true;
  });
});

test("飞书传输：按时间窗口在群历史里认领接力话题根消息", async () => {
  const transport = new FeishuTransport(config, async () => {}, async () => {});
  const title = "项目:首条输入 [01a0eada]";
  const rootText = JSON.stringify({ text: `${title}\n本话题接收本机终端输入与每轮正式回复。` });
  const pages: any[] = [
    { code: 0, data: { items: [
      // 回复同样带 thread_id：不能当成话题根
      { message_id: "om_reply", thread_id: "omt_x", root_id: "om_other", parent_id: "om_other", body: { content: JSON.stringify({ text: title }) } },
      // 标题只差一个字符：不能命中（标题里带会话短 ID，正是为了区分）
      { message_id: "om_other", thread_id: "omt_y", body: { content: JSON.stringify({ text: "项目:首条输入 [01a0ffff]\n说明" }) } },
    ], page_token: "p2", has_more: true } },
    { code: 0, data: { items: [{ message_id: "om_root", thread_id: "omt_hit", body: { content: rootText } }], has_more: false } },
  ];
  const listCalls: any[] = [];
  (transport as any).sdkClient = { im: { v1: { message: { list: async (params: any) => { listCalls.push(params); return pages.shift(); } } } } };
  const found = await transport.findRelayTopicRoot("oc_group", title, 1_759_000_000_000, 1_759_001_200_000);
  assert.deepEqual(found, { topic: { threadId: "omt_hit", rootMessageId: "om_root" }, complete: true });
  assert.equal(listCalls[0].params.container_id_type, "chat");
  assert.equal(listCalls[0].params.container_id, "oc_group");
  assert.equal(listCalls[0].params.start_time, "1759000000");
  assert.equal(listCalls[0].params.end_time, "1759001200");
  assert.equal(listCalls[1].params.page_token, "p2", "翻页必须带上 page_token");

  // 扫完窗口没有命中：可以认定"未创建"
  (transport as any).sdkClient = { im: { v1: { message: { list: async () => ({ code: 0, data: { items: [], has_more: false } }) } } } };
  assert.deepEqual(await transport.findRelayTopicRoot("oc_group", title, 0, 1), { complete: true });
  // 查询本身失败必须抛错：把"查不到"当成"没创建"会漏掉已存在的孤立话题
  (transport as any).sdkClient = { im: { v1: { message: { list: async () => ({ code: 999, msg: "no permission" }) } } } };
  await assert.rejects(transport.findRelayTopicRoot("oc_group", title, 0, 1), /历史消息查询失败/);
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
