# 开发与测试

## 环境

当前构建目标为 Windows x64。

- Rust stable，使用 `x86_64-pc-windows-msvc` 工具链。清单最低版本为 Rust 1.80，建议使用最新 stable。
- Visual Studio 2022 Build Tools：安装“使用 C++ 的桌面开发”，包含 MSVC 和 Windows SDK。
- Microsoft Edge WebView2 Runtime。
- 构建 NSIS 安装包时需要 Tauri CLI 2：

```powershell
cargo install tauri-cli --version "^2" --locked
```

前端直接使用 `web/` 中的 HTML、CSS 和 ES Modules，代码编辑器依赖已打包并随源码提交，常规构建无需 npm 或网络。更新编辑器依赖时，按 [编辑器构建说明](../tools/editor/README.md) 使用锁文件重新生成本地 bundle。

## 构建

在仓库根目录运行：

```powershell
.\build.ps1
.\build.ps1 --portable
.\build.ps1 --debug
```

| 命令 | 产物 |
| --- | --- |
| `build.ps1` | `dist/Relay_0.1.15_x64-setup.exe`，版本号来自 Tauri 配置 |
| `build.ps1 --portable` | `dist/Relay.exe`，release 免安装程序 |
| `build.ps1 --debug` | `dist/Relay.exe`，debug 免安装程序 |

debug 程序默认优先使用仓库根目录的 `data/`，release 程序优先使用可执行文件旁的 `data/`。开发或测试时可通过 `RELAY_DATA` 指定独立数据目录。

## 目录

```text
web/          前端页面、样式与交互模块
src-tauri/    Rust 后端、Tauri 配置与图标
tests/        本地接口夹具、原生端到端与界面回归
docs/         项目文档、演示截图与版本说明
skills/       可移植AI工作流skill与客户端
tools/editor/ 代码编辑器 bundle 的构建输入（node_modules 不入库）
build.ps1     Windows 构建入口
```

`dist/`、`src-tauri/target/`、`.design-qa/`、`reports/`（本地跑测产物）和数据目录由 `.gitignore` 排除。

## 回归测试

测试驱动真实 WebView2 窗口，通过 CDP 操作界面，并在 `.design-qa/` 下创建隔离数据与日志。

### 依赖与当前限制

Python 套件需要 Python 3、`websocket-client`，WebSocket 夹具需要 `websockets`：

```powershell
python -m pip install websocket-client websockets
```

JavaScript 界面套件需要 Node.js、Playwright 与 Microsoft Edge。Playwright 与 Python 解释器都不写死路径，按下面两处解析：

| 环境变量 | 作用 | 不设时 |
| --- | --- | --- |
| `RELAY_PLAYWRIGHT` | 指向一个已存在的 playwright 包目录（或其入口文件） | 先 `require.resolve('playwright')`，再试 node 可执行文件同级的 `node_modules/playwright` |
| `RELAY_PYTHON` | 安装器烟雾测试与 AI 客户端套件使用的解释器 | 用 `PATH` 上的 `python` |

两者都找不到时会**直接报错并说明怎么设**，不会静默跳过——套件"通过"却根本没启动浏览器，比报错更糟。构建程序本身不依赖这些测试路径。

### 本地夹具

先构建免安装程序，再分别在两个终端运行：

```powershell
python tests/local_server.py       # HTTP 8899、WebSocket 8900
python tests/delivery_server.py    # 文档接口 18999
```

### 执行检查

在另一个终端运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin relay
node tests/checks_unit.cjs
python tests/run_all.py
python tests/run_native.py
python tests/palette_check.py
python tests/run_visual_matrix.py
.\tests\installer_smoke.ps1
```

`run_all.py` 默认运行 11 个请求与运行计划套件。`run_native.py` 默认运行 22 个界面与持久化套件，包含 Body 编辑、协议导入、交互、逐条执行详情、视觉回归与动效覆盖检查；可在命令后填写套件名进行定向检查。协议导入套件会启动并关闭独立的 WS / WSS 夹具（19001 / 19002）；自签测试证书通过 PowerShell 7 生成到 `.design-qa/ws-certificate`，不会导入系统证书库。

`run_visual_matrix.py` 启动独立的原生窗口与隔离数据，截图所有已注册配色的明暗模式，检查基础文字对比度、窗口边界及字号适配。默认使用 `src-tauri/target/release/relay.exe`，可通过 `RELAY_TEST_EXE` 指定构建；默认调试端口为 9227。截图保存到 `reports/visual-review-<版本>/`，截图中的响应和文档为演示数据。

安装器烟雾测试需要先运行 `build.ps1` 生成 NSIS 安装包，测试包括安装、启动、真实请求、保存重载、卸载及数据保留。

默认测试程序为 `dist/Relay.exe`。可指定其他构建，例如：

```powershell
$env:RELAY_TEST_EXE = (Resolve-Path 'src-tauri/target/release/relay.exe').Path
python tests/run_all.py controls
```

`RELAY_CDP_PORT` 可覆盖测试调试端口。日志位于 `.design-qa/suite-logs/`。

0.1.6 的自动化验证没有覆盖屏幕阅读器人工操作、多显示器物理可读性测量或多小时稳定性测试。

## AI连接开发

Rust的`automation.rs`仅提供本机认证与事件传输。`web/js/automation.js`通过现有状态、持久化、检查和文档模块处理命令，避免另建一套工作区存储。连接默认关闭，凭证仅在本次应用会话内有效。

`python tests/run_native.py automation automation_restart`验证真实外部HTTP调用、客户端和重启持久化。`RELAY_QA_SOURCE=1`仅供开发时覆盖自动化模块调试；发布验收应取消该变量，使用包内代码。

用户步骤见[AI工作流](ai-workflow.md)，命令格式见[API参考](../skills/relay-workflow/references/api.md)。
