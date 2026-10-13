# EngageLab Tag Tool 浏览器扩展

一个不需要 Python、本地服务或安装环境的 Chrome/Edge 扩展。扩展页面通过 Manifest V3 `host_permissions` 直接调用 EngageLab API。

## 功能

- 上传 CSV，格式为每行一个 registration ID；
- 手动输入 registration ID，每输入一个后按 Enter；
- 动态填写数据中心、AppKey、Master Secret 和 Tag；
- 按 EngageLab 限制自动拆分为每批最多 1,000 个 ID，批量设置 Tag；
- 最多并发 10 个请求，验证候选 ID 是否绑定指定 Tag；
- 导出已绑定 registration ID 列表；
- AppKey 与 Master Secret 只保存在当前页面内存，不写入浏览器存储。

## 安装

### Chrome

1. 下载并解压 `EngageLab-Tag-Tool-Extension.zip`。
2. 打开 `chrome://extensions/`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压后的目录。
5. 点击浏览器工具栏中的扩展图标，打开操作页面。

### Edge

1. 下载并解压扩展包。
2. 打开 `edge://extensions/`。
3. 开启“开发人员模式”。
4. 点击“加载解压缩的扩展”，选择解压后的目录。
5. 点击扩展图标使用。

安装目录的根部必须能直接看到 `manifest.json`，不要选择它的上一级目录。

## CSV 格式

```csv
registration_id
registration-id-1
registration-id-2
```

页面内提供同格式的模板下载。空行和重复 ID 会自动忽略，一次最多处理 100,000 个唯一 ID。

## 项目结构

```text
manifest.json                       扩展权限与入口
background.js                       点击扩展图标时打开操作页面
static/index.html                   页面结构
static/styles.css                   页面样式
static/app.js                       CSV、API 请求、查询与导出逻辑
static/registration-id-template.csv CSV 模板
```

## 本地打包

在项目目录运行：

```bash
mkdir -p dist
zip -r dist/EngageLab-Tag-Tool-Extension.zip manifest.json background.js static README.md
```

也可以在 GitHub Actions 中运行 `Build browser extension`，然后下载 `EngageLab-Tag-Tool-Extension` Artifact。该 ZIP 同时适用于 macOS 和 Windows 上的 Chrome/Edge。

## 安全说明

- 扩展只申请六个 EngageLab API 数据中心域名的访问权限。
- 凭据不会保存到 `chrome.storage`、`localStorage` 或文件中。
- 浏览器开发者工具仍可看到当前页面内存和请求头，因此只应在受信任的电脑上使用。
- 不要把真实 AppKey、Master Secret、请求日志或截图提交到仓库。

## API 依据

- 批量绑定 Tag：`POST /v4/tags/{tag_value}`
- 请求体：`{"registration_ids":{"add":["id-1","id-2"]}}`
- 查询绑定：`GET /v4/tags/{tag}/registration_ids/{registration_id}`
- 鉴权：HTTP Basic Auth，用户名为 AppKey，密码为 Master Secret

参考：[EngageLab Tag & Alias API](https://www.engagelab.com/zh_CN/docs/app-push/developer-guide/rest-api/tag-alias-api) 与 [REST API Overview](https://www.engagelab.com/docs/app-push/developer-guide/rest-api/rest-api-overview)。
