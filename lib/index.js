/**
 * lib/index.js —— DSH 插件入口：注册 `game_uid` 工具
 * ============================================================
 * 用法（对 agent 说）：查一下 UID 618285856 的练度
 *   → agent 调 game_uid({ uid: '618285856' }) → 返回中文练度报告
 * 数据源：原神 enka.network / 星铁 api.mihomo.me（公开只读，无需 token）
 * 装法见 README.md（桌面版 profile 手工装：dependencies + bundles + 重启）
 */
import { renderCompact, queryUid, renderReport, toPlain, writeArchive, archiveDir, filterModelChars } from './uid-core.mjs'
import { loadToolDeps } from './hostdeps.mjs'

export const name = 'game-uid'
/** 只有 tools 服务是必需的；别的服务缺了也不该让插件不激活 */
export const inject = ['tools']

const str = (v) => (v === undefined || v === null ? '' : String(v))

export async function apply(ctx) {
  const { defineTool, notes } = await loadToolDeps()
  for (const n of notes) ctx.logger?.info?.('[game-uid] ' + n)

  const tool = defineTool({
    name: 'game_uid',
    description:
      '查询原神 / 崩坏：星穹铁道 / 绝区零玩家的角色练度与数据（按 UID）；异环没有公开查号接口，会返回说明。' +
      '原神走 Enka、星铁走 mihomo、绝区零走 Enka ZZZ 的公开接口，返回每个展柜/支援角色的等级、命座/星魂、' +
      '天赋/行迹/技能、武器/光锥/音擎、汇总面板，以及圣遗物/遗器/驱动盘的套装构成。只展示汇总面板数值，不给单件词条，不打分、不评级、不评价。' +
      '用户说「查 UID / 看练度 / 这号怎么样 / 我的角色面板」时用它。' +
      '⚠️ QQ 群里有人 @ 你说「查询 <UID>」或只贴了个 9~10 位数字时也用这个工具回答，' +
      '并用 format=qq 输出一行紧凑版（QQ 那边会把超过 160 字的回复截断，所以别贴长报告）。' +
      '可用参数：uid（必填，9~10 位数字）、game（auto|genshin|hsr|zzz|nte，默认 auto 自动识别）、' +
      'detail（已弃用，无作用；工具只返回汇总面板）、' +
      'format（md|text|qq，默认 md；发到 QQ 用 qq：压缩成一行 ≤150 字，避免被 bridge 截断）、' +
      'save（true|false，是否落地存档文件 JSON+Markdown 到 ~/.dsh/game-uid-archive，默认 false）、'
      + '角色（可选，逗号分隔的角色名：对方点名叫你看某个/某几个角色时才传，只输出这些角色；没点名就不要传，四个都发）。',
    parameters: {
      uid: { type: 'string', required: true, description: '原神/星铁/绝区零的 UID，9~10 位数字' },
      game: { type: 'string', description: 'auto（默认）/ genshin / hsr / zzz / nte（异环，仅说明）' },
      detail: { type: 'string', description: '已弃用（无作用）；工具只返回汇总面板' },
      format: { type: 'string', description: 'md（默认，Markdown）/ text（纯文本）/ qq（一行紧凑版，发 QQ 用，≤150字）' },
      save: { type: 'string', description: 'true 时把结果存成存档文件（JSON + Markdown）' },
      '角色': { type: 'string', description: '只输出这些角色（逗号/顿号分隔）；不填则输出全部' },
      character: { type: 'string', description: '同 角色（英文别名）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '是否查到数据' },
          text: { type: 'string', description: '给用户看的练度报告（Markdown）' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.text || '（没有拿到内容）' }]
      },
    },
    async execute(args) {
      // ⭐ QQ 那边可能把 UID 当纯数字传来（也有人只贴一串数字），统一抽一串 9~10 位数字
      const rawUid = str(args?.uid).trim()
      // 原神/星铁 9~10 位、绝区零 8~10 位；从「查询 14658559」里抠出来时只认独立数字段
      const uid = /^\d{6,12}$/.test(rawUid)
        ? rawUid
        : (rawUid.match(/(?<!\d)\d{6,12}(?!\d)/) || [rawUid])[0]
      const gameArg = str(args?.game).trim().toLowerCase()
      const game = gameArg === 'genshin' || gameArg === 'genshin_impact' || gameArg === '原神'
        ? 'genshin'
        : gameArg === 'hsr' || gameArg === 'starrail' || gameArg === '星铁'
          ? 'hsr'
          : gameArg === 'zzz' || gameArg === 'zenless' || gameArg === '绝区零'
            ? 'zzz'
            : gameArg === 'nte' || gameArg === 'yihuan' || gameArg === '异环'
              ? 'nte'
              : 'auto'
      const detail = !(str(args?.detail).toLowerCase() === 'false' || str(args?.detail) === '0')
      const fmt = str(args?.format).trim().toLowerCase()
      const save = str(args?.save).toLowerCase() === 'true' || str(args?.save) === '1'

      if (!uid) return { ok: false, text: '给我一个 UID（9~10 位数字）我才能查。' }

      let q
      try {
        q = await queryUid(uid, game)
      } catch (error) {
        return { ok: false, text: `查询失败：${error?.message || error}` }
      }
      if (!q.ok) {
        const t = q.text || '查询失败'
        return { ok: false, text: fmt === 'text' || fmt === 'plain' || fmt === 'qq' ? toPlain(t) : t }
      }

      // ⭐ 点名了角色：只渲染那几个；没点名就全发
      const 点名 = str(args?.['角色'] || args?.character).trim()
      if (点名) {
        const 全部 = q.model.chars.length
        q = { ...q, model: { ...filterModelChars(q.model, 点名), charsTotal: 全部 } }
        if (!q.model.chars.length) {
          return { ok: false, text: `这个 UID 的展柜里没有「${点名}」（展柜共 ${全部} 个角色）。不点名我就把全部发出来。` }
        }
      }

      // ⭐ format=qq：压成 ≤150 字的一行，QQ 那侧（bridge 会把 >160 字截断）才看得全
      let text = fmt === 'qq' ? renderCompact(q.model) : renderReport(q, detail)
      // ⭐ 发给 QQ 时降级成纯文本：QQ 不渲染 Markdown，`**` 会原样露出来
      if (fmt === 'text' || fmt === 'plain') text = toPlain(text)
      if (save) {
        try {
          const files = writeArchive(q.model)
          text += `\n\n💾 存档已落地（${archiveDir()}）：\n· ${files.json}\n· ${files.md}`
        } catch (error) {
          text += `\n\n（存档失败：${error?.message || error}）`
        }
      }
      return { ok: true, text }
    },
  })

  ctx.tools.register(tool)
  ctx.logger?.info?.('[game-uid] game_uid 工具已注册')
}
