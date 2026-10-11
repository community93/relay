# 发布到 GitHub

仓库：**`community93/relay`**（public，默认分支 `main`）。安装包作为 Release 附件提供，不进源码树。

## 发布前

1. 版本号已在 `src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 统一（界面、程序、安装包三处一致）。
2. 重新构建，使产物与将要提交的源码一致：

```powershell
.\build.ps1 --portable   # dist\Relay.exe
.\build.ps1              # dist\Relay_<版本>_x64-setup.exe
```

3. 跑验证，确认全绿（先确保 `tests/local_server.py` 与 `tests/delivery_server.py` 在听，
   否则会出现一片"无法建立连接"的假失败）：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --bin relay
python tests/run_all.py
python tests/palette_check.py ; python tests/debt_audit.py
python tests/contrast_audit.py 9223 ; python tests/contrast_audit.py 9223 dark
```

4. **把安装包的体积和 SHA-256 写进本版 `docs/releases/vX.Y.Z.md`**。README 与 Release 正文都引用
   同一个哈希，重新构建后不改这里，公开的就是对不上文件的校验值：

```powershell
Get-FileHash -LiteralPath dist/Relay_<版本>_x64-setup.exe -Algorithm SHA256
```

5. 检查将要提交的内容：

```bash
git status --short --untracked-files=all
git grep --cached -nE "https?://[a-z0-9.-]+\.(top|cn|com|net|io)"   # 找真实第三方地址
```

`.gitignore` 已排除 `dist/`、`*.exe`、数据目录、`reports/`（本地跑测产物）、`.design-qa/`
和 `tools/editor/node_modules/`。**截图和数据目录绝不入库**：`dist/data` 里可能有真实接口地址，
README 用图要用 `RELAY_DATA` 指向一个干净空目录重新拍。

## 提交与推送

```bash
git add -A && git commit && git push origin main
```

先 `git fetch` 并基于 `origin/main` 提交，推送就是 fast-forward，不需要强推。
这台机器到 GitHub 的连接会偶发 `Connection was reset`；`git push` 返回 0 即为成功，
不要因为随后一次 `git ls-remote` 失败就以为没推上去。

## 建 Release

标签 `vX.Y.Z` 指向刚推送的提交，标题 `Relay vX.Y.Z`，正文用本版 `docs/releases/vX.Y.Z.md` 全文，
附件上传 `dist/Relay_<版本>_x64-setup.exe`。

网页操作即可。若用 REST API，这台机器上有三条实测约束：

- **没有 `gh` CLI**，只能走 REST。
- **Python `urllib` 到 `api.github.com` 会被 TLS 掐断**（`UNEXPECTED_EOF_WHILE_READING`），
  而同一网络下 **`curl` 正常**——用 curl 并加重试。
- 凭证不用另存：`git credential fill`（喂 `protocol=https` / `host=github.com`）就能取到
  Git Credential Manager 里的 token。写进临时 curl 配置文件的 header，不要放命令行，也不要打印。

两个 API 静默坑：

- `PATCH /repos/{owner}/{repo}` 带 `topics` 会**返回 200 但把 topics 丢掉**。必须单独
  `PUT /repos/{owner}/{repo}/topics`，body 为 `{"names": [...]}`。
- 标签和 Release **可能已经被建过**（附件却是空的）。先 `GET /releases` 确认，
  已存在就直接往那个 `release_id` 补附件：
  `POST https://uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name=<文件名>`，
  带 `-T <文件>` 和 `Content-Type: application/x-msdownload`。

## 发布后

逐个确认公开结果，被排除的路径应当是 404：

```bash
for p in README.md LICENSE docs/releases/vX.Y.Z.md; do
  curl -s -o /dev/null -w "%{http_code}  $p\n" \
    "https://raw.githubusercontent.com/community93/relay/main/$p"
done
curl -s "https://api.github.com/repos/community93/relay/releases/latest"   # 看 assets 是否挂上
```
