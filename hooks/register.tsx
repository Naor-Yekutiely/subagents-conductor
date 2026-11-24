import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Size, Track } from '../types'

const tracks = atom({ plugin: 'conductor', key: 'tracks' } as const, {} as Record<string, Track>)
const tick = atom({ plugin: 'conductor', key: 'tick' } as const, 0)
const size = atom({ plugin: 'conductor', key: 'size' } as const, 'big' as Size)

// The engine's interim report when an agent pauses on its own background work: not the real reply.
const INTERIM = /^This agent has not reported yet/

const STUCK_THINK_MS = 60_000 // no tokens moving while the model should be answering
const STUCK_TOOL_MS = 5 * 60_000 // a single tool call running this long
const ZOMBIE_MS = 10 * 60_000 // listed as live, nothing at all happening
const SHOW_DONE_MS = 5_000 // how long a finished agent stays after its reply
const BIG_MAX_LANES = 4
const SHOUT_FRAMES = 6 // the conductor yells at one agent for 6 ticks (3 s), then the next

const LIVE = new Set(['pending', 'running', 'waiting'])
const LIVE_HEALTH = new Set(['working', 'waiting', 'stuck', 'zombie']) // still running, so still stoppable

// 0x00RRGGBB; DEFAULT is the terminal's own color.
const DEFAULT = 0x01000000
const ORANGE = 0xd97757
const EYE = 0x1e1e1e
const WHITE = 0xf5f5f5
const GREY = 0x9aa0aa
const WIRE = 0x5a6070 // the trunk, and a finished agent's dashed wire
const WIRE_LIVE = 0x5f9e7f // an agent still connected
const SHOUT = 0xffd27a
const PACKET_BACK = 0x7ab8ff
const REPLY_FLOW_MS = 4_000 // the final reply travels back to the conductor this long, then the wire goes quiet
const RECEIVED_MS = 800 // the conductor's eyes flash this long as a reply arrives
const HEALTH = { working: 0x7bc96f, waiting: 0x56c2d6, stuck: 0xe5a50a, zombie: 0xe0525a, done: 0x7ab8ff, failed: 0xe0525a, killed: 0xe0525a } as const
const FIRE_MS = 4_000 // after Esc stops an agent, the conductor fires it this long
export type Health = keyof typeof HEALTH
// One colour per agent, kept for its whole run.
const PALETTE = [0xa78bfa, 0x4fc3f7, 0xf472b6, 0xfbbf24, 0x34d399, 0xfb923c, 0x60a5fa, 0xe879f9]
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

export function health(t: Track, now: number): Health {
  if (t.doneAt !== undefined) return t.status === 'completed' ? 'done' : t.status === 'killed' || t.status === 'stopped' ? 'killed' : 'failed'
  if (t.reply !== undefined && t.status === 'waiting') return 'done' // replied; the engine is only tidying its background work
  const idle = now - t.lastAt
  if (t.status === 'waiting') return idle > ZOMBIE_MS ? 'zombie' : 'waiting'
  if (idle > ZOMBIE_MS) return 'zombie'
  if (t.phase === 'tool') return now - t.phaseAt > STUCK_TOOL_MS ? 'stuck' : 'working'
  return idle > STUCK_THINK_MS ? 'stuck' : 'working'
}

export type Pose = 'type' | 'search' | 'read' | 'write' | 'think' | 'wait' | 'stuck' | 'zombie' | 'done' | 'killed'
const POSE_OF_TOOL: Record<string, Pose> = {
  Bash: 'type', PowerShell: 'type', Monitor: 'type', BashOutput: 'type',
  WebSearch: 'search', WebFetch: 'search', Grep: 'search', Glob: 'search', ToolSearch: 'search',
  Read: 'read', NotebookRead: 'read',
  Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write',
}
export function pose(t: Track, h: Health): Pose {
  if (h === 'killed') return 'killed'
  if (h === 'done' || h === 'failed') return 'done'
  if (h === 'zombie' || h === 'stuck') return h
  if (h === 'waiting') return 'wait'
  if (t.phase === 'think' || !t.tool) return 'think'
  return POSE_OF_TOOL[t.tool] ?? 'type'
}

