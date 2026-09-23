# pi-cpa-provider

让 [Pi](https://pi.dev)（0.87.1+）通过一个或多个 **CLIProxyAPI（CPA）** 实例提供模型。

- **多实例**：每个 CPA 注册为独立 provider `cpa-<id>`。它的模型单独列出，名字后面带实例名，比如 `cpa-home/gpt-5.5` 和 `cpa-backup/gpt-5.5` 是两个选项。插件不合并同名模型，也不在实例之间自动切换。
- **动态模型**：每个实例从自己的 `/v1/models` 获取模型目录，分别缓存和刷新。一个实例出错不会影响另一个。
- **Codex Responses 传输**：请求发到 `/backend-api/codex/responses`，默认用 WebSocket 复用连接，失败时回退到 SSE。
- **按模型 Fast**：按「实例 + 模型」分别开关。只有目录明确列出 `priority` 档位的模型才能开启，开启后请求会注入 `service_tier: "priority"`。
- **密钥只存一份**：key 只写在 Pi 的 `auth.json`，或者从环境变量读取。插件配置和缓存里没有 key。

## 安装

需要 Pi 0.87.1+ 和可用的 CPA 实例。通过 npm 安装 Pi 扩展：

```bash
pi install npm:pi-cpa-provider
```

安装后启动 Pi，运行 `/cpa-add` 添加实例并设置 URL、API key。也可以参照下文手写配置。

## 命令

| 命令 | 作用 |
|---|---|
| `/cpa-add [id]` | 交互添加实例：ID、显示名、URL、key 来源（auth.json 或环境变量），校验通过后才保存 |
| `/cpa-edit [id]` | 修改显示名、URL 或 key；改 URL/key 时会先校验 |
| `/cpa-remove [id]` | 删除实例，同时清除它在 auth.json 里的 key 和模型缓存 |
| `/cpa-refresh [id]` | 刷新某个实例的模型目录；省略 id 时刷新全部 |
| `/cpa-list` | 查看各实例的 URL、key 来源、模型数、Fast 模型和最近错误 |
| `/cpa-fast [on\|off\|status]` | 查看或设置**当前模型**的 Fast；不带参数时弹出选择 |

当前模型的 Fast 生效时，状态栏显示 `fast`。

## 文件

```text
<agentDir>/extensions/pi-cpa-provider/
  config.json        # 实例 ID、名称、URL、apiKeyEnv、fastModels
  cache/<id>.json    # 每个实例的模型目录快照（不含 key）
<agentDir>/auth.json # Pi 自己的凭证文件；每个实例一条 cpa-<id> 的 api_key
```

`<agentDir>` 默认为 `~/.pi/agent`，受 `PI_CODING_AGENT_DIR` 影响。

### 手写配置（非交互）

参考 [config.example.json](./config.example.json)：

```json
{
  "instances": [
    { "id": "home", "name": "家用 CPA", "baseUrl": "http://127.0.0.1:8317", "fastModels": { "gpt-5.5": true } },
    { "id": "backup", "name": "备用 CPA", "baseUrl": "https://cpa.example.com", "apiKeyEnv": "CPA_BACKUP_API_KEY", "fastModels": {} }
  ]
}
```

- `id`：1–32 位小写字母、数字、`-`、`_`。它决定 provider ID `cpa-<id>` 和 auth.json 条目名，建好后别改。
- `baseUrl`：推荐只写 `host:port`。`/v1`、`/backend-api` 后缀和路径前缀都能识别；不能带 query、fragment 或账号密码。
- key 的来源按优先级：
  1. auth.json 里的 `cpa-<id>` 条目（`/cpa-add`、`/cpa-edit` 会写这里，`/login cpa-<id>` 也写同一处）；
  2. `apiKeyEnv` 指定的环境变量。
- 配置里出现 `apiKey` 字段会被拒绝，这样 key 不会落进插件配置。
- 某个实例写错时，只跳过这个实例并在启动时提示；其他实例照常工作。

## 行为细节

- **启动**：有缓存的实例立即用缓存注册，进入会话后再在后台刷新（缓存不到 5 分钟的跳过）。没有缓存的实例最多等待 15 秒获取目录。`--offline` / `PI_OFFLINE` 下不访问网络。
- **刷新失败**：保留上一次成功的目录。上游成功返回后以新目录为准，已消失的模型不再保留。
- **压缩**：会话压缩后，该会话在某个实例上的 WebSocket 会在下次请求前关闭重连，其他会话和其他实例不受影响。
- **瞬态错误**：`closed network connection`、`stream disconnected before completion`、`Invalid Codex SSE JSON` 这类错误，只有在尚未输出任何内容时才会标为可重试，由 Pi 自动重试；已有部分输出时不重试，避免重复计费。

## 实现说明与限制

- 传输直接复用 Pi AI 公开的 `openAICodexResponsesApi()`，不修改任何上游源码。原版实现要求 key 是带 `chatgpt_account_id` 的 JWT，所以插件给它一个不含秘密的占位 token（每个实例的 account id 不同），真实 key 放在 `X-Api-Key` 头里。**这要求 CPA 接受 `X-Api-Key` 鉴权**（CPA 的 API key 鉴权本身支持）。
- WebSocket 空闲回收时间、重试次数都用 Pi AI 的默认值（空闲 5 分钟）。
- Pi 的扩展 UI 没有掩码输入，`/cpa-add`、`/cpa-edit` 输入 key 时屏幕上会显示明文。不想这样的话，可以改用环境变量，或者用 `/login cpa-<id>`（掩码输入，写入同一个 auth.json 条目）。
- 只支持 `/backend-api/codex/responses`，不支持 `/v1/chat/completions` 或 `/v1/responses`。

## 开发

```bash
pnpm install
pnpm check   # tsc + node --test
```
