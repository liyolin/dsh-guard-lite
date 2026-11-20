/**
 * Offline checks for the Guard Lite repetition detector.
 * Run: node test-repeat.mjs
 */
import { RepeatWatcher } from './index.js'

function feed(chunks) {
  const watcher = new RepeatWatcher()
  let level = 0
  for (const chunk of chunks) level = Math.max(level, watcher.push(chunk))
  return { level, run: watcher.run, unit: watcher.unit }
}

function ok(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) process.exitCode = 1
}

/* 1. The real failure shape: "好。" repeated thousands of times in the log. */
const loop = feed(Array.from({ length: 30 }, () => '好。'))
ok(`循环「好。」x30 -> 熔断 (level=${loop.level}, run=${loop.run}, unit="${loop.unit}")`, loop.level === 2)

/* 2. Below the break threshold only warns. */
const warn = feed(Array.from({ length: 12 }, () => '好。'))
ok(`循环「好。」x12 -> 仅告警 (level=${warn.level}, run=${warn.run})`, warn.level === 1)

/* 3. Normal Chinese reasoning must never trip. */
const prose = feed([
  '用户想要给翻唱工具添加一个新的后端，',
  '我先看看 cover_ 系列工具在哪个仓库里，',
  '再决定是改 MCP 桥接还是改核心合成流程。',
  '另外需要注意 sample rate 的转换。',
])
ok(`正常中文思考 -> 不触发 (level=${prose.level}, run=${prose.run})`, prose.level === 0)

/* 4. Decorations and digits are not language; they must not trip. */
const rule = feed(Array.from({ length: 60 }, () => '====='))
ok(`符号串「=====」x60 -> 不触发 (level=${rule.level})`, rule.level === 0)

const digits = feed(Array.from({ length: 60 }, () => '2026-11-20 '))
ok(`纯数字日期 x60 -> 不触发 (level=${digits.level})`, digits.level === 0)

/* 5. English token loops are still language. */
const english = feed(Array.from({ length: 30 }, () => 'retry '))
ok(`英文循环「retry」x30 -> 熔断 (level=${english.level}, run=${english.run})`, english.level === 2)

/* 6. A period-4 cycle is caught exactly. */
const shortCycle = feed(Array.from({ length: 40 }, () => '跑做改好'))
ok(`四字轮换 x40 -> 熔断 (level=${shortCycle.level}, run=${shortCycle.run}, unit="${shortCycle.unit}")`, shortCycle.level === 2)

/* 7. Streaming in tiny deltas must behave like one big chunk. */
const streamed = feed(Array.from({ length: 40 }, () => '好。'))
ok(`流式「好。」逐 2 字符 x40 -> 熔断 (level=${streamed.level})`, streamed.level === 2)

/* 8. Recovery: prose after a warning resets the verdict. */
const watcher = new RepeatWatcher()
for (let i = 0; i < 12; i += 1) watcher.push('好。')
const warned = watcher.push('好。')
for (const text of ['然后我检查一下文档里的示例代码，', '确认返回值结构是否一致。']) watcher.push(text)
const recovered = watcher.push('好的')
ok(`告警后转入正常文本 -> 解除 (warned=${warned}, recovered=${recovered}, run=${watcher.run})`, recovered === 0)

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED')