// Pure emoji (no variation selector), so every terminal draws them two cells wide.
export const ICON: Record<Pose, string> = { type: '💻', search: '🔍', read: '📄', write: '📝', think: '💭', wait: '💤', stuck: '🚨', zombie: '🧟', done: '✅', killed: '💀' }
const SHOUTS = ['faster!', 'keep going!', 'results, please!', 'chop chop!', 'focus!', 'less thinking, more doing!']

// Which lane the conductor is yelling at: rotates over the live agents.
// An agent stopped in the last few seconds takes the conductor's attention first: it is being fired.
export function firedLane(list: Track[], hs: Health[], now: number): number {
  return list.findIndex((t, i) => hs[i] === 'killed' && now - (t.doneAt ?? 0) < FIRE_MS)
}
// Ms since an agent's final reply set off, while it is still travelling back; undefined otherwise.
export function replyFlight(t: Track, h: Health, now: number): number | undefined {
  if (h !== 'done' && h !== 'failed') return undefined
  const since = now - (t.repliedAt ?? t.doneAt ?? now)
  return since < REPLY_FLOW_MS ? since : undefined
}

export function shoutTarget(hs: Health[], frame: number): number {
  const live = hs.flatMap((h, i) => (h === 'working' || h === 'waiting' || h === 'stuck' ? [i] : []))
  return live.length ? live[Math.floor(frame / SHOUT_FRAMES) % live.length]! : -1
}
// Decoration only: the agent's name is on the next line, and nothing is sent to it.
export const shoutLine = (frame: number, fired = false) => `📣 ${fired ? "you're fired!" : SHOUTS[Math.floor(frame / SHOUT_FRAMES) % SHOUTS.length]}`

export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const arg = [i.command, i.file_path, i.pattern, i.url, i.query, i.description, i.prompt].find(v => typeof v === 'string') as string | undefined
  const short = name.replace(/^mcp__.+?__/, '')
  return arg ? `${short}: ${arg.replace(/\s+/g, ' ')}` : short
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// ── pixel canvas: two pixels per terminal cell ──
class Canvas {
  readonly px: (number | null)[][]
  constructor(readonly cols: number, readonly height: number) {
    this.px = Array.from({ length: height }, () => Array<number | null>(cols).fill(null))
  }
  put(x: number, y: number, c: number | null) {
    if (x >= 0 && x < this.cols && y >= 0 && y < this.height) this.px[y]![x] = c
  }
  sprite(lines: readonly string[], ox: number, oy: number, colors: Record<string, number | null>) {
    lines.forEach((line, y) => [...line].forEach((ch, x) => ch in colors && this.put(ox + x, oy + y, colors[ch]!)))
  }
  // Terminal cells for pixel rows [fromRow*2, (fromRow+rows)*2).
  cells(fromRow: number, rows: number, fromCol = 0, cols = this.cols - fromCol): string {
    const words = new Uint32Array(cols * rows * 3)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = fromCol + c
        const top = this.px[(fromRow + r) * 2]?.[x] ?? null
        const bot = this.px[(fromRow + r) * 2 + 1]?.[x] ?? null
        const o = (r * cols + c) * 3
        // A half with no pixel must stay the terminal's background, so draw the lit half alone.
        if (top === null && bot === null) words.set([0x20, DEFAULT, DEFAULT], o)
        else if (top === null) words.set([0x2584, bot!, DEFAULT], o) // ▄
        else words.set([0x2580, top, bot ?? DEFAULT], o) // ▀
      }
    return (new Uint8Array(words.buffer) as unknown as { toBase64(): string }).toBase64()
  }
}

// Sprites. o = orange, k = eye, m = mouth, c = the agent's colour, e = its eye.
const CONDUCTOR_SMALL = ['........b', '.ooooooo.', '.okoooko.', 'ooooooooo', '.ooooooo.', '.o.o.o.o.', '.o.o.o.o.']
const CONDUCTOR_BIG = [
  '..ooooooo..',
  '..okoooko..',
  '..oommmoo..',
  '..oonnnoo..',
  'ooooooooooo',
  'o.ooooooo.o',
  '..o.o.o.o..',
  '..o.o.o.o..',
]
const AGENT_SMALL = ['.ccc.', 'cecec', 'c.c.c']
const AGENT_SMALL_STEP = '.c.c.'
const AGENT_BIG = ['.cccc.', 'ceccec', 'cccccc', 'cccccc', '.c..c.', '.c..c.']

