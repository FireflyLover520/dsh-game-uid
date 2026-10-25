/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/dsh-tools` 的 defineTool
 * ============================================================
 * 为什么不能裸 import：桌面版 profile 是 `autoInstallPeers: false`，
 * 插件的 optional peer 永远不装 ⇒ 整条插件 failed to import、DSH 只留一句 warning。
 * 策略：宿主树里找 → 找不到就用本地等价实现（校验 spec 后原样返回），
 * **绝不因为一个 import 让整条插件不激活**。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.'] ?? pkg.exports
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || dot?.require || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/**
 * 本地等价实现（拿不到宿主的 dsh-tools 时顶上）
 * ------------------------------------------------------------
 * 宿主 dsh-tools 的 defineTool 做两件事，这里都照着做：
 *   ① `parameters` 是 **spec 形态**（每个属性里写 required:true）→ 编译成标准 JSON Schema
 *      `{type:'object', properties, required:[...]}`（宿主 tools 服务收到的是这种）；
 *   ② `output.schema` 走同一套 DSL 编译。
 * 不编译的后果：宿主拿到 spec 形态会当成 JSON Schema 用，required 全丢 / 校验错乱。
 */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
function compileValue(spec, where) {
  if (!spec || typeof spec !== 'object') throw new Error(`defineTool(${where}) 必须是对象`)
  const out = {}
  if (spec.type === 'object') {
    const props = spec.properties || {}
    out.type = 'object'
    out.properties = {}
    for (const [k, v] of Object.entries(props)) out.properties[k] = compileValue(v, `${where}.properties.${k}`)
    if (Array.isArray(spec.required)) out.required = spec.required.slice()
    if (Object.prototype.hasOwnProperty.call(spec, 'additionalProperties')) out.additionalProperties = spec.additionalProperties
  } else {
    if (spec.type) out.type = spec.type
    if (spec.items) out.items = compileValue(spec.items, `${where}.items`)
    if (Array.isArray(spec.enum)) out.enum = spec.enum.slice()
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (spec[k] !== undefined) out[k] = spec[k]
    }
  }
  for (const k of ANNOTATIONS) if (spec[k] !== undefined) out[k] = spec[k]
  return out
}

function localDefineTool(options) {
  const props = options.parameters || {}
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(props)) {
    properties[k] = compileValue(v, `parameters.${k}`)
    if (v && v.required === true) required.push(k)
  }
  const parameters = { type: 'object', properties, ...(required.length ? { required } : {}) }
  const outputSchema = compileValue(options.output?.schema || { type: 'object', additionalProperties: true }, 'output.schema')
  return {
    ...options,
    parameters,
    output: { schema: outputSchema, render: options.output.render },
  }
}

/** @returns {Promise<{defineTool:Function, notes:string[]}>} */
export async function loadToolDeps() {
  const notes = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, 'dsh-tools')
    if (!url) continue
    try {
      const mod = await import(url)
      if (typeof mod.defineTool === 'function') {
        notes.push('dsh-tools：从宿主树取到 ' + url)
        return { defineTool: mod.defineTool, notes }
      }
    } catch (e) {
      notes.push('dsh-tools 导入失败：' + (e?.code || e?.message))
    }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') {
      notes.push('dsh-tools：用自己依赖那棵树')
      return { defineTool: mod.defineTool, notes }
    }
  } catch (e) {
    notes.push('dsh-tools 拿不到（' + (e?.code || e?.message) + '）—— 用本地等价实现顶上')
  }
  return { defineTool: localDefineTool, notes }
}
