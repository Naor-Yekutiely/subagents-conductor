import { expect, test } from 'claude-code/testing'
import { conductorTop, firedLane, health, layoutFor, pose, shoutLine, shoutTarget, stage } from './register'
import type { Track } from '../types'

const NOW = 1_000_000
const t = (o: Partial<Track>): Track => ({ description: 'x', color: 0xa78bfa, status: 'running', startedAt: NOW - 30_000, phase: 'think', phaseAt: NOW, lastAt: NOW, tokens: 0, steps: 1, ...o })

test('health: working, waiting, stuck, zombie, done', () => {
  expect(health(t({}), NOW)).toBe('working')
  expect(health(t({ phase: 'tool', phaseAt: NOW - 120_000, lastAt: NOW - 120_000 }), NOW)).toBe('working')
  expect(health(t({ status: 'waiting', lastAt: NOW - 120_000 }), NOW)).toBe('waiting')
  expect(health(t({ lastAt: NOW - 90_000 }), NOW)).toBe('stuck')
  expect(health(t({ phase: 'tool', phaseAt: NOW - 400_000, lastAt: NOW - 400_000 }), NOW)).toBe('stuck')
  expect(health(t({ lastAt: NOW - 11 * 60_000 }), NOW)).toBe('zombie')
  expect(health(t({ doneAt: NOW, status: 'completed' }), NOW)).toBe('done')
  expect(health(t({ status: 'waiting', reply: 'slept 30s' }), NOW)).toBe('done')
  expect(health(t({ status: 'killed', doneAt: NOW }), NOW)).toBe('killed')
})

test('pose follows the tool', () => {
  const tool = (name: string) => pose(t({ phase: 'tool', tool: name }), 'working')
  expect(tool('Bash')).toBe('type')
  expect(tool('WebSearch')).toBe('search')
  expect(tool('Read')).toBe('read')
  expect(tool('Edit')).toBe('write')
  expect(pose(t({}), 'working')).toBe('think')
  expect(pose(t({}), 'waiting')).toBe('wait')
})

test('the conductor yells at live agents in turn', () => {
  expect(shoutTarget(['working', 'done', 'waiting'], 0)).toBe(0)
  expect(shoutTarget(['working', 'done', 'waiting'], 6)).toBe(2)
  expect(shoutTarget(['done'], 0)).toBe(-1)
  expect(shoutLine(0)).toBe('📣 faster!')
})

test('a stopped agent gets fired first, then the rotation resumes', () => {
  const list = [t({}), t({ status: 'killed', doneAt: NOW - 1_000 })]
  const hs = list.map(x => health(x, NOW))
  expect(firedLane(list, hs, NOW)).toBe(1)
  expect(firedLane(list, hs, NOW + 10_000)).toBe(-1)
  expect(shoutLine(0, true)).toBe("📣 you're fired!")
  expect(pose(list[1]!, 'killed')).toBe('killed')
})

test('a finished lane goes quiet once its reply has flowed back', () => {
  const lit = (t0: Track) => stage([t0], 1, NOW, layoutFor(false)).px.some(r => r.includes(0x7ab8ff))
  expect(lit(t({ status: 'completed', doneAt: NOW - 1_000, color: 0xa78bfa }))).toBe(true)
  expect(lit(t({ status: 'completed', doneAt: NOW - 10_000, color: 0xa78bfa }))).toBe(false)
  // one trip: early in it the dot is near the agent, never back at the start later
  const at = (ms: number) => {
    const px = stage([t({ status: 'completed', repliedAt: NOW - ms, doneAt: NOW - ms })], 0, NOW, layoutFor(true)).px
    return Math.max(...px.map(r => r.lastIndexOf(0x7ab8ff))) // the envelope's far end
  }
  expect(at(0)).toBeGreaterThan(20) // starts at the agent
  const front = (ms: number) => {
    const px = stage([t({ status: 'completed', repliedAt: NOW - ms, doneAt: NOW - ms })], 0, NOW, layoutFor(true)).px
    return Math.min(...px.map(r => r.indexOf(0x7ab8ff)).filter(x => x >= 0)) // the envelope's leading end
  }
  expect(front(3_900)).toBeLessThan(13) // arrives on the conductor's arm, past the bus
  // marked done by the engine later than the reply came: no second flow
  expect(lit(t({ status: 'completed', repliedAt: NOW - 10_000, doneAt: NOW - 500, color: 0xa78bfa }))).toBe(false)
})

