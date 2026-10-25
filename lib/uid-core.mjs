/**
 * lib/uid-core.mjs —— UID → 角色练度报告（原神走 Enka，星铁走 mihomo）
 * ============================================================
 * 数据源（都是公开只读接口，不需要 token）：
 *   · 原神 https://enka.network/api/uid/<uid>          —— 展柜角色、圣遗物、武器、面板
 *   · 星铁 https://api.mihomo.me/sr_info_parsed/<uid>  —— 角色、光锥、遗器、行迹、面板
 * 输出：一份给聊天看的中文报告（render）+ 一份存档 JSON/MD（archive，仿 A.exe 的存档习惯）
 */

import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')

let LOC = {}
let CHARS = {}
let SETS = {}
try { LOC = JSON.parse(readFileSync(join(DATA, 'loc-zh.json'), 'utf8')) } catch { LOC = {} }
try { CHARS = JSON.parse(readFileSync(join(DATA, 'chars.json'), 'utf8')) } catch { CHARS = {} }
try { SETS = JSON.parse(readFileSync(join(DATA, 'sets.json'), 'utf8')) } catch { SETS = {} }

const loc = (h) => (h === undefined || h === null ? '' : String(LOC[String(h)] || ''))
/** 套装名：优先用 setId 查本地套装表，再退回 setNameTextMapHash */
const setNameOf = (flat) => {
  const bySet = flat?.setId !== undefined ? SETS[String(flat.setId)] : ''
  if (bySet) return bySet
  const byHash = loc(flat?.setNameTextMapHash)
  if (byHash) return byHash
  return flat?.setId !== undefined ? `未知套装#${flat.setId}` : '未知套装'
}

// ── 原神常量 ────────────────────────────────────────────────
const GI_SLOT = { 1: '生之花', 2: '死之羽', 3: '时之沙', 4: '空之杯', 5: '理之冠' }
const GI_EQUIP = {
  EQUIP_BRACER: 1, EQUIP_NECKLACE: 2, EQUIP_SHOES: 3, EQUIP_RING: 4, EQUIP_DRESS: 5,
}
const WEP_ZH = {
  WEAPON_SWORD_ONE_HAND: '单手剑', WEAPON_CLAYMORE: '双手剑',
  WEAPON_POLE: '长柄武器', WEAPON_BOW: '弓', WEAPON_CATALYST: '法器',
}
const ELEM_ZH = {
  // Enka 用游戏内部枚举（Ice/Fire/...），也有 Pyro/Hydro 这一套写法，两套都认
  Fire: '火', Pyro: '火', Water: '水', Hydro: '水',
  Electric: '雷', Electro: '雷', Ice: '冰', Cryo: '冰',
  Wind: '风', Anemo: '风', Rock: '岩', Geo: '岩',
  Grass: '草', Dendro: '草', Physical: '物理',
}
const PROP_FALLBACK = {
  FIGHT_PROP_HP: '生命值', FIGHT_PROP_ATTACK: '攻击力', FIGHT_PROP_DEFENSE: '防御力',
  FIGHT_PROP_HP_PERCENT: '生命值', FIGHT_PROP_ATTACK_PERCENT: '攻击力', FIGHT_PROP_DEFENSE_PERCENT: '防御力',
  FIGHT_PROP_CRITICAL: '暴击率', FIGHT_PROP_CRITICAL_HURT: '暴击伤害',
  FIGHT_PROP_CHARGE_EFFICIENCY: '元素充能', FIGHT_PROP_ELEMENT_MASTERY: '元素精通',
  FIGHT_PROP_HEAL_ADD: '治疗加成', FIGHT_PROP_PHYSICAL_ADD_HURT: '物理伤害',
  FIGHT_PROP_FIRE_ADD_HURT: '火元素伤害', FIGHT_PROP_ELEC_ADD_HURT: '雷元素伤害',
  FIGHT_PROP_WATER_ADD_HURT: '水元素伤害', FIGHT_PROP_GRASS_ADD_HURT: '草元素伤害',
  FIGHT_PROP_WIND_ADD_HURT: '风元素伤害', FIGHT_PROP_ROCK_ADD_HURT: '岩元素伤害',
  FIGHT_PROP_ICE_ADD_HURT: '冰元素伤害',
}
const propName = (k) => loc(k) || PROP_FALLBACK[k] || String(k).replace(/^FIGHT_PROP_/, '')
const PCT_PROPS = new Set([
  'FIGHT_PROP_HP_PERCENT', 'FIGHT_PROP_ATTACK_PERCENT', 'FIGHT_PROP_DEFENSE_PERCENT',
  'FIGHT_PROP_CRITICAL', 'FIGHT_PROP_CRITICAL_HURT', 'FIGHT_PROP_CHARGE_EFFICIENCY',
  'FIGHT_PROP_HEAL_ADD', 'FIGHT_PROP_SHIELD_COST_MINUS_RATIO',
  'FIGHT_PROP_PHYSICAL_ADD_HURT', 'FIGHT_PROP_FIRE_ADD_HURT', 'FIGHT_PROP_ELEC_ADD_HURT',
  'FIGHT_PROP_WATER_ADD_HURT', 'FIGHT_PROP_GRASS_ADD_HURT', 'FIGHT_PROP_WIND_ADD_HURT',
  'FIGHT_PROP_ROCK_ADD_HURT', 'FIGHT_PROP_ICE_ADD_HURT',
])
const isPct = (k) => PCT_PROPS.has(k) || /_HURT$/.test(String(k)) || /PERCENT/.test(String(k))

const HS_SLOT = { 1: '头部', 2: '手部', 3: '躯干', 4: '脚部', 5: '位面球', 6: '连结绳' }

// ── 小工具 ─────────────────────────────────────────────────
const n = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d)
const f1 = (v) => (Math.round(n(v) * 10) / 10).toFixed(1)
const r0 = (v) => Math.round(n(v)).toLocaleString('en-US')
const pct = (v) => f1(n(v) * 100) + '%'
const bar = (v, max = 100) => {
  const k = Math.max(0, Math.min(1, v / max))
  const full = Math.round(k * 10)
  return '█'.repeat(full) + '░'.repeat(10 - full)
}

/** 双爆分 → 评级 */
function gradeOf(score) {
  if (score >= 92) return 'S+'
  if (score >= 83) return 'S'
  if (score >= 72) return 'A'
  if (score >= 55) return 'B'
  if (score >= 35) return 'C'
  return 'D'
}

/**
 * 异环（Neverness to Everness）：没有可匿名按 UID 查的公开接口。
 * 官方数据只在「塔吉多」App 内；第三方（异之环工坊小程序、NTEUID 机器人插件）
 * 都要先用自己的手机号登录塔吉多拿到账号凭据才能取数，属于「登录绑定」而不是 URL 查号。
 */