export type Layout = { big: boolean; laneRows: number; cols: number }
export const layoutFor = (big: boolean): Layout => (big ? { big, laneRows: 4, cols: 31 } : { big, laneRows: 2, cols: 21 })

const conductorArt = (layout: Layout) => (layout.big ? CONDUCTOR_BIG : CONDUCTOR_SMALL)
// The conductor's top pixel row: centred on the stage, rounded to an even row (a whole terminal row).
export const conductorTop = (layout: Layout, lanes: number) =>
  Math.max(0, Math.floor((lanes * layout.laneRows * 2 - conductorArt(layout).length) / 4) * 2)

export function stage(list: Track[], frame: number, now: number, layout: Layout): Canvas {
  const lanePx = layout.laneRows * 2
  const cv = new Canvas(layout.cols, list.length * lanePx)
  const hs = list.map(t => health(t, now))
  const fired = firedLane(list, hs, now)
  const target = fired >= 0 ? fired : shoutTarget(hs, frame)
  const yelling = target >= 0 && frame % 2 === 0

  const art = layout.big ? CONDUCTOR_BIG : CONDUCTOR_SMALL
  const cw = art[0]!.length
  const cy = conductorTop(layout, list.length) // centred, on a whole terminal row so it can stand in its own column
  // A reply arriving makes the conductor's eyes flash blue: it has received it.
  const receiving = list.some((t, i) => (replyFlight(t, hs[i]!, now) ?? -1) >= REPLY_FLOW_MS - RECEIVED_MS)
  cv.sprite(art, 0, cy, { o: ORANGE, k: receiving ? PACKET_BACK : EYE, m: yelling ? EYE : ORANGE, n: EYE, b: null })
  if (!layout.big) cv.put(8 - (frame % 2), cy + (frame % 2), WHITE) // baton

  const busX = cw + (layout.big ? 2 : 1)
  const agentW = layout.big ? 9 : 5
  const agentX = layout.cols - agentW
  const armY = cy + (layout.big ? 4 : 3)
  const mid = (lane: number) => lane * lanePx + (layout.big ? 5 : 1)
  // Green only where it still leads to a working agent: the arm while any is, each stretch of the bus while
  // a working agent lies beyond it, counting out from the arm.
  const live = hs.map(h => h !== 'done' && h !== 'failed' && h !== 'killed')
  const leadsToLive = (y: number) => live.some((l, i) => l && Math.min(armY, mid(i)) <= y && y <= Math.max(armY, mid(i)))
  for (let x = cw; x <= busX; x++) cv.put(x, armY, live.some(Boolean) ? WIRE_LIVE : WIRE)
  if (list.length) for (let y = Math.min(armY, mid(0)); y <= Math.max(armY, mid(list.length - 1)); y++) cv.put(busX, y, leadsToLive(y) ? WIRE_LIVE : WIRE)
  const end = agentX + (layout.big ? 1 : 0) // the big figure stands one pixel in
  // The whole route from the conductor to an agent: out along the arm, along the bus, down its wire.
  const route = (lane: number): [number, number][] => {
    const y = mid(lane)
    const pts: [number, number][] = []
    for (let x = cw; x < busX; x++) pts.push([x, armY])
    for (let yy = armY; yy !== y; yy += Math.sign(y - armY)) pts.push([busX, yy])
    for (let x = busX; x < end; x++) pts.push([x, y])
    return pts
  }
  const ride = (pts: [number, number][], at: number, len: number, c: number) => {
    for (let k = 0; k < len; k++) {
      const pt = pts[(at + k) % pts.length]
      if (pt) cv.put(pt[0], pt[1], c)
    }
  }

  list.forEach((t, i) => {
    const y = mid(i)
    const h = hs[i]!
    const finished = h === 'done' || h === 'failed' || h === 'killed'
    // From beside the bus (the joint stays whole) to the agent's body.
    // Connected: solid green. Finished: grey and dashed, disconnected but still whole.
    for (let x = busX + 1; x < end; x++) if (!finished) cv.put(x, y, WIRE_LIVE)
    else if ((end - x) % 2 === 1) cv.put(x, y, WIRE)
  })
  // Messages ride over the wires, drawn after them all so the bus never covers one.
  list.forEach((t, i) => {
    const h = hs[i]!
    const pts = route(i)
    if (i === fired) ride(pts, frame * 3, 3, HEALTH.killed) // the kill order
    else if (h === 'done' || h === 'failed') {
      // One trip back into the conductor, placed by time since the reply, then nothing.
      const since = replyFlight(t, h, now)
      if (since !== undefined) ride([...pts].reverse(), Math.floor((since / REPLY_FLOW_MS) * (pts.length - 2)), 3, PACKET_BACK) // a 3-pixel envelope
    } else if (h !== 'killed') ride(pts, frame * 2 + i * 5, 2, SHOUT) // every connected agent has its own stream, staggered
  })

  list.forEach((t, i) => {
    const h = hs[i]!

    const top = i * lanePx
    const p = pose(t, h)
    const body = p === 'zombie' ? 0x6b6b6b : p === 'killed' ? 0x4a4a4a : t.color
    const eye = p === 'zombie' || p === 'killed' ? HEALTH.zombie : p === 'wait' ? body : EYE
    if (!layout.big) {
      const blink = p !== 'wait' && h === 'working' && (frame + i) % 6 === 0
      const legs = h === 'working' && frame % 2 === 0
      cv.sprite(legs ? [AGENT_SMALL[0]!, AGENT_SMALL[1]!, AGENT_SMALL_STEP] : AGENT_SMALL, agentX, top, { c: body, e: blink ? body : p === 'stuck' ? HEALTH.stuck : eye })
      return
    }
    drawBigAgent(cv, agentX, top, p, body, eye, frame + i)
  })
  return cv
}

