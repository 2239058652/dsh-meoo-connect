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
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  calls.push(`${init.method || 'GET'} ${u.pathname}`)
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (u.pathname === '/open/v1/cli-compat/account/identity') {
    return json({ success: true, data: { name: '测试用户', user_id: 'u_1', project_url_id: 'proj_1' } })
  }
  if (u.pathname === '/open/v1/cli-compat/projects/proj_1/cloud/environment') {
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
check('/meoo sync 成功', sync.kind === 'success' && sync.text.includes('3 个模型'))

const unknown = await commandDef.handler({ rawInput: 'nope' })
check('未知子命令报错', unknown.kind === 'error')

// ---- 3) 幂等：已有配置且不覆盖 ----
const before = settingsWrites.length
await plugin.__internals.syncOnce(ctx, state, { overwrite: false })
const afterWrites = settingsWrites.slice(before)
const wroteFullProfile = afterWrites.some((w) => w.patch?.providers?.meoo?.api)
check('第二次同步不覆盖已配置的路由', !wroteFullProfile)

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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