const NTE_NOTICE = [
  '🕳 **异环（NTE）暂时不能按 UID 查** —— 它没有公开的查号接口。',
  '',
  '目前能查异环的只有两条路，都得登录账号：',
  '· 官方「塔吉多」App / 异之环工坊小程序：手机号 + 验证码登录后看全角色练度（空幕评分满分 350）；',
  '· 社区 NTEUID（github.com/tyql688/nteuid）之类的机器人插件：同样是先 /登录 绑定塔吉多账号。',
  '',
  '所以我这边能查的是：**原神、星铁、绝区零**（都是公开展柜接口，输 UID 即可）。',
  '如果你愿意手动贴一份异环的练度 JSON / 截图，我按同样的格式把数据整理出来（同样不打分、不评价）。',
].join('\n')

const UA = 'dsh-game-uid/0.2 (+https://github.com/iasi/dsh-game-uid)'

async function fetchJson(url, timeout = 12000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: res.status, body, text }
}

// 角色表兜底：Enka 每次版本更新都会往 store/gi/avatars.json 加新角色，而插件自带的
// data/chars.json 是打包时的快照。只靠快照的话，新角色会显示成「角色 10000125」，
// 按名字点名也就查不到它（用户视角就是「检索不到这个角色」）。
// 这里在遇到未知 avatarId 时按需拉一次远端表，只补缺的那部分，之后内存里就齐了。
let giRemoteTried = 0
let giRemotePromise = null
// 本地角色表也可能被「补数据」改过（比如新角色上线时手工补进 data/chars.json）。
// 进程启动时才读一次文件的话，补完就必须重启 DSH 才生效——这里按 mtime 兜一下，
// 文件变新了就在下次查询时重新读一遍。
let giCharsMtime = 0
const CHARS_FILE = join(DATA, 'chars.json')
function reloadLocalCharsIfChanged() {
  try {
    const st = statSync(CHARS_FILE)
    if (st.mtimeMs === giCharsMtime) return
    giCharsMtime = st.mtimeMs
    const raw = JSON.parse(readFileSync(CHARS_FILE, 'utf8'))
    for (const [id, v] of Object.entries(raw || {})) {
      if (!v || !v.n) continue
      CHARS[id] = { n: v.n, el: v.el, wt: v.wt, so: v.so || [] }
    }
  } catch {}
}

async function hydrateGenshinChars(ids) {
  reloadLocalCharsIfChanged()
  const missing = ids.filter((id) => !CHARS[String(id)])
  if (!missing.length) return
  if (Date.now() - giRemoteTried < 60000) return
  giRemoteTried = Date.now()
  if (!giRemotePromise) {
    giRemotePromise = (async () => {
      const base = 'https://cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store'
      const [avatars, locs] = await Promise.all([
        fetchJson(`${base}/gi/avatars.json`, 15000),
        fetchJson(`${base}/gi/locs.json`, 15000),
      ])
      const table = avatars?.body || {}
      const zh = locs?.body?.['zh-cn'] || {}
      for (const [id, v] of Object.entries(table)) {
        if (!v || id.includes('-') || CHARS[id]) continue
        const name = zh[String(v.NameTextMapHash)]
        if (!name) continue
        CHARS[id] = { n: name, el: v.Element, wt: v.WeaponType, so: v.SkillOrder || [] }
      }
      return true
    })().catch(() => false)
  }
  await giRemotePromise
}

// ── 原神 ───────────────────────────────────────────────────
function giTalentLevels(avatar, meta) {
  const map = avatar.skillLevelMap || {}
  const so = (meta && meta.so) || []
  const pick = (i) => n(Number(map[String(so[i])] || 0))
  if (so.length >= 3) return [pick(0), pick(1), pick(2)]
  const vals = Object.values(map).map(Number).sort((a, b) => b - a)
  return [vals[0] || 0, vals[1] || 0, vals[2] || 0]
}

function giScore(char) {
  // 等级 30 + 天赋 30 + 圣遗物双爆 40
  const lv = char.level
  const lvScore = lv >= 90 ? 30 : lv >= 80 ? 24 : lv >= 70 ? 16 : lv >= 60 ? 8 : 4
  const tSum = char.talents[0] + char.talents[1] + char.talents[2]
  const tScore = Math.min(30, (tSum / 30) * 30)
  const aScore = Math.min(40, (char.assetScore / 220) * 40)
  const total = Math.round(lvScore + tScore + aScore)
  return {
    total,
    grade: gradeOf(total),
    parts: { lv: Math.round(lvScore), talent: Math.round(tScore), artifact: Math.round(aScore) },
  }
}

