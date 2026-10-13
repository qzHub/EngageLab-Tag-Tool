# EngageLab 批量设备 Tag 工具

一个本地 Web 工具。它支持从 CSV 读取或逐条手动输入 registration ID，并提供两种操作：

- 批量为候选设备添加同一个 Tag；
- 逐个验证候选 registration ID 是否已经绑定指定 Tag，并导出已绑定列表。

实现刻意保持简单：`static/index.html` 包含全部页面、样式和交互代码，`server.py` 使用 Python 标准库提供本机页面和 EngageLab API 代理。不能只保留 HTML 直接调用 EngageLab，因为官方 API 没有提供浏览器跨域响应头。

## 最终用户使用（无需安装环境）

发布包使用 PyInstaller 将 Python 解释器和静态资源一同打包。最终用户不需要安装 Python、pip、Node.js 或其他依赖。

- macOS：解压后双击 `EngageLab Tag 工具.app`。未配置 Apple Developer ID 时，首次启动请按住 Control 点击应用并选择“打开”；正式分发建议配置签名和公证。
- Windows：解压后双击 `EngageLab-Tag-Tool.exe`。

程序会自动选择一个空闲的本地端口并打开默认浏览器。关闭页面约 5 秒后，本地服务自动结束；如果浏览器未能打开，程序会在 60 秒后自动结束。

## 构建发布包

PyInstaller 不能跨系统构建：macOS 版本需要在 macOS 上构建，Windows 版本需要在 Windows 上构建。

### macOS

构建电脑需要 Python 3.10 或更高版本，运行：

```bash
./scripts/build-macos.sh
```

输出：`dist/EngageLab Tag 工具.app`

### Windows

构建电脑需要 Python 3.10 或更高版本，在 PowerShell 中运行：

```powershell
.\scripts\build-windows.ps1
```

输出：`dist\EngageLab-Tag-Tool.exe`

`.github/workflows/build-standalone.yml` 也提供了 macOS 和 Windows 双平台自动构建。发布时建议配置 Apple Developer ID 签名与公证，以及 Windows Authenticode 代码签名，避免操作系统对未签名程序显示安全警告。

自动构建完成后，从工作流运行记录的 Artifacts 区域下载：

- `EngageLab-Tag-Tool-macOS`
- `EngageLab-Tag-Tool-Windows`

构建工具只在构建电脑或自动构建环境中需要；拿到 `.app` 或 `.exe` 的最终用户不需要安装 Python。

## 源码运行

需要 Python 3.10 或更高版本。

```bash
cd /Users/rain/Desktop/Demo/engagelab-tag-tool
python3 server.py
```

然后访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)。停止服务请按 `Ctrl+C`。

如需使用其他端口：

```bash
python3 server.py --port 9000
```

## CSV 格式

每行一个 registration ID，可选使用 `registration_id` 作为首行表头：

```csv
registration_id
registration-id-1
registration-id-2
```

空行与重复 ID 会自动忽略。一次最多处理 100,000 个唯一 ID；后端会按 EngageLab 接口限制自动拆成每批 1,000 个。

页面提供标准模板下载。上传 CSV 后，ID 会进入同一个文本框；也可以直接手动输入，每输入一个 registration ID 后按一次 `Enter` 回车。空行和重复 ID 会自动忽略。

## 查询 Tag 绑定

EngageLab 没有提供枚举某个 Tag 下全部 registration ID 的公开 API。因此本工具采用候选验证模式：用户先上传或输入候选 registration ID，工具调用 `GET /v4/tags/{tag}/registration_ids/{registration_id}` 逐个验证。

查询结果分为已绑定、未绑定和查询失败三类。已绑定列表可以下载为 CSV。为避免无控制地冲击 EngageLab API，工具最多同时发起 10 个验证请求。结果仅覆盖用户本次提供的候选 ID，无法发现候选清单之外的设备。

## 安全说明

- AppKey 与 Master Secret 只保存在当前页面内存，并随请求发送给本机服务；工具不会把它们写入文件或浏览器存储。
- 服务默认只监听 `127.0.0.1`。除非已经配置网络访问控制，否则不要使用 `--host 0.0.0.0` 暴露到局域网或公网。
- 后端只允许访问 EngageLab 官方文档列出的六个 HTTPS API 域名，防止自定义地址被用于访问其他服务。
- 不要提交包含 AppKey 或 Master Secret 的截图、日志或源码。

## 验证

运行单元测试：

```bash
cd /Users/rain/Desktop/Demo/engagelab-tag-tool
python3 -m unittest -v
```

测试覆盖输入去重与校验、Basic Auth、Tag URL 编码、1000 条自动分批，以及单批失败后继续处理。

## API 依据

- 批量绑定 Tag：`POST /v4/tags/{tag_value}`
- 请求体：`{"registration_ids":{"add":["id-1","id-2"]}}`
- 鉴权：HTTP Basic Auth，用户名为 AppKey，密码为 Master Secret
- 单次 `add` 最多 1,000 个 registration ID

参考：[EngageLab Tag & Alias API](https://www.engagelab.com/zh_CN/docs/app-push/developer-guide/rest-api/tag-alias-api) 与 [REST API Overview](https://www.engagelab.com/docs/app-push/developer-guide/rest-api/rest-api-overview)。
