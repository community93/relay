# AI → Relay → 交付

AI 工具可以把接口配置、检查规则和说明写进正在运行的 Relay。用户在应用里看到相同的集合、响应和文档，审阅后确认交付。验证时间与响应样例由 Relay 的真实执行产生。

## 连接

1. 打开 Relay，选择本次验证要用的环境。
2. 点击右上角 **AI**，或进入 **设置 → AI 连接 → 管理连接**。
3. 点击 **开启 AI 连接 → 保存连接配置**，把配置文件路径告诉 AI 工具。
4. 在 AI 工具中加载 `skills/relay-workflow`，描述接口范围、来源和允许验证的环境。

连接只监听 `127.0.0.1`，使用随机端口与访问凭证，默认关闭。关闭连接或应用后配置失效，需要重新保存。配置含凭证，不要放进 Git 仓库或交付文件。关闭连接会阻止后续命令；已开始的请求在 Relay 中继续运行，可在断开前主动取消。

![Relay AI连接](images/ai-connection.png)

## 安装 skill

将 `relay-workflow` 整个目录复制到 AI 工具的 skill 目录。例如 Codex 使用 `%USERPROFILE%\.codex\skills\relay-workflow`；支持 `SKILL.md` 的其他工具按其本地 skill 规则安装。通用工具也可以直接读取 `SKILL.md` 并调用 Python 客户端。需要 Python3，无额外依赖。

```powershell
python skills/relay-workflow/scripts/relay_client.py --config C:/private/relay-connection.json list
python skills/relay-workflow/scripts/relay_client.py --config C:/private/relay-connection.json call --file command.json --wait
```

项目附带的是普通 HTTP API 与可移植 skill，当前没有独立 MCP 服务。支持 skill 或命令行调用的 AI 工具均可使用。

## 完整流程

AI 读取工作区，创建集合和请求，配置断言与变量提取，关联交付文档并补写说明。执行验证后，AI 根据实际字段结构填写字段含义和已知必填规则，再打开文档供用户审阅。用户点击 **确认交付** 后，可以在 Relay 导出 Markdown、HTML 或 OpenAPI。

不知道的规则会保留待确认；检查失败的接口保留真实失败结果。接口配置或环境变化后，已有验证会提示过期。更新现有内容需要匹配当前版本；用户未保存的请求草稿、正在执行的请求会拒绝外部覆盖。

HTTP 自动验证与串行计划已开放；SSE/WS 可创建配置并在应用内调试，自动流式会话控制暂未开放。导出可包含草稿，需核对返回的 `review` 状态。自动化接口不提供任意脚本、文件读取、删除工作区或替用户确认交付的能力。

接口与字段格式见 [API 参考](../skills/relay-workflow/references/api.md)。