function normGenshin(uid, raw) {
  const pi = raw.playerInfo || {}
  const avatars = Array.isArray(raw.avatarInfoList) ? raw.avatarInfoList : []
  const out = {
    game: 'genshin',
    gameZh: '原神',
    uid: String(raw.uid || uid),
    player: {
      nickname: pi.nickname || '（未公开）',
      level: n(pi.level),
      worldLevel: n(pi.worldLevel),
      signature: pi.signature || '',
      achievements: n(pi.finishAchievementNum),
      region: raw.region || '',
    },
    chars: [],
    source: 'enka.network',
  }
  for (const a of avatars) {
    const meta = CHARS[String(a.avatarId)] || null
    const fp = a.fightPropMap || {}
    const propMap = a.propMap || {}
    const level = Number(propMap['4001']?.ival || 0) || n(fp['4001'])
    const talents = giTalentLevels(a, meta)

    // 武器
    let weapon = null
    const artifacts = []
    for (const eq of a.equipList || []) {
      const flat = eq && eq.flat
      if (!flat) continue
      if (flat.itemType === 'ITEM_WEAPON') {
        const w = eq.weapon || {}
        const wstats = (flat.weaponStats || []).map((s) => ({
          key: s.appendPropId, name: propName(s.appendPropId), value: s.statValue, pct: isPct(s.appendPropId),
        }))
        const ref = Object.values(w.affixMap || {})[0]
        weapon = {
          name: loc(flat.nameTextMapHash) || ('武器 ' + (eq.itemId || '')),
          rarity: n(flat.rankLevel),
          level: n(w.level),
          refine: Number(ref) + 1 || 1,
          baseAtk: wstats.find((s) => s.key === 'FIGHT_PROP_BASE_ATTACK')?.value || 0,
          substat: wstats.find((s) => s.key !== 'FIGHT_PROP_BASE_ATTACK') || null,
        }
      } else if (flat.itemType === 'ITEM_RELIQUARY') {
        const icon = flat.icon || ''
        const slotIdx = GI_EQUIP[flat.equipType] || Number((/_(\d)$/.exec(icon) || [])[1] || 0)
        const main = flat.reliquaryMainstat || {}
        const subs = (flat.reliquarySubstats || []).map((s) => ({
          key: s.appendPropId, name: propName(s.appendPropId), value: s.statValue, pct: isPct(s.appendPropId),
        }))
        const cr = subs.filter((s) => s.key === 'FIGHT_PROP_CRITICAL').reduce((x, s) => x + s.value, 0)
        const cd = subs.filter((s) => s.key === 'FIGHT_PROP_CRITICAL_HURT').reduce((x, s) => x + s.value, 0)
        artifacts.push({
          slot: GI_SLOT[slotIdx] || '圣遗物',
          slotIdx,
          set: setNameOf(flat),
          rarity: n(flat.rankLevel),
          level: Math.max(0, n((eq.reliquary || {}).level) - 1),
          main: { key: main.mainPropId, name: propName(main.mainPropId), value: main.statValue, pct: isPct(main.mainPropId) },
          subs,
          score: Math.round((cr * 2 + cd) * 10) / 10,
        })
      }
    }
    artifacts.sort((x, y) => x.slotIdx - y.slotIdx)

    const assetScore = Math.round(artifacts.reduce((x, r) => x + r.score, 0) * 10) / 10
    // 元素伤害加成：40~46 分别是 火/雷/水/草/风/岩/冰，角色通常只有自己那一项不为 0。
    // 之前只取 max，丢了「是哪个元素」，也会把多元素叠加的账号算少，这里保留完整分布。
    const ELEM_FP = [
      ['40', '火'], ['41', '雷'], ['42', '水'], ['43', '草'],
      ['44', '风'], ['45', '岩'], ['46', '冰'],
    ]
    const elemHit = ELEM_FP.map(([k, zh]) => ({ zh, v: n(fp[k]) })).filter((x) => x.v > 0)
    const elemKey = elemHit.map((x) => x.v)
    const char = {
      id: n(a.avatarId),
      name: (meta && meta.n) || ('角色 ' + a.avatarId),
      element: (meta && ELEM_ZH[meta.el]) || '',
      weaponType: (meta && WEP_ZH[meta.wt]) || '',
      level,
      constellation: (a.talentIdList || []).length,
      talents,
      weapon,
      artifacts,
      assetScore,
      stats: {
        hp: n(fp['2000']), atk: n(fp['2001']), def: n(fp['2002']),
        critRate: n(fp['20']), critDmg: n(fp['22']), charge: n(fp['23']),
        mastery: n(fp['28']), phys: n(fp['30']), elem: Math.max(0, ...elemKey),
        // elemList：命中的每一项（可能是 0 项），elemName：最高的那一项叫什么
        elemList: elemHit,
        elemName: elemHit.length ? elemHit.slice().sort((x, y) => y.v - x.v)[0].zh : '',
      },
      sets: {},
    }
    for (const r of artifacts) char.sets[r.set] = (char.sets[r.set] || 0) + 1
    Object.assign(char, giScore(char))
    out.chars.push(char)
  }
  out.chars.sort((x, y) => n(y.level) - n(x.level) || String(x.name).localeCompare(String(y.name), 'zh'))
  return out
}

// ── 星铁 ───────────────────────────────────────────────────
// ── 星铁打法识别：击破 / DoT 不吃双爆 ──────────────────────
const HS_BREAK_NAMES = ['流萤', '波提欧', '阮·梅', '灵砂', '寒鸦', '忘归人', '貊泽', '同谐']
const HS_DOT_NAMES = ['卡芙卡', '黑天鹅', '桑博', '桂乃芬', '卢卡', '椒丘']
const HS_STYLE_ZH = { crit: '双爆', break: '击破', dot: 'DoT' }
/** 遗器满分的参考线：打法不同，词条上限不同 */
const HS_STYLE_MAX = { crit: 220, break: 190, dot: 200 }

function hsStyleOf(name, path, st) {
  const has = (list) => list.some((k) => name.includes(k))
  if (path.includes('同谐') && name.includes('开拓者')) return 'break'
  if (has(HS_BREAK_NAMES) || n(st.breakDmg) >= 150) return 'break'
  if (has(HS_DOT_NAMES) || (path.includes('虚无') && n(st.hit) >= 60)) return 'dot'
  return 'crit'
}

/** sv(k) = 这件遗器上某词条的总值（百分比词条已转成 100 制） */
function hsRelicScore(style, sv) {
  if (style === 'break') {
    return sv('break_dmg') * 1.6 + sv('spd') * 2.4 + sv('effect_hit') * 0.6 + sv('atk_percent') * 0.8
  }
  if (style === 'dot') {
    return sv('effect_hit') * 2.0 + sv('atk_percent') * 1.4 + sv('spd') * 1.6 + sv('break_dmg') * 0.4
  }
  return sv('crit_rate') * 2 + sv('crit_dmg')
}

function hsScore(char) {
  const lv = char.level
  const lvScore = lv >= 80 ? 30 : lv >= 70 ? 22 : lv >= 60 ? 12 : 5
  const tSum = char.traces.reduce((a, b) => a + b, 0)
  const tScore = Math.min(25, (tSum / 30) * 25)
  const aScore = Math.min(35, (char.assetScore / (HS_STYLE_MAX[char.style] || 220)) * 35)
  const total = Math.round(lvScore + tScore + aScore)
  return {
    total,
    grade: gradeOf(total),
    parts: { lv: Math.round(lvScore), talent: Math.round(tScore), artifact: Math.round(aScore) },
  }
}

