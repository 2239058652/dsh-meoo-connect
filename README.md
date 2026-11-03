# dsh-meoo-connect

> **派生声明**：本项目是 [sangonomiya249/dsh-meoo](https://github.com/sangonomiya249/dsh-meoo) 的衍生版本（MIT，原始版权归 `sangonomiya249` 所有），上游基线 `cf77e92`，独立维护、不跟随上游合并。相对上游：修掉了 DSH 0.2.1-rc.5 下写模型路由的三处缺陷（`settings.get` 不存在、竞态正则匹配不上、兜底写已废弃的 `settings.yaml`），换成本仓库自己的包名与归属。

把 [秒悟 Meoo](https://meoo.com) 的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）。

装上之后：**会话输入框的模型选择器里直接多出「Meoo 秒悟」一组**，随时切换；
**设置 → 模型** 里也有 `Meoo 秒悟` 一行，可以像原生 provider 一样改 API Key、baseURL、增删模型。

```
Qwen3.8-Flash · Qwen3.8-Max · Qwen3.7-Max · Qwen3.7-Plus
DeepSeek V4.1 Flash · DeepSeek V4 Pro · DeepSeek V4 Flash
GLM-5.2 · GLM-5.2-Fast
```

## 它是怎么做的

不自己写 LLM 适配器，也不起本地代理进程——**复用 dsh 自带的 `llm-pi-ai` 提供方平面**，
插件只负责把「凭证 + 路由 + 模型目录」准备好：

```
dsh-meoo-connect (Host)
  ├─ OAuth(PKCE) 登录 meoo            → access/refresh token 存 $DSH_HOME/meoo/state.json
  ├─ /open/v1/cli-compat/...           → 项目列表、项目服务 AK（meoo_project_service_v1.*）
  ├─ GET api.meoo.host/.../models      → 当前可用模型目录
  ├─ credentials.set('MEOO_API_KEY')   → 密钥进 dsh 凭据库（不写进配置）
  └─ settings.update('llm-pi-ai')      → 写入 profile patch 的 providers.meoo 路由
                                            ↓
                                llm-pi-ai 负责真正的转发（流式、工具调用）
                                            ↓
                    模型选择器「Meoo 秒悟」  +  设置 → 模型 里的 Meoo 卡片
```

好处是：模型选择、思考强度、会话持久化、用量统计全都走 dsh 原生链路，
插件本身不碰消息协议，也不在中间加一层会掉流式的代理。

## API Key 是怎么来的

**全自动，只有一步需要人**：浏览器里点一次「授权」。

| 环节 | 谁来做 | 需要人工吗 |
| --- | --- | --- |
| OAuth(PKCE) 授权拿 token | `/meoo login` 自动起本机回调 | 点一次「授权」 |
| 1 小时后续期 | refresh token 自动轮换（每次刷新原子保存） | 不需要 |
| 选项目 | 用账号的 `project_url_id`，或用 `/meoo project <urlId>` 指定 | 不需要 |
| **取项目服务 AK** | `GET /open/v1/cli-compat/projects/{id}/cloud/environment` 里的 `meooProjectApiKey` | 不需要 |
| 项目没开通云服务 | 插件自动 `POST .../cloud` 开通一次再取 | 不需要 |
| 拉模型目录 | `GET api.meoo.host/meoo-ai/compatible-mode/v1/models` | 不需要 |
| 存密钥 | `credentials.set('MEOO_API_KEY', ak)` | 不需要 |

也就是说：装好 → `/meoo login` → 点授权 → 剩下的（AK、模型清单、路由）全自动。
如果之前用过 `meoo-proxy` CLI 登录，会直接复用
`~/.meoo-proxy/config.json` 里的登录态与 AK，**连那一次点击都省了**。

想完全不走浏览器也可以：`/meoo key meoo_project_service_v1.xxx` 手填 AK，
或直接在 **设置 → 模型 → Meoo 秒悟** 的 API Key 输入框粘贴。

## 安装

dsh 的插件装在 **profile** 里。本机 Web GUI 用的是 `web` profile（Electron 应用的 `desktop` profile 由应用自己管理，`dsh plugin` 不接受它）。

```bash
# 方式一：直接装 GitHub 上的包（推荐）
dsh plugin --profile web add github:2239058652/dsh-meoo-connect

# 方式二：本地目录（改代码时用）
git clone https://github.com/2239058652/dsh-meoo-connect
dsh plugin --profile web add file:/绝对路径/dsh-meoo-connect
```

然后把包名加进 profile 的 bundle 列表（`$DSH_HOME/profiles/web/package.json`）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-meoo-connect"
      ]
    }
  }
}
```

**重启 dsh**（bundle 挂载要重组插件树，热加载不会加载新 bundle）。

> 如果 pnpm 报 `ERR_PNPM_UNEXPECTED_STORE`（profile 与 dsh 内置 pnpm 的 store 版本不一致），
> 直接把仓库 junction/软链到 `$DSH_HOME/profiles/web/node_modules/dsh-meoo-connect` 即可，
> 效果相同，也不影响已装的其它插件。

## 使用

1. 重启后在输入框的模型选择器里选 **Meoo 秒悟** 下的任意模型，直接开聊。
2. 会话里输入 `/meoo` 管理登录与同步：

| 命令 | 作用 |
| --- | --- |
| `/meoo` | 状态：账号、项目、AK、模型、上次同步 |
| `/meoo login` | 浏览器 OAuth 授权（PKCE，scope `cli.compat`），完成后自动同步 |
| `/meoo sync` | 重新解析 AK + 拉模型目录并写入路由 |
| `/meoo models` | 列当前模型 |
| `/meoo project <urlId>` | 换项目（AK 会重新解析） |
| `/meoo key <meoo_project_service_v1...>` | 手填项目服务 AK |
| `/meoo logout` | 清本地登录态 |

## 配置

```yaml
# 你的 profile 的 cordis.patch.yml
- id: meoo
  name: dsh-meoo-connect
  config:
    route: meoo                                                      # 提供方 id
    gatewayBaseUrl: https://api.meoo.host/meoo-ai/compatible-mode/v1
    overwrite: false                                                 # true 才覆盖用户改过的路由
