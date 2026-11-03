/**
 * dsh-meoo —— 把秒悟 Meoo 的模型接进 dsh。
 *
 * 设计：不自己写 LLM 适配器，而是复用 dsh 自带的 `llm-pi-ai` 提供方平面。
 * 插件在 apply 时把一条 `providers.meoo` 路由写进 `llm-pi-ai` 的 settings
 * 命名空间（baseURL / 协议 / 模型目录 / 凭据引用），于是：
 *   - 会话里的模型选择器直接出现「Meoo 秒悟」分组，可随手切换；
 *   - 设置 → 模型 里出现 Meoo 行，原生的编辑卡片能改 API Key、baseURL、模型清单；
 *   - 真正的转发由 pi-ai 完成（OpenAI Chat Completions，流式与工具调用齐全）。
 *
 * 插件负责的是「把凭证和目录准备好」：OAuth(PKCE) 登录 → 项目 → 项目服务 AK
 * → 网关模型目录 → 写凭据 + 写路由。全程可用 `/meoo` 命令手动触发。
 *
 * 状态落在 $DSH_HOME/meoo/state.json；如果之前用过 meoo-proxy CLI（
 * ~/.meoo-proxy/config.json），会直接复用那份登录态与 AK。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'meoo'

/** 需要 settings 才能写路由；其余服务（credentials / commands / llm）都是可选的。 */
export const inject = ['settings']

const DEFAULT_API_BASE = 'https://meoo.com'
const DEFAULT_GATEWAY = 'https://api.meoo.host/meoo-ai/compatible-mode/v1'
const DEFAULT_ROUTE = 'meoo'
const DEFAULT_PROVIDER_NAME = 'Meoo 秒悟'
const DEFAULT_API_KEY_ENV = 'MEOO_API_KEY'
const PI_AI_NS = 'llm-pi-ai'

const PROD_CLIENT_ID = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh'
const TEST_CLIENT_ID = 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE'
const OAUTH_SCOPE = 'cli.compat'
const CALLBACK_PATH = '/oauth/callback'