function normHSR(uid, raw) {
  const p = raw.player || {}
  const out = {
    game: 'hsr',
    gameZh: '星铁',
    uid: String(p.uid || uid),
    player: {
      nickname: p.nickname || '（未公开）',
      level: n(p.level),
      worldLevel: n(p.world_level),
      signature: p.signature || '',
    },
    chars: [],
    source: 'api.mihomo.me',
  }
  for (const c of raw.characters || []) {
    const fin = {}
    for (const a of c.attributes || []) fin[a.field] = { name: a.name, value: a.value, display: a.display, pct: a.percent }
    for (const a of c.statistics || c.additions || []) fin[a.field] = { name: a.name, value: a.value, display: a.display, pct: a.percent }
    // mihomo 有时不返回击破特攻 / 能量恢复效率（没堆或数据缺省），面板会少这一行。
    // 这两个属性的白值都是 100%，缺失时补上，避免「偶发不体现」。
    if (!fin.break_dmg) fin.break_dmg = { name: '击破特攻', value: 1, display: '100.0%', pct: true }
    // mihomo 的 sp_rate 只给「超出 100% 的部分」（花火 0.3444 = 34.4% 加成，面板应为 134.4%）。
    // 所以小于 1 的一律按加成处理，补回 100% 白值；缺失就是 100%。
    if (fin.sp_rate) {
      const raw = Number(fin.sp_rate.value) || 0
      const total = raw < 1 ? raw + 1 : raw
      fin.sp_rate = { ...fin.sp_rate, value: total, display: (total * 100).toFixed(1) + '%' }
    } else {
      fin.sp_rate = { name: '能量恢复效率', value: 1, display: '100.0%', pct: true }
    }
    // 元素/属性伤害加成：mihomo 只在角色有该项时给字段（wind_dmg / quantum_dmg …），
    // 没堆或缺失就整行消失。这里统一汇总成一个「伤害加成」，缺失时显示 0%。
    let dmgBonus = 0
    for (const key of Object.keys(fin)) {
      if (key === 'break_dmg' || key === 'crit_dmg') continue
      if (/_dmg$/.test(key)) dmgBonus += Number(fin[key]?.value) || 0
    }
    fin.dmg_bonus = { name: '伤害加成', value: dmgBonus, display: (dmgBonus * 100).toFixed(1) + '%', pct: true }
    // ⭐ 先认打法：击破 / DoT 角色不按双爆算遗器分
    const pv = (k) => { const v = parseFloat(String(fin[k]?.display ?? '').replace('%', '')); return Number.isFinite(v) ? v : 0 }
    const style = hsStyleOf(String(c.name || ''), String(c.path?.name || ''), { breakDmg: pv('break_dmg'), hit: pv('effect_hit') })

    const relics = (c.relics || []).map((r) => {
      const subs = (r.sub_affix || []).map((s) => ({
        key: s.field, name: s.name, display: s.display, value: s.value, pct: s.percent,
      }))
      const sv = (k) => subs.filter((s) => s.key === k).reduce((x, s) => x + (s.pct ? n(s.value) * 100 : n(s.value)), 0)
      return {
        slot: HS_SLOT[r.type] || '遗器',
        slotIdx: n(r.type),
        set: r.set_name || '未知遗器',
        name: r.name || '',
        rarity: n(r.rarity),
        level: n(r.level),
        main: { name: r.main_affix?.name || '', display: r.main_affix?.display || '', value: r.main_affix?.value, pct: !!r.main_affix?.percent },
        subs,
        score: Math.round(hsRelicScore(style, sv) * 10) / 10,
      }
    })
    relics.sort((x, y) => x.slotIdx - y.slotIdx)
    const assetScore = Math.round(relics.reduce((x, r) => x + r.score, 0) * 10) / 10

    // 行迹：前三个（普攻/战技/终结技）的等级和
    const trees = (c.skill_trees || []).slice().sort((a, b) => Number(a.id) - Number(b.id))
    const traces = trees.slice(0, 3).map((t) => n(t.level))

    const lc = c.light_cone || null
    const char = {
      id: Number(c.id) || 0,
      name: c.name || ('角色 ' + c.id),
      rarity: n(c.rarity),
      path: c.path?.name || '',
      element: c.element?.name || '',
      level: n(c.level),
      eidolon: n(c.rank),
      traces,
      traceMax: trees.slice(0, 3).map((t) => n(t.max_level)),
      skills: (c.skills || []).map((s) => ({ name: s.name, type: s.type_text || s.type, level: n(s.level), max: n(s.max_level) })),
      lightCone: lc ? {
        name: lc.name || '', rarity: n(lc.rarity), level: n(lc.level), rank: n(lc.rank),
      } : null,
      relics,
      assetScore,
      style,
      stats: Object.fromEntries(Object.entries(fin).map(([k, v]) => [k, { ...v }])),
      sets: {},
    }
    for (const r of relics) char.sets[r.set] = (char.sets[r.set] || 0) + 1
    Object.assign(char, hsScore(char))
    out.chars.push(char)
  }
  out.chars.sort((x, y) => n(y.level) - n(x.level) || String(x.name).localeCompare(String(y.name), 'zh'))
  return out
}

// ── 绝区零（Enka ZZZ）──────────────────────────────────────
let Z_PROPS = {}
let Z_CHARS = {}
let Z_WEAPONS = {}
let Z_SUITS = {}
let Z_DISKS = {}
try { Z_PROPS = JSON.parse(readFileSync(join(DATA, 'zzz-props.json'), 'utf8')) } catch { Z_PROPS = {} }
try { Z_CHARS = JSON.parse(readFileSync(join(DATA, 'zzz-chars.json'), 'utf8')) } catch { Z_CHARS = {} }
try { Z_WEAPONS = JSON.parse(readFileSync(join(DATA, 'zzz-weapons.json'), 'utf8')) } catch { Z_WEAPONS = {} }
try { Z_SUITS = JSON.parse(readFileSync(join(DATA, 'zzz-suits.json'), 'utf8')) } catch { Z_SUITS = {} }
let Z_SUIT_BONUS = {}
try { Z_SUIT_BONUS = JSON.parse(readFileSync(join(DATA, 'zzz-suit-bonus.json'), 'utf8')) } catch { Z_SUIT_BONUS = {} }
try { Z_DISKS = JSON.parse(readFileSync(join(DATA, 'zzz-disks.json'), 'utf8')) } catch { Z_DISKS = {} }

/** 绝区零驱动盘位置（1~6） */
const Z_SLOT = { 1: '驱动盘①', 2: '驱动盘②', 3: '驱动盘③', 4: '驱动盘④', 5: '驱动盘⑤', 6: '驱动盘⑥' }
/** 技能索引 → 名称（官方：0 普攻 / 1 特殊技 / 2 闪避 / 3 终结技 / 5 核心技 / 6 支援技） */
const Z_SKILL = { 0: '普攻', 1: '特殊技', 2: '闪避', 3: '终结技', 5: '核心技', 6: '支援技' }
const Z_SKILL_MAIN = [0, 1, 3] // 练度只看普攻/特殊技/终结技
const Z_ELEM = { Physics: '物理', Fire: '火', Ice: '冰', Elec: '电', Ether: '以太', Wind: '风' }
const Z_RARITY = { 4: 'S', 3: 'A', 2: 'B' }

/** 忽略大小写取字段（Enka 的 ZZZ 响应是 PascalCase，文档里也这么写，这里两种都认） */
function ciGet(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const nm of names) {
    const real = lower.get(String(nm).toLowerCase())
    if (real !== undefined) return obj[real]
  }
  return undefined
}

/** 绝区零属性：store 里一律 ×100 存百分比，Format 带 % 的才是百分比 */
function zStat(id, value) {
  const meta = Z_PROPS[String(id)] || null
  const pctv = !!meta?.p
  // store 里百分比是 ×100 存的（800 = 8.00%），平铺值是原值
  const raw = pctv ? n(value) / 100 : n(value)
  const name = meta?.n || `属性${id}`
  return { id: String(id), name, pct: pctv, value: raw, text: pctv ? f1(raw) + '%' : r0(raw) }
}

/** 音擎主/副词条的实际数值（官方近似公式） */
function zWeaponStatValue(stat, level, breakLevel, isMain) {
  if (!stat) return null
  const base = n(stat.v)
  const lv = n(level), bl = n(breakLevel)
  const mult = isMain
    ? 1 + 0.1568166666666667 * lv + 0.8922 * bl
    : 1 + 0.3 * bl
  return base * mult
}

