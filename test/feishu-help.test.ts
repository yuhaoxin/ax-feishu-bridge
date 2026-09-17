import test from "node:test";
import assert from "node:assert/strict";
import { feishuHelp, relayHelp } from "../src/adapters/pi/feishu-help.ts";

test("feishu help 覆盖全部子命令及其参数", () => {
  const help = feishuHelp();
  for (const sub of ["setup", "start", "stop", "restart", "status", "debug", "autostart", "reset", "tools on|off", "relay", "help"]) {
    assert.match(help, new RegExp(`/feishu ${sub.replace("|", "\\|")}`), `缺少子命令 ${sub}`);
  }
  // relay 子命令必须带参数说明，避免只列名字不知道怎么填
  assert.match(help, /relay setup <群chat_id> <你的open_id>/);
  assert.match(help, /relay bind \[名称\]/);
  assert.match(help, /relay push <文本>/);
});

test("relay help 覆盖接力子命令，错误路径也返回完整说明", () => {
  const help = relayHelp();
  for (const sub of ["setup", "bind", "status", "push", "unbind"]) {
    assert.match(help, new RegExp(`relay ${sub}`), `缺少接力子命令 ${sub}`);
  }
  assert.match(help, /一次性/);
  assert.match(help, /复用原话题/);
});
