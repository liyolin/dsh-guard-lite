/**
 * Offline checks for the Guard Lite copy-recycling path.
 * Drives the real `apply()` with a stub context, feeds it one recorded
 * request, then asks the pre-step hook whether it would recycle.
 * Run: node test-recycle.mjs
 */
import { apply } from './index.js'

const listeners = new Map()
const ctx = {
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  effect(execute) {
    const dispose = execute()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  webServer: { register: () => () => {} },
}

apply(ctx)

const stream = listeners.get('llm/stream')
const preStep = listeners.get('agent/pre-step')

if (typeof stream !== 'function' || typeof preStep !== 'function') {
  console.log('FAIL  hooks were not registered')
  process.exit(1)
}

function ok(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) process.exitCode = 1
}

const EMPTY = async function* () {}

/** One full request: a fresh chat (messages empty → single top-level system). */
async function firstRequest(sessionId) {
  const options = {
    sessionId,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: 'S'.repeat(30000),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  for await (const _ of stream(options, () => EMPTY())) void _
}

/** One request whose history already carries a second system copy. */
async function appendRequest(sessionId) {
  const options = {
    sessionId,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: 'S'.repeat(30000),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'S'.repeat(30000) }] },
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ],
  }
  for await (const _ of stream(options, () => EMPTY())) void _
}

async function decisionOf(sessionId) {
  return preStep({ agent: { id: sessionId }, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
    kind: 'enter',
    messages: [],
  }))
}

const A = 'session-test-a'
await firstRequest(A)
const single = await decisionOf(A)
ok('只有 1 份副本 -> 不干预', single.kind === 'enter' && single.startsRequestSeries === undefined)

const B = 'session-test-b'
await firstRequest(B)
await appendRequest(B)
const copied = await decisionOf(B)
ok('出现 2 份副本 -> 触发回收 (startsRequestSeries)', copied.kind === 'enter' && copied.startsRequestSeries === true)

/* A rejected step must never be rewritten. */
const rejected = await preStep({ agent: { id: B }, turn: 1, step: 2, signal: new AbortController().signal }, async () => ({
  kind: 'reject',
}))
ok('reject 决策保持原样', rejected.kind === 'reject' && rejected.startsRequestSeries === undefined)

/* A side request (title generation) must not overwrite the conversation count. */
const C = 'session-test-c'
await firstRequest(C)
const sideOptions = { sessionId: C, provider: 'deepseek-official', model: 'deepseek-flash', system: 'title', messages: [] }
for await (const _ of stream(sideOptions, () => EMPTY())) void _
const afterSide = await decisionOf(C)
ok('旁路请求不改写副本计数', afterSide.startsRequestSeries === undefined)

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED')