/** 网关目录拿不到时的兜底清单（id → 展示名/容量，取自 meoo 文档与控制台）。 */
const FALLBACK_MODELS = [
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus' },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
  { id: 'glm-5.2-fast-preview', name: 'GLM-5.2-Fast' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
]

const CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const home = () => os.homedir()

function dshHome() {
  return process.env.DSH_HOME || path.join(home(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'meoo', 'state.json')
}

function proxyConfigFile() {
  return path.join(home(), '.meoo-proxy', 'config.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function clientIdFor(apiBaseUrl) {
  try {
    return new URL(apiBaseUrl).hostname.toLowerCase() === 'meoo.com' ? PROD_CLIENT_ID : TEST_CLIENT_ID
  } catch {
    return TEST_CLIENT_ID
  }
}

function openBrowser(url) {
  try {
    // Windows 上不能走 `cmd /c start`：cmd 会把 URL 里的 `&` 当成命令分隔符，
    // 浏览器只拿到 `?client_id=...` 这一段（缺 response_type），授权页报
    // unsupported_response_type。explorer.exe 直接收参数，不经 shell 解析。
    const child =
      process.platform === 'win32'
        ? spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* URL 会打印到命令结果里 */
  }
}

function fmtTs(ms) {
  if (!ms) return '-'
  try {
    return new Date(ms).toLocaleString('zh-CN')
  } catch {
    return String(ms)
  }
}

function maskSecret(value) {
  if (!value) return '（空）'
  return value.length <= 12 ? `${value.slice(0, 4)}***` : `${value.slice(0, 10)}…${value.slice(-4)}`
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const EMPTY_STATE = {
  apiBaseUrl: DEFAULT_API_BASE,
  accessToken: null,
  refreshToken: null,
  accessExpiresAt: 0,
  scope: null,
  openid: null,
  username: null,
  userId: null,
  projectUrlId: null,
  serviceAk: null,
  serviceAkProjectId: null,
  models: [],
  lastSyncAt: 0,
  lastError: null,
}

function loadState() {
  const saved = readJson(stateFile()) || {}
  const state = { ...EMPTY_STATE, ...saved }

  // 复用 meoo-proxy CLI 的登录态（同一套 OAuth 凭证，直接接着用）
  const legacy = readJson(proxyConfigFile())
  if (legacy) {
    if (!state.refreshToken && legacy.refreshToken) {
      state.refreshToken = legacy.refreshToken
      state.accessToken = legacy.accessToken || null
      state.accessExpiresAt = Number(legacy.accessExpiresAt) || 0
      state.openid = legacy.openid || null
      state.apiBaseUrl = legacy.apiBaseUrl || state.apiBaseUrl
    }
    if (!state.username && legacy.username) state.username = legacy.username
    if (!state.userId && legacy.userId) state.userId = legacy.userId
    if (!state.projectUrlId && legacy.projectUrlId) state.projectUrlId = legacy.projectUrlId
    if (legacy.serviceAk && legacy.serviceAkProjectId && legacy.serviceAkProjectId === state.projectUrlId) {
      state.serviceAk = state.serviceAk || legacy.serviceAk
      state.serviceAkProjectId = legacy.serviceAkProjectId
    }
  }
  return state
}

function saveState(state) {
  writeJson(stateFile(), state)
  return state
}

// ---------------------------------------------------------------------------
// OAuth（Authorization Code + PKCE，public client，走本机 loopback）
// ---------------------------------------------------------------------------

async function tokenRequest(apiBaseUrl, params) {
  const res = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(`OAuth 换票失败 HTTP ${res.status}: ${json.error || text.slice(0, 160)}`)
  }
  return json
}

async function refreshAccessToken(state) {
  if (!state.refreshToken) throw new Error('没有 refresh token，请先 /meoo login')
  const token = await tokenRequest(state.apiBaseUrl, {
    grant_type: 'refresh_token',
    client_id: clientIdFor(state.apiBaseUrl),
    refresh_token: state.refreshToken,
  })
  state.accessToken = token.access_token
  state.refreshToken = token.refresh_token || state.refreshToken
  state.accessExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000
  state.scope = token.scope || state.scope
  state.openid = token.openid || state.openid
  saveState(state)
  return state.accessToken
}

async function ensureAccessToken(state) {
  if (state.accessToken && state.accessExpiresAt - 60_000 > Date.now()) return state.accessToken
  return refreshAccessToken(state)
}

/** 启动一次浏览器授权。返回 { url, done } —— done 在拿到 token 后 resolve。 */
export function startLogin(state) {
  const clientId = clientIdFor(state.apiBaseUrl)
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const oauthState = crypto.randomBytes(32).toString('base64url')

  let settle
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('Not Found')
      return
    }
    if (url.searchParams.get('state') !== oauthState) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state 校验失败')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('授权被取消')
      settle.reject(new Error(`${error}: ${url.searchParams.get('error_description') || ''}`))
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('缺少 code')
      return
    }
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<meta charset="utf-8"><body style="font:14px sans-serif;padding:40px">授权成功，可以关闭这个页面回到 dsh。</body>')

    tokenRequest(state.apiBaseUrl, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
      .then((token) => {
        state.accessToken = token.access_token
        state.refreshToken = token.refresh_token
        state.accessExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000
        state.scope = token.scope
        state.openid = token.openid
        saveState(state)
        settle.resolve(token)
      })
      .catch((err) => settle.reject(err))
      .finally(() => setTimeout(() => server.close(), 200).unref?.())
  })

  let redirectUri = ''
  const ready = new Promise((resolve, reject) => {
    server.on('error', (err) => {
      settle.reject(err)
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const authorize = new URL('/oauth/authorize', state.apiBaseUrl)
      authorize.searchParams.set('client_id', clientId)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('scope', OAUTH_SCOPE)
      authorize.searchParams.set('state', oauthState)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      resolve(authorize.toString())
    })
  })

  const timeout = setTimeout(() => settle.reject(new Error('浏览器授权等待超时（5 分钟）')), 5 * 60 * 1000)
  timeout.unref?.()
  // listen 失败（端口被占、权限不足）时立刻收拾，不再白等 5 分钟
  ready.catch(() => {
    clearTimeout(timeout)
    server.close()
  })
  // 无论成功、失败还是超时都要关掉回调端口，否则每试一次登录就残留一个监听。
  done.finally(() => {
    clearTimeout(timeout)
    server.close()
  }).catch(() => {})

  return { ready, done, close: () => server.close() }
}