test('the bus stays whole where a finished lane joins it', () => {
  const lay = layoutFor(true)
  const cv = stage([t({}), t({ status: 'completed', doneAt: NOW - 10_000 })], 0, NOW, lay)
  const busX = 13
  expect(cv.px[5]![busX]).not.toBe(null) // joints whole
  expect(cv.px[13]![busX]).not.toBe(null)
  for (const y of [5, 13]) {
    expect(cv.px[y]![lay.cols - 8]).toBe(0xa78bfa) // the figure starts right after the wire
  }
  expect([0x5f9e7f, 0xffd27a]).toContain(cv.px[5]![lay.cols - 9]) // connected: solid green, up to the figure, whatever the agent's colour
  expect(cv.px[13]![lay.cols - 9]).toBe(0x5a6070) // finished: grey and dashed, still reaching the figure
  expect(cv.px[13]![lay.cols - 10]).toBe(null)
})

test('the shout rides the whole route; the trunk greys out when all are finished', () => {
  const lay = layoutFor(true)
  const shoutAt = (frame: number) => {
    const px = stage([t({})], frame, NOW, lay).px
    return px.flatMap((r, y) => r.flatMap((c, x) => (c === 0xffd27a ? [[x, y]] : [])))
  }
  // over a few frames the shout is seen on the arm (left of the bus) and on the agent's wire (right of it)
  const xs = [0, 2, 4, 6, 8, 10].flatMap(f => shoutAt(f).map(([x]) => x!))
  expect(xs.some(x => x < 13)).toBe(true)
  expect(xs.some(x => x > 13)).toBe(true)
  const done = stage([t({ status: 'completed', doneAt: NOW - 10_000 })], 0, NOW, lay)
  expect(done.px.some(r => r.includes(0x5f9e7f))).toBe(false)
})

test('every connected agent has its own stream at the same time', () => {
  const lay = layoutFor(true)
  const lanesLit = (frame: number) => {
    const px = stage([t({}), t({}), t({ status: 'completed', doneAt: NOW - 10_000 })], frame, NOW, lay).px
    return [5, 13, 21].map(y => px[y]!.slice(14).includes(0xffd27a)) // right of the bus, on each lane's own wire
  }
  // within a short run of frames, both live lanes carry a message and the finished one never does
  const seen = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(lanesLit)
  expect(seen.some(l => l[0])).toBe(true)
  expect(seen.some(l => l[1])).toBe(true)
  expect(seen.some(l => l[2])).toBe(false)
  expect(seen.some(l => l[0] && l[1])).toBe(true) // at the same moment
})

test('the bus greys out along the stretch that only leads to finished agents', () => {
  const lay = layoutFor(true)
  // the conductor sits in the middle; top and bottom finished, middle working
  const px = stage([t({ status: 'completed', doneAt: NOW - 10_000 }), t({}), t({ status: 'completed', doneAt: NOW - 10_000 })], 1, NOW, lay).px
  const bus = (y: number) => px[y]![13]
  expect([0x5a6070]).toContain(bus(5)) // up to the finished top agent: grey
  expect([0x5f9e7f, 0xffd27a]).toContain(bus(13)) // to the working one: green
  expect([0x5a6070]).toContain(bus(21)) // down to the finished bottom agent: grey
})

test('a final reply is labelled and the conductor eyes flash as it arrives', async ($, on) => {
  const lay = layoutFor(true)
  const eyesBlue = (ms: number) => stage([t({ status: 'completed', repliedAt: NOW - ms, doneAt: NOW - ms })], 0, NOW, lay).px.some(r => r.slice(0, 11).includes(0x7ab8ff))
  expect(eyesBlue(500)).toBe(false) // still on its way
  expect(eyesBlue(3_600)).toBe(true) // arriving
  expect(eyesBlue(5_000)).toBe(false) // over
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e: any) => ({
    value: e.key === 'tracks' ? { value: { a: t({ description: 'Say hi', status: 'completed', reply: 'hi', repliedAt: NOW - 1_000, doneAt: NOW - 1_000 }) }, version: 1 } : e.key === 'size' ? { value: 'big', version: 1 } : { value: 4, version: 1 },
  }))
  const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } as any })
  expect(await ui.find({ type: 'Text', text: /📨 final reply → main/ })).toBeDefined()
})

test('the conductor is centred on a whole terminal row', () => {
  expect(conductorTop(layoutFor(true), 3)).toBe(8) // 24 px tall, 8 px art: rows 4..7 of 12
  expect(conductorTop(layoutFor(true), 1) % 2).toBe(0)
  expect(conductorTop(layoutFor(false), 3) % 2).toBe(0)
})

test('a lone lower half draws as ▄ on the default background, never ▀ over a default top', () => {
  const cv = stage([t({})], 0, NOW, layoutFor(false))
  const words = new Uint32Array(Uint8Array.from(atob(cv.cells(0, 2)), c => c.charCodeAt(0)).buffer)
  for (let i = 0; i < words.length; i += 3) {
    if (words[i] === 0x2580) expect(words[i + 1]).not.toBe(0x01000000) // ▀ always has a lit top
    if (words[i] === 0x2584) expect(words[i + 2]).toBe(0x01000000) // ▄ sits on the terminal's background
  }
  expect(words.some((w, i) => i % 3 === 0 && w === 0x2584)).toBe(true)
})