function drawBigAgent(cv: Canvas, ox: number, oy: number, p: Pose, body: number, eye: number, f: number) {
  const by = oy + 2 // rows oy..oy+1 stay clear so lanes don't touch
  const active = p === 'type' || p === 'search' || p === 'read' || p === 'write' || p === 'think'
  cv.sprite(AGENT_BIG, ox + 1, by, { c: body, e: active && f % 6 === 0 ? body : p === 'stuck' ? HEALTH.stuck : eye })
  if (active && f % 2 === 0) cv.sprite(['c....c', '.c..c.'], ox + 1, by + 4, { c: body, '.': null }) // legs step
  if (p === 'done') {
    cv.put(ox + 1, by - 1, body) // arms up
    cv.put(ox + 6, by - 1, body)
  }
}

const CHIP: Record<Health, string> = { working: 'working', waiting: 'waiting', stuck: 'STUCK', zombie: 'ZOMBIE?', done: 'done', failed: 'failed', killed: '✖ killed' }

export function activity(t: Track, h: Health, now: number): string {
  if (h === 'killed') return 'stopped by you'
  if (h === 'done' || h === 'failed') return `↩ ${t.reply ?? t.status}`
  if (h === 'waiting') return 'waiting on its background work'
  if (h === 'zombie') return `no activity for ${age(now - t.lastAt)}`
  if (h === 'stuck') return `no progress for ${age(now - (t.phase === 'tool' ? t.phaseAt : t.lastAt))} · ${t.action ?? 'thinking'}`
  if (t.phase === 'tool' && t.action) return `${t.action}  (${age(now - t.phaseAt)})`
  return 'thinking…'
}

type Dollar = Parameters<typeof update>[0]

