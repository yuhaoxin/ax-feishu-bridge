/** /feishu 命令的帮助文本：所有子命令及其参数。 */
export function feishuHelp(): string {
  return [
    "飞书命令用法：",
    "",
    "连接管理",
    "  /feishu setup                       引导创建或配置飞书机器人（扫码/手动填 App ID 与 Secret），完成后自动启动网关",
    "  /feishu start                       启动飞书网关（后台常驻进程，Pi 关闭后仍可对话）",
    "  /feishu stop                        停止飞书网关",
    "  /feishu restart                     重启网关；修改配置或代码后执行使其生效",
    "  /feishu status                      查看连接状态、网关 owner、配置摘要和日志路径（/feishu 不带参数同此）",
    "  /feishu debug                       显示最近 20 行调试日志",
    "",
    "配置",
    "  /feishu autostart                   切换「启动 Pi 时自动连接飞书」",
    "  /feishu reset                       清除机器人配置和普通会话映射（保留会话历史与接力路由，需确认）",
    "  /feishu tools on|off                显示/隐藏 feishu_config_* 工具（仅当前会话）",
    "  /feishu tools                       查看配置工具当前是否启用",
    "",
    "会话接力（新会话自动建话题；详见 docs/pi-session-relay.md）",
    "  /feishu relay setup <群chat_id> <你的open_id>   一次性配置接力目标话题群与授权账号（须为群主的 open_id）",
    "  /feishu relay autobind on|off       开关「新会话自动绑定话题」（默认开）；关闭时新会话不再建话题",
    "  /feishu relay status                查看当前会话的绑定状态",
    "  /feishu relay push <文本>           向当前会话的绑定话题主动推送一条消息",
    "  /feishu relay unbind                解绑当前会话并永久退出自动绑定（不删历史与话题）",
    "  /feishu relay help                  显示接力命令说明",
    "",
    "  /feishu help                        显示本说明",
  ].join("\n");
}

/** /feishu relay 的帮助文本。 */
export function relayHelp(): string {
  return [
    "飞书会话接力用法（只能操作当前 TUI 会话；目标群与授权账号由 setup 一次性锁定）：",
    "",
    "  /feishu relay setup <群chat_id> <你的open_id>   配置目标话题群与授权账号；执行一次即可",
    "  /feishu relay autobind on|off       开关「新会话自动绑定话题」；默认开",
    "  /feishu relay status                查看当前会话绑定状态",
    "  /feishu relay push <文本>           向当前会话的绑定话题主动推送一条消息（最多 100000 字符）",
    "  /feishu relay unbind                解绑当前会话并永久退出自动绑定；旧话题继续拒绝执行"
  ].join("\n");
}