// ---------------------------------------------------------------------------
// 控制面：账号 / 项目 / 项目服务 AK / 网关目录
// ---------------------------------------------------------------------------

async function controlRequest(state, method, apiPath, body, retried = false) {
  const token = await ensureAccessToken(state)
  const res = await fetch(`${state.apiBaseUrl}${apiPath}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-meoo-client': 'cli',
      'x-meoo-cli-version': '0.5.6',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  // 刷新后仍 401 就不再重试，否则会无限打接口
  if (res.status === 401 && state.refreshToken && !retried) {
    await refreshAccessToken(state)
    return controlRequest(state, method, apiPath, body, true)
  }
  if (res.status === 401) {
    throw new Error(`${apiPath} 失败 HTTP 401（刷新后仍 401，请重新 /meoo login）: ${json?.detail || json?.message || text.slice(0, 160)}`)
  }
  if (!res.ok) {
    throw new Error(`${apiPath} 失败 HTTP ${res.status}: ${json?.detail || json?.message || text.slice(0, 160)}`)
  }
  return json?.data !== undefined ? json.data : json
}

async function fetchIdentity(state) {
  const me = await controlRequest(state, 'GET', '/open/v1/cli-compat/account/identity')
  state.username = me?.name || state.username
  state.userId = me?.user_id || state.userId
  // 已有项目（比如 /meoo project 显式指定）时不要用服务端默认值覆盖
  if (!state.projectUrlId) state.projectUrlId = me?.project_url_id || state.projectUrlId
  saveState(state)
  return me
}

async function listProjects(state, limit = 50) {
  const data = await controlRequest(state, 'GET', `/open/v1/cli-compat/projects?page_size=${limit}`)
  return data?.list || data?.items || data?.projects || (Array.isArray(data) ? data : [])
}

/**
 * 选中一个项目。`identity` 的 `project_url_id` 常常是 null（账号没设默认项目），
 * 这时按项目列表自己挑：只有一个就用它，多个则报错并列出可选 urlId。
 * @returns 项目的 url_id。
 */
async function pickProject(state, explicitUrlId) {
  if (explicitUrlId) return explicitUrlId
  if (state.projectUrlId) return state.projectUrlId
  const projects = await listProjects(state)
  if (!projects.length) throw new Error('账号下还没有项目：先在 meoo.com 建一个项目')
  if (projects.length === 1) {
    const only = projects[0]?.url_id || projects[0]?.urlId
    if (!only) throw new Error('项目列表里没有 url_id，无法定位项目')
    return only
  }
  const options = projects.map((p) => `${p.url_id || p.urlId}（${p.name || '未命名'}）`).join('\n  ')
  throw new Error(`账号下有多个项目，请用 /meoo project <urlId> 指定一个：\n  ${options}`)
}

async function resolveServiceAk(state, { projectUrlId, force = false } = {}) {
  const urlId = await pickProject(state, projectUrlId)
  if (!force && state.serviceAk && state.serviceAkProjectId === urlId) return state.serviceAk

  let env = null
  try {
    env = await controlRequest(state, 'GET', `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud/environment`)
  } catch {
    env = null
  }
  let ak = env?.meooProjectApiKey || env?.instance?.meooProjectApiKey || null

  if (!ak) {
    try {
      await controlRequest(state, 'POST', `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud`, {
        description: 'dsh-meoo: AI 服务',
      })
      env = await controlRequest(state, 'GET', `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud/environment`)
      ak = env?.meooProjectApiKey || env?.instance?.meooProjectApiKey || null
    } catch {
      ak = null
    }
  }
  if (!ak) throw new Error(`项目 ${urlId} 还没开通 Meoo AI 服务：在 meoo.com 打开该项目 → 云服务 开通一次`)

  state.serviceAk = ak
  state.serviceAkProjectId = urlId
  state.projectUrlId = urlId
  saveState(state)
  return ak
}

async function fetchGatewayModels(state) {
  const base = (state.gatewayBaseUrl || DEFAULT_GATEWAY).replace(/\/+$/, '')
  const ak = state.serviceAk
  if (!ak) return { models: FALLBACK_MODELS, source: 'fallback' }
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${ak}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const list = json?.models || json?.data || []
    const models = list
      .map((entry) =>
        typeof entry === 'string'
          ? { id: entry, name: labelOf(entry) }
          : { id: entry?.id, name: entry?.name || labelOf(entry?.id) },
      )
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
    return models.length ? { models, source: 'gateway' } : { models: FALLBACK_MODELS, source: 'fallback' }
  } catch {
    return { models: FALLBACK_MODELS, source: 'fallback' }
  }
}

function labelOf(id) {
  return FALLBACK_MODELS.find((m) => m.id === id)?.name || id
}

// ---------------------------------------------------------------------------
// 写入：凭据 + llm-pi-ai 路由
// ---------------------------------------------------------------------------

function buildProfile({ state, models }) {
  return {
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    displayName: DEFAULT_PROVIDER_NAME,
    api: 'openai-completions',
    baseURL: (state.gatewayBaseUrl || DEFAULT_GATEWAY).replace(/\/+$/, ''),
    models: models.map((m) => ({
      id: m.id,
      name: m.name || labelOf(m.id),
      contextWindow: CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    })),
  }
}

async function storeCredential(ctx, ak, { overwrite }) {
  let credentials
  try {
    credentials = ctx.get?.('credentials')
  } catch {
    credentials = undefined
  }
  if (!credentials) return { ok: false, reason: 'no-credentials-service' }
  try {
    // 品牌类型 CredentialRef 只是编译期标记，运行期就是字符串；
    // 本包不声明 @deepseek-ai/* 依赖，故不走 credentialRef()
    const ref = DEFAULT_API_KEY_ENV
    if (!overwrite) {
      const info = await credentials.describe?.(ref)
      if (info?.configured) return { ok: true, skipped: true }
    }
    await credentials.set(ref, ak)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

/** `llm-pi-ai` 的 settings 命名空间还没注册好（启动竞态）；等一会儿再写。 */
class SettingsNotReadyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsNotReadyError'
  }
}

/**
 * 读 `llm-pi-ai` 当前的 providers —— 内核解析后的 live 配置，含用户在
 * 「设置 → 模型」里做的改动。`settings` 服务没有 `get()`，公共读法是 `describe()`。
 * @returns 命名空间还没注册时返回 `undefined`；否则返回 providers 字典。
 */
function readProviders(settings) {
  let rows
  try {
    rows = settings.describe?.() ?? []
  } catch {
    return undefined
  }
  const row = Array.isArray(rows) ? rows.find((entry) => entry?.ns === PI_AI_NS) : undefined
  if (!row) return undefined
  const providers = row.value?.providers
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
}

async function writeProfile(settings, profile, route, { overwrite }) {
  const providers = readProviders(settings)
  if (providers === undefined) throw new SettingsNotReadyError(`settings 命名空间 ${PI_AI_NS} 还没注册`)
  const existing = providers[route]

  if (existing && !overwrite) {
    // 已经配过：只补空缺字段，绝不覆盖用户在「设置 → 模型」里改过的值
    const patch = {}
    if (!existing.baseURL) patch.baseURL = profile.baseURL
    if (!existing.api) patch.api = profile.api
    if (!existing.apiKeyEnv) patch.apiKeyEnv = profile.apiKeyEnv
    if (!existing.displayName) patch.displayName = profile.displayName

    // 模型按 id 求差集：已有的原样保留（不碰 reasoningEfforts / input / compat），
    // 网关新增的追加到末尾，网关已下线的保留不删。mergeLayers 对数组是整体替换，
    // 所以这里必须传完整数组。
    const existingModels = Array.isArray(existing.models) ? existing.models : []
    const existingIds = new Set(existingModels.map((m) => m.id))
    const added = profile.models.filter((m) => !existingIds.has(m.id))
    if (!existingModels.length) {
      patch.models = profile.models
    } else if (added.length) {
      patch.models = [...existingModels, ...added]
    }

    if (!Object.keys(patch).length) {
      return { updated: false, reason: 'already-configured', addedModels: 0, keptModels: existingModels.length }
    }
    await settings.update(PI_AI_NS, { providers: { [route]: patch } })
    return { updated: true, addedModels: added.length, keptModels: existingModels.length }
  }

  await settings.update(PI_AI_NS, { providers: { [route]: profile } })
  return { created: true, addedModels: profile.models.length, keptModels: 0 }
}

/**
 * 写路由并处理启动竞态：`llm-pi-ai` 的 settings 命名空间要等它自己 apply 后才注册，
 * 我们可能先跑。按短退避重试，直到命名空间出现。
 *
 * 命名空间注册不上就不再落盘：这个 dsh 版本的 `settings.yaml` 已经迁进 profile
 * patch（`$DSH_HOME/settings.yaml` 会被改名成 `.imported`），再往那里写就是死信。
 */
async function writeProfileWithRetry(settings, profile, route, options, logger) {
  const delays = [0, 150, 300, 600, 1000, 1500, 2000, 3000, 3000, 3000]
  let lastError
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      return await writeProfile(settings, profile, route, options)
    } catch (err) {
      if (!(err instanceof SettingsNotReadyError)) throw err
      lastError = err
      logger?.debug?.(`dsh-meoo: 等待 ${PI_AI_NS} 命名空间（${err.message}）`)
    }
  }
  throw new Error(`写入 ${PI_AI_NS} 路由失败: ${lastError?.message || lastError}`)
}

// ---------------------------------------------------------------------------
// 同步主流程
// ---------------------------------------------------------------------------

export async function syncOnce(ctx, state, { overwrite = false, force = false, projectUrlId } = {}) {
  const logger = ctx?.logger ?? console
  const settings = ctx.get?.('settings')
  if (!settings) throw new Error('settings 服务不可用，无法注册模型路由')

  if (projectUrlId) state.projectUrlId = projectUrlId

  if (!state.accessToken && !state.refreshToken) {
    return { ok: false, reason: 'not-logged-in', message: '还没登录：先 /meoo login，或先跑一次 meoo-proxy 的 login' }
  }

  await fetchIdentity(state)
  const ak = await resolveServiceAk(state, { projectUrlId: state.projectUrlId, force })
  const { models, source } = await fetchGatewayModels(state)
  state.models = models
  state.lastSyncAt = Date.now()
  state.lastError = null
  saveState(state)

  const route = state.route || DEFAULT_ROUTE
  const profile = buildProfile({ state, models })

  const cred = await storeCredential(ctx, ak, { overwrite })
  let written
  try {
    written = await writeProfileWithRetry(settings, profile, route, { overwrite }, logger)
  } catch (err) {
    // 诊断：把当前可见的 settings / 目录状态留在 state 里，便于排查竞态
    const diag = {}
    try {
      diag.piAiProviders = readProviders(settings) === undefined ? 'namespace-missing' : 'present'
      const described = settings.describe?.({ redactSecrets: true })
      diag.describeRaw = JSON.stringify(described)?.slice(0, 600)
      const llm = ctx.get?.('llm', false)
      diag.hasLlm = Boolean(llm)
      diag.configurable = llm?.listConfigurableProviders?.()?.map((e) => `${e.provider}@${e.settingsNs}`) ?? 'n/a'
      diag.liveProviders = llm?.listProviders?.()?.map((p) => p.id) ?? 'n/a'
    } catch (inner) {
      diag.error = String(inner?.message || inner)
    }
    state.diag = diag
    throw err
  }

  return {
    ok: true,
    route,
    models: models.length,
    source,
    credential: cred,
    written,
    projectUrlId: state.projectUrlId,
    serviceAk: maskSecret(ak),
  }
}

// ---------------------------------------------------------------------------
// /meoo 命令
// ---------------------------------------------------------------------------

function renderStatus(state) {
  const lines = [
    '**Meoo 秒悟**',
    `- 账号: ${state.username || '未登录'}${state.userId ? ` (${state.userId})` : ''}`,
    `- 登录态: ${state.refreshToken ? `可用，access 到 ${fmtTs(state.accessExpiresAt)}` : '无'}`,
    `- 项目: ${state.projectUrlId || '未指定'}`,
    `- 服务 AK: ${maskSecret(state.serviceAk)}${state.serviceAkProjectId ? `（项目 ${state.serviceAkProjectId}）` : ''}`,
    `- 模型: ${state.models?.length ? state.models.map((m) => `\`${m.id}\``).join('、') : '未同步'}`,
    `- 上次同步: ${fmtTs(state.lastSyncAt)}`,
    `- 网关: ${state.gatewayBaseUrl || DEFAULT_GATEWAY}`,
  ]
  if (state.lastError) lines.push(`- 上次错误: ${state.lastError}`)
  lines.push('', '用法: `/meoo sync` 重新同步 · `/meoo login` 授权 · `/meoo project <urlId>` 换项目 · `/meoo key <ak>` 手填 AK · `/meoo models` 列模型')
  return lines.join('\n')
}

function registerCommand(ctx, state, logger) {
  let commands
  try {
    commands = ctx.get?.('commands')
  } catch {
    commands = undefined
  }
  if (!commands?.register) {
    logger.warn?.('dsh-meoo: commands 服务不可用，/meoo 命令未注册')
    return
  }

  commands.register({
    name: 'meoo',
    description: 'Meoo 秒悟：登录、选项目、同步模型到模型选择器',
    input: { hint: '[status|sync|login|models|project <urlId>|key <ak>|logout]' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput || '').trim()
      const [sub, ...rest] = raw.split(/\s+/)
      const arg = rest.join(' ').trim()

      try {
        switch (sub || 'status') {
          case 'status':
            return { kind: 'success', text: renderStatus(state) }

          case 'models': {
            if (!state.models?.length) {
              const { models } = await fetchGatewayModels(state)
              state.models = models
              saveState(state)
            }
            return {
              kind: 'success',
              text: state.models.map((m) => `- \`${m.id}\` — ${m.name}`).join('\n'),
            }
          }

          case 'sync': {
            const result = await syncOnce(ctx, state, { force: true })
            const written = result.written || {}
            const addedModels = Number(written.addedModels) || 0
            const keptModels = Number(written.keptModels) || 0
            return {
              kind: result.ok ? 'success' : 'error',
              text: result.ok
                ? `已同步（新增 ${addedModels} 个模型，保留 ${keptModels} 个已有配置）到 \`llm-pi-ai\` 提供方 \`${result.route}\`（项目 ${result.projectUrlId}）。\n在输入框的模型选择器里选「${DEFAULT_PROVIDER_NAME}」即可使用。`
                : result.message || '同步失败',
            }
          }

          case 'login': {
            const { ready, done } = startLogin(state)
            let url
            try {
              url = await ready
            } catch (err) {
              return { kind: 'error', text: `启动本机授权回调失败: ${err?.message || err}` }
            }
            openBrowser(url)
            done
              .then(async () => {
                logger.info?.('dsh-meoo: 授权完成，正在同步')
                try {
                  await syncOnce(ctx, state, { force: true })
                  logger.info?.('dsh-meoo: 同步完成')
                } catch (err) {
                  // 写进 state，否则 /meoo status 只显示「未同步」，用户看不到原因
                  state.lastError = err?.message || String(err)
                  saveState(state)
                  logger.warn?.(`dsh-meoo: 同步失败 ${state.lastError}`)
                }
              })
              .catch((err) => logger.warn?.(`dsh-meoo: 授权失败 ${err?.message || err}`))
            return {
              kind: 'success',
              text: `已在浏览器打开授权页；没有自动打开就手动访问：\n${url}\n\n点「授权」后会自动同步，随后用 /meoo status 查看结果。`,
            }
          }

          case 'project': {
            if (!arg) throw new Error('用法: /meoo project <urlId>')
            const result = await syncOnce(ctx, state, { force: true, projectUrlId: arg })
            return { kind: 'success', text: `已切到项目 ${arg}，同步 ${result.models} 个模型` }
          }

          case 'key': {
            if (!arg) throw new Error('用法: /meoo key meoo_project_service_v1.xxx')
            state.serviceAk = arg
            state.serviceAkProjectId = state.projectUrlId
            saveState(state)
            const result = await syncOnce(ctx, state, { force: true })
            return { kind: 'success', text: `已写入 AK，同步 ${result.models} 个模型` }
          }

          case 'logout': {
            state.accessToken = null
            state.refreshToken = null
            state.accessExpiresAt = 0
            state.serviceAk = null
            state.serviceAkProjectId = null
            saveState(state)
            return { kind: 'success', text: '已清除本地登录态（模型路由保留，凭据仍在 credentials 里）' }
          }

          default:
            return { kind: 'error', text: `未知子命令: ${sub}\n${renderStatus(state)}` }
        }
      } catch (err) {
        state.lastError = err?.message || String(err)
        saveState(state)
        return { kind: 'error', text: `Meoo: ${err?.message || err}` }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const state = loadState()
  state.route = config.route || DEFAULT_ROUTE
  state.gatewayBaseUrl = config.gatewayBaseUrl || state.gatewayBaseUrl || DEFAULT_GATEWAY

  registerCommand(ctx, state, logger)

  // 后台同步一次；失败只记日志，不阻断插件加载。
  // 必须用 setTimeout 把写入推到 apply 之外：settings.update() 在 HMR 事务里调用会被
  // 内核以 `HMR transactions cannot be nested` 拒绝（热重载时 apply 本身在事务中）。
  const defer = (fn) => {
    const timer = setTimeout(() => fn().catch(() => {}), 0)
    timer.unref?.()
  }

  const boot = async (runCtx) => {
    try {
      const result = await syncOnce(runCtx, state, { overwrite: Boolean(config.overwrite) })
      if (result.ok) {
        logger.info?.(`dsh-meoo: 已注册 ${result.route} 提供方，${result.models} 个模型（来源 ${result.source}）`)
      } else {
        logger.info?.(`dsh-meoo: ${result.message}`)
      }
    } catch (err) {
      state.lastError = err?.message || String(err)
      saveState(state)
      logger.warn?.(`dsh-meoo: 同步失败 ${state.lastError}`)
    }
  }

  defer(() => boot(ctx))
}

export const __internals = {
  loadState,
  saveState,
  syncOnce,
  buildProfile,
  fetchGatewayModels,
  stateFile,
  proxyConfigFile,
  resolveServiceAk,
  FALLBACK_MODELS,
}
