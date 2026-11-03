// 离线自测：用假 ctx + 假 fetch 跑通 syncOnce 与 /meoo 命令
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meoo-test-'))
process.env.DSH_HOME = tmpHome

const plugin = await import('../index.js')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

// ---- 假 fetch ----
const calls = []
const AK = 'meoo_project_service_v1.999.test.1792596798.AKAKAKAK'
// identity 的 project_url_id 是否为空（模拟「账号没有默认项目」）
let identityHasProject = true
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  calls.push(`${init.method || 'GET'} ${u.pathname}`)
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (u.pathname === '/open/v1/cli-compat/account/identity') {
    return json({
      success: true,
      data: { name: '测试用户', user_id: 'u_1', project_url_id: identityHasProject ? 'proj_1' : null },
    })
  }
  if (u.pathname === '/open/v1/cli-compat/projects') {
    return json({ success: true, data: { list: [{ name: '模型API接入', url_id: 'proj_auto', status: 'active' }] } })
  }
  if (u.pathname === '/open/v1/cli-compat/projects/proj_1/cloud/environment') {
    return json({ success: true, data: { enabled: true, meooProjectApiKey: AK } })
  }
  if (u.pathname === '/open/v1/cli-compat/projects/proj_auto/cloud/environment') {
    return json({ success: true, data: { enabled: true, meooProjectApiKey: AK } })
  }
  if (u.pathname === '/meoo-ai/compatible-mode/v1/models') {
    return json({ models: ['qwen3.8-flash', 'deepseek-v4-pro-0813', 'kimi-k3'], defaultModel: 'qwen3.8-flash' })
  }
  return json({ success: false, message: 'unexpected ' + u.pathname }, 404)
}

// ---- 假服务 ----
const settingsWrites = []
const credentials = { store: null, set: async (ref, value) => { credentials.store = { ref, value } } }
const settings = {
  value: { providers: {} },
  describe() {
    return [{ ns: 'llm-pi-ai', value: this.value }]
  },
  async update(ns, patch) {
    settingsWrites.push({ ns, patch })
    this.value = { ...this.value, ...(ns === 'llm-pi-ai' ? patch : {}) }
  },
}
let commandDef = null
const commands = { register: (def) => { commandDef = def } }

const scoped = {
  get: (n) => ({ settings, credentials, commands })[n],
  logger: { info() {}, warn() {}, debug() {} },
  effect: () => () => {},
}
const ctx = { ...scoped, inject: (_deps, cb) => cb(scoped) }

// ---- 种一份已登录状态（模拟 meoo-proxy CLI 登录过） ----
const state = plugin.__internals.loadState()
state.accessToken = 'access-token'
state.accessExpiresAt = Date.now() + 3600_000
state.refreshToken = 'refresh-token'
state.projectUrlId = 'proj_1'
plugin.__internals.saveState(state)

// ---- 1) apply 注册命令 + 后台同步 ----
plugin.apply(ctx, {})
await new Promise((r) => setTimeout(r, 120))
check('apply 注册了 /meoo 命令', Boolean(commandDef) && commandDef.name === 'meoo')

const route = settings.value.providers.meoo
check('写入了 llm-pi-ai 的 meoo 路由', Boolean(route), route ? `baseURL=${route.baseURL}` : '')
check('路由协议为 openai-completions', route?.api === 'openai-completions')
check('路由带网关地址', route?.baseURL === 'https://api.meoo.host/meoo-ai/compatible-mode/v1')
check('模型目录来自网关', route?.models?.length === 3 && route.models.some((m) => m.id === 'kimi-k3'), JSON.stringify(route?.models?.map((m) => m.id)))
check('模型带容量字段', route?.models?.[0]?.contextWindow === 200000 && route.models[0].maxTokens === 64000)
check('凭据写入 MEOO_API_KEY', credentials.store?.value === AK && String(credentials.store?.ref).includes('MEOO_API_KEY'))

// ---- 2) 命令 ----
const status = await commandDef.handler({ rawInput: '' })
check('/meoo status 成功', status.kind === 'success' && status.text.includes('Meoo 秒悟'))

const models = await commandDef.handler({ rawInput: 'models' })
check('/meoo models 列出模型', models.kind === 'success' && models.text.includes('deepseek-v4-pro-0813'))

const sync = await commandDef.handler({ rawInput: 'sync' })
check('/meoo sync 成功', sync.kind === 'success' && /新增 \d+ 个模型，保留 \d+ 个已有配置/.test(sync.text))

const unknown = await commandDef.handler({ rawInput: 'nope' })
check('未知子命令报错', unknown.kind === 'error')

// ---- 3) 幂等：已有配置且不覆盖 ----
const before = settingsWrites.length
await plugin.__internals.syncOnce(ctx, state, { overwrite: false })
const afterWrites = settingsWrites.slice(before)
const wroteFullProfile = afterWrites.some((w) => w.patch?.providers?.meoo?.api)
check('第二次同步不覆盖已配置的路由', !wroteFullProfile)