/** 驱动盘主词条的实际数值（官方近似公式，按稀有度取系数） */
function zDiskMainValue(value, level, rarity) {
  const scale = rarity >= 4 ? 0.2 : rarity >= 3 ? 0.25 : 0.3
  return n(value) * (1 + n(level) * scale)
}

/** 角色基础面板（store/zzz/avatars.json 的四段式公式） */
function zBasePanel(meta, level, promotion, core) {
  const at = (pid) => {
    const base = n(meta?.bp?.[pid])
    const growth = (n(meta?.gp?.[pid]) * (n(level) - 1)) / 10000
    const promoList = meta?.pp || []
    const promoV = n(promoList[Math.max(0, n(promotion) - 1)]?.[pid])
    let ci = core
    if (typeof ci === 'string') ci = 'ABCDEF'.indexOf(ci.toUpperCase()) + 1
    const coreV = n(meta?.cp?.[n(ci)]?.[pid])
    return Math.floor(base + growth) + promoV + coreV
  }
  return {
    hp: at('11101'), atk: at('12101'), def: at('13101'),
    impact: at('12201'), crit: at('20101') / 100, critDmg: at('21101') / 100,
  }
}

/** 完整面板：角色本体 + 音擎主副 + 驱动盘主副（不含套装效果与音擎被动） */
function zFinalPanel(meta, level, promotion, core, weapon, discs, sets) {
  const base = zBasePanel(meta, level, promotion, core)
  const acc = {
    hpFlat: 0, hpPct: 0, atkFlat: 0, atkPct: 0, defFlat: 0, defPct: 0,
    impactFlat: 0, impactPct: 0, crit: 0, critDmg: 0, pen: 0, energy: 0, mastery: 0, proficiency: 0,
  }
  const feed = (st) => {
    if (!st) return
    const v = n(st.value) // 百分比在 zStat 里是小数（0.24），平铺值是原值
    switch (st.name) {
      // zStat 里百分比是「百分数点」（30 表示 30%），平铺值是原值
      case '生命值': st.pct ? (acc.hpPct += v / 100) : (acc.hpFlat += v); break
      case '攻击力': st.pct ? (acc.atkPct += v / 100) : (acc.atkFlat += v); break
      case '防御力': st.pct ? (acc.defPct += v / 100) : (acc.defFlat += v); break
      case '冲击力': st.pct ? (acc.impactPct += v / 100) : (acc.impactFlat += v); break
      case '暴击率': acc.crit += v; break
      case '暴击伤害': acc.critDmg += v; break
      case '穿透率': acc.pen += v; break
      case '能量自动回复': acc.energy += v; break
      case '异常精通': acc.proficiency += v; break
      case '异常掌控': acc.mastery += v; break
      default: break
    }
  }
  if (weapon) { feed(weapon.main); feed(weapon.sub) }
  for (const d of discs) { feed(d.main); for (const x of d.subs) feed(x) }
  // 套装 2/4 件效果（从 wiki 抓的无条件数值；条件型效果抓不到，会注明）
  let dmgBonus = 0
  for (const [suitName, count] of Object.entries(sets || {})) {
    const sid = Object.keys(Z_SUIT_BONUS).find((k) => Z_SUIT_BONUS[k]?.n === suitName)
    if (!sid) continue
    const eff = Z_SUIT_BONUS[sid]
    const apply = (list) => {
      for (const b of list || []) {
        if (b.stat === '伤害') { dmgBonus += b.value; continue }
        feed({ name: b.stat, pct: !!b.pct, value: b.value })
      }
    }
    if (count >= 2) apply(eff.two)
    if (count >= 4) apply(eff.four)
  }

  return {
    hp: Math.round(base.hp * (1 + acc.hpPct) + acc.hpFlat),
    atk: Math.round(base.atk * (1 + acc.atkPct) + acc.atkFlat),
    def: Math.round(base.def * (1 + acc.defPct) + acc.defFlat),
    impact: Math.round(base.impact * (1 + acc.impactPct) + acc.impactFlat),
    crit: Math.round((base.crit + acc.crit) * 10) / 10,
    critDmg: Math.round((base.critDmg + acc.critDmg) * 10) / 10,
    pen: Math.round(acc.pen * 10) / 10,
    energy: Math.round(acc.energy * 10) / 10,
    mastery: Math.round(acc.mastery),
    proficiency: Math.round(acc.proficiency),
    dmgBonus: Math.round(dmgBonus * 10) / 10,
  }
}

function zScore(char) {
  const lv = char.level
  const lvScore = lv >= 60 ? 30 : lv >= 50 ? 24 : lv >= 40 ? 16 : lv >= 30 ? 8 : 4
  const tSum = Math.min(36, char.skillsMain.reduce((a, b) => a + b, 0))
  const tScore = Math.min(30, (tSum / 36) * 30)
  const aScore = Math.min(35, (char.assetScore / 200) * 35)
  const total = Math.round(lvScore + tScore + aScore)
  return {
    total,
    grade: gradeOf(total),
    parts: { lv: Math.round(lvScore), talent: Math.round(tScore), artifact: Math.round(aScore) },
  }
}

