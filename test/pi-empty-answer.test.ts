import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在导入前设置 HOME：模块加载时按它定型配置路径，否则测试会写进真实 ~/.pi/agent/feishu/。
const homeDir = mkdtempSync(join(tmpdir(), "feishu-empty-answer-"));
process.env.HOME = homeDir;
const { describeEmptyAnswer, extractLastAssistantText } = await import("../src/adapters/pi/PiConversationRuntime.ts");

const sessionWith = (messages: any[]) => ({ messages }) as any;

test("后台会话：回复文本取最后一条有文本的助手消息，纯工具调用与思考不算回复", () => {
  const session = sessionWith([
    { role: "user", content: "问题" },
    { role: "assistant", content: [{ type: "text", text: "旧答案" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "再想想" }] },
  ]);
  assert.equal(extractLastAssistantText(session), "旧答案");
  assert.equal(extractLastAssistantText(sessionWith([{ role: "assistant", content: [{ type: "text", text: "  只有空格  " }] }])), "只有空格");
  assert.equal(extractLastAssistantText(sessionWith([{ role: "user", content: "问题" }])), "");
});

test("后台会话：空答案说明带上真实原因，不把模型无输出伪装成正常回复", () => {
  const limited = sessionWith([
    { role: "user", content: "问题" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "Rate limit exceeded for deepseek/deepseek-v4.1-flash" },
  ]);
  assert.equal(extractLastAssistantText(limited), "", "报错轮没有回复文本");
  assert.match(describeEmptyAnswer(limited), /Rate limit exceeded/);

  assert.match(describeEmptyAnswer(sessionWith([{ role: "assistant", content: [], stopReason: "aborted" }])), /中止/);
  assert.match(describeEmptyAnswer(sessionWith([{ role: "assistant", content: [{ type: "thinking", thinking: "只思考" }] }])), /没有返回内容/);
  assert.match(describeEmptyAnswer(sessionWith([])), /没有返回内容/);
});

test.after(() => rmSync(homeDir, { recursive: true, force: true }));