// Stopping goes through Claude Code's own TaskStop tool (the same one Esc in an agent's view uses), so it is
// checked and recorded like any tool call. A refusal is shown, never swallowed.
export async function stopAgents($: { tool: { call: (i: { tool: 'TaskStop'; task_id: string }) => Promise<unknown> }; ui: { toast: (text: string) => unknown } }, ids: string[]) {
  for (const id of ids) {
    const r = (await $.tool.call({ tool: 'TaskStop', task_id: id })) as { deny?: string; isError?: boolean; text?: string } | undefined
    if (r?.deny || r?.isError) void $.ui.toast(`Could not stop ${id}: ${r.deny ?? r.text ?? 'refused'}`)
  }
}
const patch = ($: Dollar, id: string, f: (t: Track) => Track) =>
  update($, tracks, p => {
    const t = p[id]
    return t ? { ...p, [id]: f(t) } : p
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'conductor', description: 'Subagent stage under the prompt: big or small', argumentHint: 'big|small' })
    const saved = await $.store.get('size')
    if (saved === 'big' || saved === 'small') await update($, size, () => saved)

    // Heartbeat: picks up agents, their status, token movement (the model is alive), and drives the animation.
    $.clock.every(500, () => {
      void (async () => {
        const now = await $.clock.now()
        const agents = (await $.agent.list()).filter(a => a.kind === 'local_agent')
        let visible = false
        await update($, tracks, prev => {
          const out: Record<string, Track> = {}
          for (const a of agents) {
            const t = prev[a.id]
            if (!t && !LIVE.has(a.status)) continue
            const used = [...Object.values(prev), ...Object.values(out)].map(x => x.color)
            const color = PALETTE.find(c => !used.includes(c)) ?? PALETTE[Object.keys(out).length % PALETTE.length]!
            const base: Track = t ?? { description: a.description, color, status: a.status, startedAt: a.startTime, phase: 'think', phaseAt: a.startTime, lastAt: a.startTime, tokens: 0, steps: 0 }
            const doneAt = LIVE.has(a.status) ? undefined : (base.doneAt ?? now)
            // Counted from the reply when there is one: the engine may mark it done much later, after tidying up.
            const finishedAt = base.repliedAt ?? doneAt
            if (finishedAt !== undefined && (doneAt !== undefined || base.reply !== undefined) && now - finishedAt > SHOW_DONE_MS) continue
            const moved = a.tokenCount !== base.tokens
            out[a.id] = { ...base, status: a.status, model: a.model, tokens: a.tokenCount, lastAt: moved ? now : base.lastAt, doneAt }
          }
          visible = Object.keys(out).length > 0
          return out
        })
        if (visible) await update($, tick, n => n + 1)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'conductor' }, async ($, e) => {
    const want = e.args.trim()
    const now = await read($, size)
    const next: Size = want === 'big' || want === 'small' ? want : now === 'big' ? 'small' : 'big'
    await update($, size, () => next)
    await $.store.set('size', next)
    return { text: `Conductor: ${next} view (remembered).` }
  })

  // Each model step of a subagent: "thinking" while it streams, then the tool it chose.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (!id) return yield* next(e)
    const start = await $.clock.now()
    await patch($, id, t => ({ ...t, phase: 'think', phaseAt: start, lastAt: start, steps: t.steps + 1 }))
    const result = yield* next(e)
    const end = await $.clock.now()
    const use = result.toolUses.at(-1)
    await patch($, id, t => {
      const action = use ? describeTool(use.name, use.input) : t.action
      return { ...t, phase: use ? 'tool' : 'think', phaseAt: end, lastAt: end, tool: use?.name ?? t.tool, action, prevAction: action !== t.action ? t.action : t.prevAction }
    })
    return result
  })

  // Keep the reply only; whether it is done comes from the agent list (an interim report is not the end).
  on('agent.report', async ($, e, next) => {
    const reply = e.text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
    if (!INTERIM.test(reply)) {
      const now = await $.clock.now()
      await patch($, e.agentId, t => ({ ...t, reply, repliedAt: now }))
    }
    return next(e)
  })

  // The agent list draws a bullet before every row, so the stage is drawn as one block under the prompt's
  // hint line instead, and the rows it shows hide themselves (/tasks still lists and manages them).
  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    // Every subagent, running or long finished: live ones are on the stage, and finished ones linger in Claude
    // Code's list after their lane clears. Teammates are not on the stage, so they keep their rows.
    if (e.surface !== 'terminal' || e.props.kind !== 'local_agent') return next(e)
    return next({ ...e, props: { ...e.props, isHidden: true } })
  })

  // The band above the prompt is the one place that knows which transcript is on screen, so the way back lives
  // there, shown only while a subagent's transcript is open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    if (!id) return next(e)
    const t = (await read($, tracks))[id]
    const name = t?.description ?? (await $.agent.list()).find(a => a.id === id)?.description ?? 'a subagent'
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Button key="back-to-main" variant="primary" onPress={() => void $.ui.view({})}>
          ◀ back to main
        </Button>
        <Text dimColor>   viewing: </Text>
        <Text bold color={t ? hex(t.color) : undefined}>{name}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    if (e.surface !== 'terminal') return hint
    const all = await read($, tracks)
    // Oldest first, fixed: the agent list's own order moves as agents work.
    const entries = Object.entries(all).sort(([a, x], [b, y]) => x.startedAt - y.startedAt || a.localeCompare(b))
    const list = entries.map(([, t]) => t)
    if (!list.length) return hint

    const frame = await read($, tick)
    const want = await read($, size)
    const roomy = !e.viewport || e.viewport.rows >= list.length * 4 + 14
    const layout = layoutFor(want === 'big' && list.length <= BIG_MAX_LANES && roomy)
    const now = await $.clock.now()
    const hs = list.map(t => health(t, now))
    const fired = firedLane(list, hs, now)
    const target = fired >= 0 ? fired : shoutTarget(hs, frame)
    const rows = list.length * layout.laneRows
    const cv = stage(list, frame, now, layout)
    const { Box, Button, Raster, Text } = $.ui.resolve(e)

    const liveIds = entries.flatMap(([id], i) => (LIVE_HEALTH.has(hs[i]!) ? [id] : []))
    const lines = entries.flatMap(([id, t], i) => {
      const hl = hs[i]!
      const chip = hex(HEALTH[hl])
      const title = (
        <Box flexDirection="row">
          {/* Clicking the name opens the agent's transcript, as its row in the agent list did. */}
          <Button key={`open-${id}`} plain onPress={() => void $.ui.view({ agentId: id })}>
            <Text bold color={hex(t.color)}>{t.description}</Text>
          </Button>
          <Text wrap="truncate">
            <Text color={chip}>  ● {CHIP[hl]}</Text>
            <Text dimColor>  {age((t.doneAt ?? now) - t.startedAt)}  </Text>
          </Text>
          {LIVE_HEALTH.has(hl) && (
            <Button key={`stop-${id}`} onPress={() => void stopAgents($, [id])}>
              <Text color={hex(HEALTH.killed)}>✖ stop</Text>
            </Button>
          )}
        </Box>
      )
      const doing = (
        <Text wrap="truncate">
          <Text>{activity(t, hl, now)}</Text>
          <Text dimColor>  · step {t.steps}</Text>
        </Text>
      )
      // Every line gets the same 3-cell lead; the one at the figure's hands holds its emoji.
      const lead = (line: ReturnType<typeof Text>, held: boolean) => (
        <Box flexDirection="row">
          <Text>{held ? `${ICON[pose(t, hl)]} ` : '   '}</Text>
          {line}
        </Box>
      )
      if (!layout.big) return [lead(title, true), lead(doing, false)]
      const shout =
        replyFlight(t, hl, now) !== undefined ? (
          <Text color={hex(PACKET_BACK)} wrap="truncate">📨 final reply → main</Text>
        ) : i === target ? (
          <Text color={hex(SHOUT)} wrap="truncate">{shoutLine(frame, i === fired)}</Text>
        ) : (
          <Text> </Text>
        )
      const detail = (
        <Text wrap="truncate" dimColor>
          {'   '}
          {[t.model?.replace(/^claude-/, ''), `${kTokens(t.tokens)} tokens`, t.prevAction && `prev step: ${t.prevAction}`].filter(Boolean).join(' · ')}
        </Text>
      )
      return [lead(shout, false), lead(title, false), lead(doing, true), lead(detail, false)]
    })

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="row" marginTop={1}>
          <Text dimColor>click a name to open its transcript  </Text>
          {liveIds.length > 1 && (
            <Button key="stop-all" onPress={() => void stopAgents($, liveIds)}>
              <Text color={hex(HEALTH.killed)}>✖ stop all ({liveIds.length})</Text>
            </Button>
          )}
        </Box>
        <Box flexDirection="row">
          <Raster key="stage" columns={layout.cols} rows={rows} cells={cv.cells(0, rows)} />
          <Box flexDirection="column" flexGrow={1}>
            {lines}
          </Box>
        </Box>
      </Box>
    )
  })
}