/** 绝区零规范化（导出便于离线自测：给定 Enka ZZZ 响应就能渲染报告） */
export function normZZZ(uid, raw) {
  const pi = ciGet(raw, 'playerInfo') || {}
  const social = ciGet(pi, 'SocialDetail') || {}
  const profile = ciGet(social, 'ProfileDetail') || {}
  const showcase = ciGet(pi, 'ShowcaseDetail') || {}
  const list = ciGet(showcase, 'AvatarList')
  const out = {
    game: 'zzz',
    gameZh: '绝区零',
    uid: String(ciGet(raw, 'uid') || profile.Uid || uid),
    player: {
      nickname: ciGet(profile, 'Nickname') || '（未公开）',
      level: n(ciGet(profile, 'Level')),
      signature: ciGet(social, 'Desc') || '',
      medals: (ciGet(social, 'MedalList') || []).length,
    },
    chars: [],
    source: 'enka.network/zzz',
  }

  for (const a of Array.isArray(list) ? list : []) {
    const id = String(ciGet(a, 'Id') || '')
    const meta = Z_CHARS[id] || null
    const level = n(ciGet(a, 'Level'))
    const promotion = ciGet(a, 'PromotionLevel')
    const mindscape = n(ciGet(a, 'TalentLevel'))
    const core = ciGet(a, 'CoreSkillEnhancement')

    // 技能等级：命座 3 → 全技能 +2，命座 5 → 再 +2
    // 真实响应是 [{Level, Index}] 数组（Index 0 普攻 / 1 特殊技 / 2 闪避 / 3 终结技 / 5 核心技 / 6 支援技）
    const rawSkills = ciGet(a, 'SkillLevelList')
    const bonus = mindscape >= 5 ? 4 : mindscape >= 3 ? 2 : 0
    const skills = {}
    if (Array.isArray(rawSkills)) {
      for (const it of rawSkills) {
        const idx = n(ciGet(it, 'Index'))
        const lv = n(ciGet(it, 'Level'))
        if (Z_SKILL[idx]) skills[Z_SKILL[idx]] = lv + bonus
      }
    } else if (rawSkills && typeof rawSkills === 'object') {
      for (const [k, v] of Object.entries(rawSkills)) {
        if (Z_SKILL[k]) skills[Z_SKILL[k]] = n(v) + bonus
      }
    }

    // 音擎
    let weapon = null
    const w = ciGet(a, 'Weapon')
    if (w) {
      const wid = String(ciGet(w, 'Id') || '')
      const wmeta = Z_WEAPONS[wid] || null
      const wl = n(ciGet(w, 'Level'))
      const breakLevel = n(ciGet(w, 'BreakLevel'))
      const main = wmeta?.main ? zStat(wmeta.main.id, zWeaponStatValue(wmeta.main, wl, breakLevel, true)) : null
      const sec = wmeta?.sec ? zStat(wmeta.sec.id, zWeaponStatValue(wmeta.sec, wl, breakLevel, false)) : null
      // ⭐ BreakLevel 是「突破」(跟等级挂钩)，UpgradeLevel 才是「改造」(精炼1~5)
      const upgradeLevel = n(ciGet(w, 'UpgradeLevel')) || 1
      weapon = {
        name: wmeta?.n || `音擎 ${wid}`,
        rarity: Z_RARITY[n(wmeta?.r)] || `${n(wmeta?.r)}★`,
        level: wl,
        refine: upgradeLevel,
        main,
        sub: sec,
      }
    }

    // 驱动盘
    const discs = []
    for (const eq of ciGet(a, 'EquippedList') || []) {
      const d = ciGet(eq, 'Equipment')
      if (!d) continue
      const did = String(ciGet(d, 'Id') || '')
      const dinfo = Z_DISKS[did] || null
      const rarity = n(dinfo?.r)
      const suitId = dinfo?.suit || ''
      const dl = n(ciGet(d, 'Level'))
      const mains = (ciGet(d, 'MainPropertyList', 'MainStatList') || []).map((s) => {
        const idm = String(ciGet(s, 'PropertyId') || '')
        const st = zStat(idm, zDiskMainValue(n(ciGet(s, 'PropertyValue')), dl, rarity))
        return st
      })
      // ⭐ 副词条：PropertyValue 是单次词条的值，PropertyLevel 是命中的词条数（+0 盘就是 1）
      const subs = (ciGet(d, 'RandomPropertyList') || []).map((s) => {
        const rolls = Math.max(1, n(ciGet(s, 'PropertyLevel')) || 1)
        return zStat(String(ciGet(s, 'PropertyId') || ''), n(ciGet(s, 'PropertyValue')) * rolls)
      })
      const cr = mains.concat(subs).filter((s) => /^暴击率$/.test(s.name) || s.name === '暴击率').reduce((x, s) => x + s.value, 0)
      const cd = mains.concat(subs).filter((s) => s.name === '暴击伤害').reduce((x, s) => x + s.value, 0)
      discs.push({
        slot: Z_SLOT[n(ciGet(eq, 'Slot'))] || '驱动盘',
        slotIdx: n(ciGet(eq, 'Slot')),
        set: Z_SUITS[suitId] || `未知套装#${suitId}`,
        rarity,
        level: dl,
        main: mains[0] || null,
        subs,
        score: Math.round((cr * 2 + cd) * 10) / 10,
      })
    }
    discs.sort((x, y) => x.slotIdx - y.slotIdx)
    const assetScore = Math.round(discs.reduce((x, r) => x + r.score, 0) * 10) / 10

    const skillsMain = Z_SKILL_MAIN.map((i) => skills[Z_SKILL[i]] || 0)
    const char = {
      id: Number(id) || 0,
      name: meta?.n || `代理人 ${id}`,
      rarity: Z_RARITY[n(meta?.r)] || '',
      element: meta?.el || '',
      profession: meta?.prof || '',
      level,
      mindscape,
      skills,
      skillsMain,
      weapon,
      discs,
      assetScore,
      base: zBasePanel(meta, level, promotion, core),
      panel: null,
      sets: {},
    }
    for (const r of discs) char.sets[r.set] = (char.sets[r.set] || 0) + 1
    char.panel = zFinalPanel(meta, level, promotion, core, char.weapon, char.discs, char.sets)
    Object.assign(char, zScore(char))
    out.chars.push(char)
  }
  out.chars.sort((x, y) => n(y.level) - n(x.level) || String(x.name).localeCompare(String(y.name), 'zh'))
  return out
}

async function pullZZZ(uid) {
  const { status, body } = await fetchJson(`https://enka.network/api/zzz/uid/${encodeURIComponent(uid)}`)
  if (status === 404) return { ok: false, reason: '绝区零：查不到该 UID（8~10 位数字、且展柜公开）' }
  if (status === 400) return { ok: false, reason: '绝区零：UID 格式不对（绝区零 UID 是 8~10 位数字）' }
  if (status === 429) return { ok: false, reason: '绝区零：Enka 限流，稍后再试' }
  if (status !== 200 || !body) return { ok: false, reason: `绝区零：接口返回 ${status}` }
  const model = normZZZ(uid, body)
  if (!model.chars.length) {
    return { ok: true, model, empty: true, reason: '绝区零：查到玩家，但展柜里没有公开代理人（游戏内「展示柜」需放角色）' }
  }
  return { ok: true, model }
}

// ── 拉取 ───────────────────────────────────────────────────
async function pullGenshin(uid) {
  const { status, body } = await fetchJson(`https://enka.network/api/uid/${encodeURIComponent(uid)}`)
  if (status === 404) return { ok: false, reason: '原神：UID 不存在' }
  if (status === 424) return { ok: false, reason: '原神：该玩家暂无展柜数据（或已被 Enka 缓存丢弃）' }
  if (status === 429) return { ok: false, reason: '原神：Enka 限流，稍后再试' }
  if (status !== 200 || !body || !body.playerInfo) return { ok: false, reason: `原神：接口返回 ${status}` }
  // 先把缺失角色的名字补齐（只打一次网络，之后走内存），否则新角色会显示成「角色 10000125」，
  // 按名字点名也查不到它。
  try { await hydrateGenshinChars((body.avatarInfoList || []).map((a) => a.avatarId)) } catch {}
  if (!Array.isArray(body.avatarInfoList) || body.avatarInfoList.length === 0) {
    const m = normGenshin(uid, body)
    return { ok: true, model: m, empty: true, reason: '原神：查到玩家，但展柜里没有公开角色（游戏内「展柜展示」需勾选角色）' }
  }
  return { ok: true, model: normGenshin(uid, body) }
}

