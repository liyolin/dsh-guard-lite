/**
 * Guard Lite — host half.
 *
 * Three guards that target the confirmed amplifier chain of long-session
 * degeneration (repeated system prompt, huge single prompt, unbounded steps):
 *
 * 1. Copy recycling — when a session's history already carries more than one
 *    system prompt copy, hand the loop `startsRequestSeries`, which switches
 *    its projection from "append another copy" to "replace the head and blank
 *    the rest". Blanked copies are dropped from the request entirely
 *    (`deriveEventMessage` returns null for an empty system message), so the
 *    request keeps exactly one copy from then on.
 *
 * 2. Repetition circuit breaker — a `reasoning-delta` stream that repeats the
 *    same short unit 20 times in a row is a loop, not writing. The attempt is
 *    aborted before it can burn thousands of characters and, worse, before the
 *    noise is committed to history and re-sent on every later step.
 *
 * 3. Health feed — per-session counters exposed as read-only JSON at
 *    `/guard-lite/state`, rendered by the Client half as a bottom status lamp.
 *
 * Everything here is observational except the two deliberate interventions, and
 * both of those are no-ops unless their trigger actually fires.
 */

export const name = 'guard-lite'

export const inject = ['webServer']

/** Longest repeated unit still treated as a loop rather than as prose. */
const MAX_UNIT = 8
/** Consecutive repeats that raise a warning in the lamp. */
const WARN_REPEAT = 8
/** Consecutive repeats that abort the attempt. */
const BREAK_REPEAT = 20
/** Sessions idle longer than this are dropped from the feed. */
const TTL_MS = 6 * 60 * 60 * 1000
/** Hard cap on tracked sessions, so a long-running host cannot grow forever. */
const MAX_SESSIONS = 200

/** A unit counts as repeatable only when it carries actual language. */
const REPEATABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]/u

const SESSIONS = new Map()

function stateOf(id) {
  const key = String(id)
  let state = SESSIONS.get(key)
  if (state === undefined) {
    if (SESSIONS.size >= MAX_SESSIONS) {
      const oldest = [...SESSIONS.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]
      if (oldest !== undefined) SESSIONS.delete(oldest[0])
    }
    state = {
      id: key,
      requests: 0,
      systemBlocks: 0,
      promptChars: 0,
      contextTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      repeatWarnings: 0,
      repeatHits: 0,
      recycleCount: 0,
      lastRepeat: null,
      lastWarnAt: 0,
      lastRecycleAt: 0,
      lastAt: 0,
    }
    SESSIONS.set(key, state)
  }
  return state
}

/** Rolling detector over one attempt's reasoning text. Returns 0, 1 (warn) or 2 (break). */
export class RepeatWatcher {
  constructor() {
    /* Enough tail to prove MAX_UNIT × BREAK_REPEAT characters are periodic. */
    this.tail = ''
    this.run = 0
    this.unit = ''
  }

  push(text) {
    if (text.length > 0) this.tail = (this.tail + text).slice(-(MAX_UNIT * (BREAK_REPEAT + 2)))
    if (this.tail.length < 2) {
      this.run = 0
      this.unit = ''
      return 0
    }
    let best = 0
    let bestUnit = ''
    for (let period = 1; period <= MAX_UNIT; period += 1) {
      const unit = this.tail.slice(-period)
      if (!REPEATABLE.test(unit)) continue
      let run = 1
      for (let end = this.tail.length - period; end - period >= 0; end -= period) {
        if (this.tail.slice(end - period, end) !== unit) break
        run += 1
      }
      if (run > best) {
        best = run
        bestUnit = unit
      }
    }
    this.run = best
    this.unit = bestUnit
    if (best >= BREAK_REPEAT) return 2
    if (best >= WARN_REPEAT) return 1
    return 0
  }
}

/** Record what one outgoing request carries, before any chunk arrives. */
function observeRequest(state, options) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  let blocks = options.system !== undefined && options.system.length > 0 ? 1 : 0
  let chars = options.system?.length ?? 0
  for (const message of messages) {
    if (message.role !== 'system') continue
    blocks += 1
    for (const block of message.content ?? []) {
      if (block.type === 'text') chars += block.text.length
    }
  }
  state.requests += 1
  state.lastAt = Date.now()
  /* Conversation requests carry the full history; assistant-title and similar
     side requests do not, so they must not overwrite the copy count. */
  if (messages.length >= 2) {
    state.systemBlocks = blocks
    state.promptChars = chars
  }
}