// ---- 3b) 显式 projectUrlId 不被 identity 的默认项目覆盖 ----
identityHasProject = true
state.projectUrlId = 'proj_1'
const callsBefore = calls.length
const explicit = await plugin.__internals.syncOnce(ctx, state, { overwrite: false, projectUrlId: 'proj_auto' })
const envPaths = calls.slice(callsBefore).filter((c) => c.includes('/cloud/environment'))
check(
  '显式项目不被 identity 覆盖',
  explicit.projectUrlId === 'proj_auto' &&
    state.projectUrlId === 'proj_auto' &&
    envPaths.some((c) => c.includes('proj_auto')) &&
    !envPaths.some((c) => c.includes('proj_1')),
  `projectUrlId=${explicit.projectUrlId} env=${envPaths.join('|') || '(无)'}`,
)

// ---- 3c) 已有路由时，新模型按 id 追加、旧配置原样保留 ----
state.projectUrlId = 'proj_1'
const gatewayFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/meoo-ai/compatible-mode/v1/models')) {
    return new Response(
      JSON.stringify({ models: ['qwen3.8-flash', 'kimi-k3'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return gatewayFetch(url, init)
}
// 预置一份用户改过的路由：qwen3.8-flash 带自定义 reasoningEfforts，另有一个网关已下线的老模型
settings.value = {
  providers: {
    meoo: {
      apiKeyEnv: 'MEOO_API_KEY',
      displayName: 'Meoo 秒悟',
      api: 'openai-completions',
      baseURL: 'https://api.meoo.host/meoo-ai/compatible-mode/v1',
      models: [
        { id: 'qwen3.8-flash', name: '我改过的名字', reasoningEfforts: { high: 'high' } },
        { id: 'legacy-gone', name: '已下线' },
      ],
    },
  },
}
const mergeWrites = settingsWrites.length
await plugin.__internals.syncOnce(ctx, state, { overwrite: false })
const mergePatch = settingsWrites.slice(mergeWrites).at(-1)?.patch?.providers?.meoo
const mergedModels = mergePatch?.models || []
globalThis.fetch = gatewayFetch
check(
  '模型按 id 差集合并，已有配置原样保留',
  mergedModels.length === 3 &&
    mergedModels[0].name === '我改过的名字' &&
    JSON.stringify(mergedModels[0].reasoningEfforts) === '{"high":"high"}' &&
    mergedModels[1].id === 'legacy-gone' &&
    mergedModels[2].id === 'kimi-k3',
  mergedModels.map((m) => m.id).join(','),
)

// ---- 4) 未登录时的提示 ----
const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meoo-test2-'))
process.env.DSH_HOME = freshHome
const fresh = plugin.__internals.loadState()
// 屏蔽 meoo-proxy 复用：临时改 HOME 不现实，这里直接清掉 token 后调用
fresh.refreshToken = null
fresh.accessToken = null
const notLogged = await plugin.__internals.syncOnce(ctx, fresh, {})
check('未登录时给出可读提示', notLogged.ok === false && notLogged.reason === 'not-logged-in')

// ---- 5) 命名空间没注册时：退避重试，失败即报错，不写 settings.yaml ----
const lateSettings = {
  value: { providers: {} },
  describe() {
    return []
  },
  async update() {
    throw new Error('不该被调用')
  },
}
const lateCtx = { ...scoped, get: (n) => ({ settings: lateSettings, credentials, commands })[n] }
const started = Date.now()
let lateError = null
try {
  await plugin.__internals.syncOnce(lateCtx, state, { overwrite: false })
} catch (err) {
  lateError = err
}
check(
  '命名空间缺失时报错并重试（而非静默写 settings.yaml）',
  Boolean(lateError) && Date.now() - started > 1000,
  lateError ? lateError.message.slice(0, 60) : '未抛错',
)
check('未向 settings.yaml 兜底落盘', !fs.existsSync(path.join(process.env.DSH_HOME, 'settings.yaml')))

// ---- 6) identity 没给 project_url_id 时，自动挑唯一的项目 ----
identityHasProject = false
const autoState = { ...state, projectUrlId: null, serviceAk: null, serviceAkProjectId: null }
const autoResult = await plugin.__internals.syncOnce(ctx, autoState, { overwrite: false })
check(
  '没有默认项目时自动选用唯一项目',
  autoResult.ok === true && autoResult.projectUrlId === 'proj_auto',
  `projectUrlId=${autoResult.projectUrlId}`,
)

// ---- 7) 多个项目时必须报错并列出可选项 ----
const manyFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/open/v1/cli-compat/projects?')) {
    return new Response(
      JSON.stringify({ success: true, data: { list: [
        { name: '甲', url_id: 'p_a' },
        { name: '乙', url_id: 'p_b' },
      ] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return manyFetch(url, init)
}
const manyState = { ...state, projectUrlId: null, serviceAk: null, serviceAkProjectId: null }
let manyError = null
try {
  await plugin.__internals.syncOnce(ctx, manyState, { overwrite: false })
} catch (err) {
  manyError = err
}
globalThis.fetch = manyFetch
identityHasProject = true
check(
  '多个项目时报错并列出 urlId',
  Boolean(manyError) && manyError.message.includes('p_a') && manyError.message.includes('p_b'),
  manyError ? manyError.message.split('\n')[0].slice(0, 40) : '未抛错',
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