test('the stage draws under the hint line, big and small; its agents leave the list', async ($, on) => {
  let view = 'big'
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e: any) => ({
    value: e.key === 'tracks'
      ? { value: { a: t({ description: 'Run the tests', phase: 'tool', tool: 'Bash', action: 'Bash: npm test', model: 'claude-haiku-5-5', tokens: 12400 }), b: t({ description: 'Search logs', lastAt: NOW - 90_000, steps: 7 }) }, version: 1 }
      : e.key === 'size' ? { value: view, version: 1 } : { value: 4, version: 1 },
  }))
  const hint = () => $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } as any })

  const big = await hint()
  expect((await big.find({ type: 'Text', text: /💻/ }))?.text).toBe('💻 ') // its own lead cell, beside the figure
  expect(await big.find({ type: 'Text', text: /📣 faster!/ })).toBeDefined()
  expect(await big.find({ type: 'Text', text: /haiku-5-5 · 12\.4k tokens/ })).toBeDefined()
  expect(await big.find({ type: 'Text', text: /STUCK/ })).toBeDefined()
  expect((await big.find({ type: 'Raster', key: 'stage' }))?.props.rows).toBe(8)
  expect(await big.find({ type: 'Button', key: 'open-a' })).toBeDefined()
  expect(await big.find({ type: 'Button', key: 'open-main' })).toBeUndefined() // no main button on main
  await big.unmount()

  view = 'small'
  const small = await hint()
  expect((await small.find({ type: 'Raster', key: 'stage' }))?.props.rows).toBe(4)
  expect(await small.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  await small.unmount()
})

test('back to main shows above the prompt only while a subagent is open', async ($, on) => {
  on('state.get', (_, e: any) => ({ value: e.key === 'tracks' ? { value: { a: t({ description: 'Search logs' }) }, version: 1 } : { value: 0, version: 1 } }))
  const band = (view: object) => $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'AbovePrompt', props: { view, hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 5, bodyColumns: 80 } as any })
  const open = await band({ agentId: 'a' })
  expect(await open.find({ type: 'Button', key: 'back-to-main' })).toBeDefined()
  expect(await open.find({ type: 'Text', text: /Search logs/ })).toBeDefined()
  await open.unmount()
  const main = await band({})
  expect(await main.find({ type: 'Button', key: 'back-to-main' })).toBeUndefined()
})

test('stop and stop all call TaskStop for running agents only', async ($, on) => {
  const stopped: string[] = []
  on('tool.call', { tool: 'TaskStop' } as any, (_, e: any) => (stopped.push(e.task_id), { result: 'stopped' } as any))
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e: any) => ({
    value: e.key === 'tracks'
      ? { value: { a: t({ description: 'One' }), b: t({ description: 'Two', status: 'waiting' }), c: t({ description: 'Done', status: 'completed', doneAt: NOW - 1_000 }) }, version: 1 }
      : e.key === 'size' ? { value: 'big', version: 1 } : { value: 0, version: 1 },
  }))
  const ui = await $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: '' } as any })
  expect(await ui.find({ type: 'Button', key: 'stop-c' })).toBeUndefined() // a finished agent has nothing to stop
  await $.ui.press({ plugin: 'conductor', key: 'stop-a' })
  expect(stopped).toEqual(['a'])
  await $.ui.press({ plugin: 'conductor', key: 'stop-all' })
  expect(stopped).toEqual(['a', 'a', 'b'])
})

test('subagent rows stay hidden, even after their lane has cleared; teammates keep theirs', async ($, on) => {
  on('state.get', () => ({ value: { value: {}, version: 1 } })) // nothing on the stage any more
  const hidden: Record<string, boolean> = {}
  on('ui.render', { component: 'AgentRow', plugin: '*' } as any, (_, e: any, next: any) => ((hidden[e.requestId] = e.props.isHidden), next(e)))
  const row = (id: string, kind: string, status: string) =>
    $.ui.mount({ plugin: 'conductor', surface: 'terminal', component: 'AgentRow', requestId: id, props: { id, rowIds: [id], isHidden: false, description: id, type: 'general-purpose', status, kind, taskStatus: status, label: id, startTime: NOW, cwd: '/', tokenCount: 0, tokenSamples: [] } as any })
  await row('old', 'local_agent', 'killed')
  await row('mate', 'in_process_teammate', 'running')
  expect(hidden).toEqual({ old: true, mate: false })
})

test('/conductor toggles and remembers', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.set', (_, e: any) => { store[e.key] = e.value; return { value: undefined } })
  const r = await $.command.run({ command: 'conductor', args: 'small' } as any)
  expect(JSON.stringify(r)).toContain('small')
  expect(store.size).toBe('small')
})