```

## 前提

- 有一个可用的 Meoo 账号与项目，且该项目**开通过云服务**（AI 服务 AK 依赖它）。
  插件会尝试自动开通一次；仍失败就去 meoo.com → 该项目 →「云服务」点开通，再 `/meoo sync`。
- Node ≥ 20（dsh 自带运行时即可）。

## 排错

| 现象 | 处理 |
| --- | --- |
| 模型选择器里没有 Meoo | 重启 dsh；`/meoo status` 看 `lastError` |
| `写入 llm-pi-ai 路由失败: settings 命名空间 llm-pi-ai 还没注册` | `llm-pi-ai` 没在这个 profile 里启用（或启动竞态没等到）。先在 profile 的 bundle 列表里保留 `@deepseek-ai/dsh-base`，重启后 `/meoo sync` |
| `No configurable plugin entry "llm-pi-ai"` | profile patch 里的 `llm-pi-ai` 行被删掉了；把它加回去（`id: llm-pi-ai`，`name: '@deepseek-ai/dsh-llm-pi-ai'`） |
| `项目 xxx 还没开通 Meoo AI 服务` | 去 meoo.com 该项目「云服务」开通，再 `/meoo sync` |
| `401 / invalid_token` | refresh token 失效，`/meoo login` 重登 |
| `SERVICE_AK_FORMAT_INVALID` | 把 `meoo_ak_` 用户 Key 当成了项目服务 AK；用 `/meoo key` 填 `meoo_project_service_v1.*` |

## 状态与文件

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/meoo/state.json` | 登录态、项目、AK、模型缓存（权限 600） |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | `llm-pi-ai.providers.meoo` 路由（由 `settings.update` 写入，`overwrite: false` 时只补空缺字段） |
| `$DSH_HOME/.credentials.yaml` | `MEOO_API_KEY`（密钥只在这里） |

## 开发

```bash
node test/offline.test.mjs        # 15 项：假 ctx + 假 fetch，覆盖同步、/meoo 命令与命名空间缺失
node --check index.js
```

真网关的端到端验证用 overlay 跑 headless profile：

```bash
# 直接把路由配给 llm-pi-ai（不经过插件写入）
dsh --profile headless --patch test/headless-piai.yml "只回复一句话：你是哪个模型？"

# 只改默认模型，路由来自 profile patch（等价于插件写入后的状态）
dsh --profile headless --patch test/headless-settings-only.yml "只回复一句话：你是哪个模型？"
```

## 说明

- 用的是 Meoo 官方「AI 服务」网关，鉴权就是账号的项目服务 AK；调用消耗该账号额度，
  插件不绕过任何计费。
- 与 Meoo 官方无关联，是第三方集成。
- 凭证只留在本机，仓库里不含任何 token。

## License

MIT