async function pullHSR(uid) {
  const { status, body } = await fetchJson(`https://api.mihomo.me/sr_info_parsed/${encodeURIComponent(uid)}?lang=cn`)
  if (status === 404 || !body || !body.player) return { ok: false, reason: `星铁：${body?.detail || 'UID 不存在或未公开'}` }
  if (status !== 200) return { ok: false, reason: `星铁：接口返回 ${status}` }
  if (!Array.isArray(body.characters) || body.characters.length === 0) {
    const m = normHSR(uid, body)
    return { ok: true, model: m, empty: true, reason: '星铁：查到玩家，但支援角色未公开' }
  }
  return { ok: true, model: normHSR(uid, body) }
}

/**
 * 查询入口
 * @param {string} uid
 * @param {'auto'|'genshin'|'hsr'|'zzz'} game
 */
export async function queryUid(uid, game = 'auto') {
  const clean = String(uid || '').replace(/[^\d]/g, '')
  if (!/^\d{6,12}$/.test(clean)) {
    return { ok: false, text: `UID 看起来不对：\`${uid}\` —— 原神/星铁是 9~10 位数字，绝区零是 8~10 位数字。` }
  }
  if (game === 'nte') return { ok: false, text: NTE_NOTICE }
  if (game === 'genshin' || game === 'hsr' || game === 'zzz') {
    const pull = game === 'genshin' ? pullGenshin : game === 'zzz' ? pullZZZ : pullHSR
    const r = await pull(clean)
    return r.ok ? { ok: true, model: r.model, empty: !!r.empty, note: r.reason || '' } : { ok: false, text: r.reason }
  }
  const kinds = ['genshin', 'hsr', 'zzz']
  const pulls = [pullGenshin(clean), pullHSR(clean), pullZZZ(clean)]
  const tries = await Promise.allSettled(pulls)
  const got = tries.map((t, i) => ({
    game: kinds[i],
    ...(t.status === 'fulfilled' ? t.value : { ok: false, reason: String(t.reason) }),
  }))
  const withChars = got.find((x) => x.ok && x.model && x.model.chars.length)
  if (withChars) return { ok: true, model: withChars.model, note: withChars.reason || '' }
  const anyOk = got.find((x) => x.ok)
  if (anyOk) return { ok: true, model: anyOk.model, empty: true, note: anyOk.reason || '' }
  return {
    ok: false,
    text:
      `原神 / 星铁 / 绝区零 都没查到 UID ${clean}：\n· ${got[0].reason}\n· ${got[1].reason}\n· ${got[2].reason}` +
      `\n\n（异环不在自动识别范围：${NTE_NOTICE.split('\n')[0]}）`,
  }
}

// ── 渲染（只展示数据，不打分、不评价）─────────────────────
function statLine(pairs) {
  return pairs.filter(Boolean).join(' · ')
}

function renderGenshin(m, detail) {
  const L = []
  const p = m.player
  L.push(`🎮 **原神** · UID \`${m.uid}\``)
  L.push(`👤 ${p.nickname} · AR${p.level}${p.worldLevel ? ` · 世界等级 ${p.worldLevel}` : ''}${p.achievements ? ` · 成就 ${p.achievements}` : ''} · 展柜 ${m.charsTotal ?? m.chars.length} 人`)
  if (p.signature) L.push(`　　「${p.signature}」`)
  L.push('')
  for (const c of m.chars) {
    L.push(`**${c.name}** ${c.element ? `(${c.element})` : ''} · Lv.${c.level} · ${c.constellation}命 · 天赋 ${c.talents.join('/')}${c.weaponType ? ` · ${c.weaponType}` : ''}`)
    if (c.weapon) {
      const sub = c.weapon.substat ? ` · ${c.weapon.substat.name} ${c.weapon.substat.pct ? f1(c.weapon.substat.value) + '%' : r0(c.weapon.substat.value)}` : ''
      L.push(`　　⚔️ ${c.weapon.name} R${c.weapon.refine} · Lv.${c.weapon.level} · ${c.weapon.rarity}★ · 基础攻 ${r0(c.weapon.baseAtk)}${sub}`)
    }
    const s = c.stats
    L.push(`　　📊 生命 ${r0(s.hp)} · 攻击 ${r0(s.atk)} · 防御 ${r0(s.def)}`)
    L.push(`　　📊 暴击率 ${f1(s.critRate * 100)}% · 暴击伤害 ${f1(s.critDmg * 100)}% · 元素充能效率 ${f1(s.charge * 100)}% · 元素精通 ${r0(s.mastery)}`)
    const elemTxt = s.elem > 0
      ? `${s.elemName || ''}元素伤害加成 ${f1(s.elem * 100)}%`
      : '元素伤害加成 0.0%'
    L.push(`　　📊 物理伤害加成 ${f1(s.phys * 100)}% · ${elemTxt}`)
    const setTxt = Object.entries(c.sets).map(([k, v]) => `${v}× ${k}`).join(' + ') || '无'
    L.push(`　　🏺 圣遗物 ${setTxt}${c.artifacts.length ? `（${c.artifacts.length} 件）` : ''}`)
    L.push('')
  }
  return L.join('\n').trim()
}

function renderHSR(m, detail) {
  const L = []
  const p = m.player
  L.push(`🎮 **星铁** · UID \`${m.uid}\``)
  L.push(`👤 ${p.nickname} · 开拓等级 ${p.level} · 均衡等级 ${p.worldLevel} · 支援 ${m.charsTotal ?? m.chars.length} 人`)
  if (p.signature) L.push(`　　「${p.signature}」`)
  L.push('')
  for (const c of m.chars) {
    L.push(`**${c.name}** (${c.element}·${c.path}) · Lv.${c.level} · ${c.eidolon}魂 · 行迹 ${c.traces.join('/')}${c.traceMax && c.traceMax.length ? `（满 ${c.traceMax.join('/')}）` : ''}`)
    if (c.lightCone) L.push(`　　⚔️ ${c.lightCone.name} 叠影${c.lightCone.rank} · Lv.${c.lightCone.level} · ${c.lightCone.rarity}★`)
    // 全部面板：mihomo 给了什么就列什么，一条不省
    const all = Object.values(c.stats || {}).filter((v) => v && v.display)
    for (let i = 0; i < all.length; i += 6) {
      L.push(`　　📊 ${all.slice(i, i + 6).map((v) => `${v.name} ${v.display}`).join(' · ')}`)
    }
    if (c.skills && c.skills.length) {
      L.push(`　　🎯 技能 ${c.skills.map((x) => `${x.name} ${x.level}/${x.max}`).join(' · ')}`)
    }
    const setTxt = Object.entries(c.sets).map(([k, v]) => `${v}× ${k}`).join(' + ') || '无'
    L.push(`　　🏺 遗器 ${setTxt}（${c.relics.length} 件）`)
    L.push('')
  }
  return L.join('\n').trim()
}

