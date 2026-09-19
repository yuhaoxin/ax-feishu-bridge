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
  assert.match(help, /relay autobind on\|off/);
  assert.match(help, /relay exit-notice on\|off/);
  assert.match(help, /relay push <文本>/);
  assert.match(help, /relay unbind/);
  assert.doesNotMatch(help, /relay bind/);
});

test("relay help 覆盖接力子命令，错误路径也返回完整说明", () => {
  const help = relayHelp();
  for (const sub of ["setup", "autobind on|off", "echo on|off", "exit-notice on|off", "status", "push", "unbind"]) {
    assert.match(help, new RegExp(`relay ${sub.replace("|", "\\|")}`), `缺少接力子命令 ${sub}`);
  }
  assert.match(help, /一次性/);
  assert.doesNotMatch(help, /relay bind/);
});