function recordUsage(state, usage) {
  const input = Number(usage?.inputTokens ?? 0)
  const cacheRead = Number(usage?.cacheReadTokens ?? 0)
  state.inputTokens = input
  state.cacheReadTokens = cacheRead
  state.contextTokens = input + cacheRead
  state.lastAt = Date.now()
}

/** Wrap one streaming attempt with the repetition breaker. */
async function* guardedStream(options, next) {
  const state = options.sessionId === undefined ? undefined : stateOf(options.sessionId)
  if (state !== undefined) observeRequest(state, options)
  let watcher
  let toolSeen = false
  for await (const chunk of next()) {
    if (chunk.type === 'usage') {
      if (state !== undefined) recordUsage(state, chunk.usage)
    }
    else if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') toolSeen = true
    else if (chunk.type === 'reasoning-delta') {
      watcher ??= new RepeatWatcher()
      const level = watcher.push(chunk.text)
      if (level === 1 && state !== undefined) {
        state.repeatWarnings += 1
        state.lastWarnAt = Date.now()
      }
      if (level === 2 && !toolSeen) {
        if (state !== undefined) {
          state.repeatHits += 1
          state.lastWarnAt = Date.now()
          state.lastRepeat = {
            at: Date.now(),
            unit: watcher.unit,
            run: watcher.run,
          }
        }
        const error = new Error(
          `guard-lite: reasoning repeated "${watcher.unit}" ${watcher.run} times; ` +
            'attempt aborted before the loop reached history. Retry, or start a fresh session if it recurs.',
        )
        error.code = 'REPETITION_GUARD'
        throw error
      }
    }
    yield chunk
  }
}

function statusOf(state, now) {
  const recentRepeat = state.lastRepeat !== null && now - state.lastRepeat.at < 120000
  const recentWarn = state.lastWarnAt > 0 && now - state.lastWarnAt < 120000
  if (recentRepeat || state.systemBlocks >= 4 || state.contextTokens >= 450000) return 'danger'
  if (recentWarn || state.systemBlocks >= 2 || state.contextTokens >= 300000) return 'warn'
  if (state.promptChars >= 60000) return 'watch'
  return 'ok'
}

function snapshot() {
  const now = Date.now()
  const rows = []
  for (const state of SESSIONS.values()) {
    if (now - state.lastAt > TTL_MS) continue
    rows.push({
      id: state.id,
      requests: state.requests,
      systemBlocks: state.systemBlocks,
      promptChars: state.promptChars,
      promptTokens: Math.round(state.promptChars / 1.47),
      contextTokens: state.contextTokens,
      inputTokens: state.inputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheHit: state.inputTokens + state.cacheReadTokens === 0
        ? null
        : state.cacheReadTokens / (state.inputTokens + state.cacheReadTokens),
      repeatWarnings: state.repeatWarnings,
      repeatHits: state.repeatHits,
      recycleCount: state.recycleCount,
      lastRepeat: state.lastRepeat,
      lastAt: state.lastAt,
      status: statusOf(state, now),
    })
  }
  rows.sort((a, b) => b.lastAt - a.lastAt)
  return {
    now,
    thresholds: {
      warnRepeat: WARN_REPEAT,
      breakRepeat: BREAK_REPEAT,
      promptCharsWatch: 60000,
      contextWarn: 300000,
      contextDanger: 450000,
      systemBlocksWarn: 2,
      systemBlocksDanger: 4,
    },
    sessions: rows.slice(0, 20),
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function apply(ctx) {  /* Guard 2: every streaming model call passes through here. */
  ctx.on('llm/stream', (options, next) => guardedStream(options, next))

  /* Guard 1: recycle prompt copies before the step is admitted. */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = stateOf(payload.agent.id)
    if (state.systemBlocks < 2) return decision
    state.recycleCount += 1
    state.lastRecycleAt = Date.now()
    return { ...decision, startsRequestSeries: true }
  })

  /* Guard 3: read-only feed consumed by the Client lamp. */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/guard-lite/state',
        resource: async () => jsonResponse(snapshot()),
      }),
    'guard-lite: state feed',
  )
}