function renderZZZ(m, detail) {
  const L = []
  const p = m.player
  L.push(`🎮 **绝区零** · UID \`${m.uid}\``)
  L.push(`👤 ${p.nickname} · 绳网等级 ${p.level}${p.medals ? ` · 徽章 ${p.medals}` : ''} · 展柜 ${m.charsTotal ?? m.chars.length} 人`)
  if (p.signature) L.push(`　　「${p.signature}」`)
  L.push('')
  for (const c of m.chars) {
    const elProf = [c.element, c.profession].filter(Boolean).join('·')
    L.push(`**${c.name}** ${elProf ? `(${elProf})` : ''} · Lv.${c.level}${c.rarity ? ` · ${c.rarity}级` : ''} · ${c.mindscape}命`)
    if (c.weapon) {
      const extra = [
        c.weapon.main ? `基础攻 ${r0(c.weapon.main.value)}` : '',
        c.weapon.sub ? `${c.weapon.sub.name} ${c.weapon.sub.text}` : '',
      ].filter(Boolean).join(' · ')
      const wr = /^[SAB]$/.test(c.weapon.rarity) ? `${c.weapon.rarity}级` : c.weapon.rarity
      L.push(`　　⚔️ ${c.weapon.name} · 改造${c.weapon.refine} · Lv.${c.weapon.level} · ${wr}${extra ? ` · ${extra}` : ''}`)
    }
    const b = c.base || {}
    const pn = c.panel || b
    L.push(`　　📊 面板 生命 ${r0(pn.hp)} · 攻击 ${r0(pn.atk)} · 防御 ${r0(pn.def)} · 冲击力 ${r0(pn.impact)} · 暴击率 ${f1(pn.crit)}% · 暴击伤害 ${f1(pn.critDmg)}%`)
    const extra = []
    if (pn.pen) extra.push(`穿透率 ${f1(pn.pen)}%`)
    if (pn.energy) extra.push(`能量自动回复 ${f1(pn.energy)}%`)
    if (pn.mastery) extra.push(`异常掌控 ${r0(pn.mastery)}`)
    if (pn.proficiency) extra.push(`异常精通 ${r0(pn.proficiency)}`)
    if (pn.dmgBonus) extra.push(`伤害加成 ${f1(pn.dmgBonus)}%`)
    if (extra.length) L.push(`　　📊 ${extra.join(' · ')}`)
    L.push('　　📊 含音擎/驱动盘/套装 2·4 件；音擎被动与条件型套装效果未计入')
    if (c.skills && Object.keys(c.skills).length) {
      L.push(`　　🎯 技能 ${Object.entries(c.skills).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
    }
    const setTxt = Object.entries(c.sets).map(([k, v]) => `${v}× ${k}`).join(' + ') || '无'
    L.push(`　　🏺 驱动盘 ${setTxt}${c.discs.length ? `（${c.discs.length} 件）` : ''}`)
    L.push('')
  }
  return L.join('\n').trim()
}

/**
 * QQ 用的紧凑版：一条 ≤150 字的消息。
 * 为什么需要：dsh-qq-bridge 的「简短()」会把超过 160 字的回复截成 160 字 + …，
 * 长报告在 QQ 里只剩开头，所以这里直接压成「昵称 + 每人 评级+分数」的一行。
 */
export function renderCompact(m, limit = 150) {
  const gname = m.game === 'hsr' ? '星铁' : m.game === 'zzz' ? '绝区零' : '原神'
  const p = m.player
  const lvTxt = m.game === 'genshin' ? `AR${p.level}` : `Lv.${p.level}`
  const head = `🎮${gname} ${m.uid} ${p.nickname} ${lvTxt}`
  const items = m.chars.map((c) => `${c.name} Lv.${c.level}${c.mindscape || c.eidolon || c.constellation ? ` ${c.mindscape || c.eidolon || c.constellation}命` : ''}`)
  const build = (arr, tail) => `${head} · ${arr.join(' ')}${tail}`
  let line = build(items, '')
  while (line.length > limit && items.length > 2) {
    items.pop()
    line = build(items, ` …共${m.chars.length}人`)
  }
  if (line.length > limit) line = line.slice(0, limit - 1) + '…'
  return line
}

/**
 * 只留点名的角色：对方说了「看看甘雨」就只渲染甘雨。
 * names 支持逗号/顿号/空格分隔，按名字包含匹配（不分大小写）。
 * 返回的是浅拷贝，不改原 model。
 */
export function filterModelChars(model, names) {
  const 词们 = String(names || '')
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (!词们.length || !model || !Array.isArray(model.chars)) return model
  const 留下的 = model.chars.filter((c) => {
    const n = String(c.name || '').toLowerCase()
    return 词们.some((w) => n.includes(w) || w.includes(n))
  })
  return { ...model, chars: 留下的 }
}

export function renderReport(q, detail = true) {
  if (!q.ok) return q.text
  const head = q.empty
    ? `⚠️ ${q.note || '没拿到角色数据'}\n\n`
    : ''
  const body =
    q.model.game === 'hsr' ? renderHSR(q.model, detail)
      : q.model.game === 'zzz' ? renderZZZ(q.model, detail)
        : renderGenshin(q.model, detail)
  return head + body
}

/**
 * 把报告降级成纯文本 —— 发给 QQ 时用。QQ 不渲染 Markdown，`**` / 反引号 / `#`
 * 会原样露出来，所以出口处过一遍这里。
 */
export function toPlain(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/　　/g, '  ')
    .trim()
}

// ── 存档（仿 A.exe 的存档习惯：JSON + 一份人能读的 MD）────
export function archiveDir() {
  return join(process.env.DSH_GAME_UID_ARCHIVE || join(homedir(), '.dsh', 'game-uid-archive'))
}

export function writeArchive(model) {
  const dir = archiveDir()
  mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = join(dir, `${model.game}-${model.uid}-${ts}`)
  const json = {
    format: 'dsh-game-uid/1',
    queryAt: new Date().toISOString(),
    source: model.source,
    game: model.game,
    gameZh: model.gameZh,
    uid: model.uid,
    player: model.player,
    characters: model.chars.map((c) => ({
      name: c.name, level: c.level,
      constellation: c.constellation, eidolon: c.eidolon, mindscape: c.mindscape,
      talents: c.talents, traces: c.traces, skillsMain: c.skillsMain,
      weapon: c.weapon, lightCone: c.lightCone,
      stats: c.stats, baseStats: c.base, sets: c.sets,
      skills: c.skills, traces: c.traces, traceMax: c.traceMax,
      artifacts: c.artifacts, relics: c.relics, discs: c.discs,
    })),
  }
  writeFileSync(base + '.json', JSON.stringify(json, null, 2), 'utf8')
  writeFileSync(base + '.md', renderReport({ ok: true, model }, true) + '\n', 'utf8')
  return { json: base + '.json', md: base + '.md' }
}
