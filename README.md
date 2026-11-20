# Guard Lite

**一个防退化的守卫，不是省 token 的工具。**

Harness 的长会话跑到一定规模会出现两种坏形态：同一份 system prompt 在历史里堆成十几份、
reasoning 卡在一个字上抽搐几万次。Guard Lite 只管这两件事——把重复副本压回一份、在复读刚
冒头时掐断，并在会话底部亮一个灯告诉你现在处在哪一档。

A degeneration guard for long Harness sessions. **It is not a token-saving plugin.**

```bash
git clone https://github.com/liyolin/dsh-guard-lite.git
```

然后在 Harness 里对这个目录执行 `plugin_manager` 的 `install_bundle`，target 指向 clone 下来的路径。
`plugin_manager` 会把它 link 进当前 profile 并激活，不需要发布到 npm。

## 先澄清一个误解：这不是省 token 的插件

下文会出现的 **31.2%** 指的是**请求体量**，不是账单。

- 那个会话一共发送 558,110,929 token，其中 **99.0% 是缓存命中**（cacheRead），按 1/10 计价
- 换算成钱，回收副本省下的是**等效全价 token 的约 10%**
- 而那一份 prompt 自己每步重传的成本，也只占总账的 10%；真正的 90% 是历史（工具结果 197 万字符、reasoning 137 万字符、工具参数 171 万字符）

它真正想要的收益，按重要性排：

1. **不让会话退化** —— 上下文里「重复的大块」是当时全量体检里唯一和时间强相关的因子，
   而 prompt 总量 30 万以下的会话几乎不出事
2. **不让一次抽搐变成永久债务** —— 抽搐内容一旦进了历史，后面每一步都要带着它重传
3. **抢回上下文窗口** —— 峰值从 56 万压回 34 万，离压缩线更远

省 token 只是副作用，而且量级有限。真要省钱，**关掉 PTC（单份 prompt −67%）、减少每轮步数、
收紧工具输出阈值**，任何一条都比这个插件有效得多。

## 它防的是什么

对一个 2,344 步的会话做过全量日志复算（下表数字是**请求体量**，不是账单）：

| 现象 | 实测 |
|---|---|
| system prompt 在历史里累积 16–18 份 | 这些副本占请求体量的 31.2% |
| 上下文峰值 | 559,694 token（其中约 24 万是重复副本） |
| 单次 reasoning 抽搐 | 26,881 字符（连续 3,908 次「好。」） |
| 步数 | 无上限，单轮跑到过 592 步 |

三条防线分别对准这三条：

### 1. 副本回收

`agent/pre-step` 读到「历史里 system 消息 ≥ 2 份」时返回 `startsRequestSeries: true`，
让 loop 的投影从 **append** 切到 **replace**：替换 head、清空其余副本。
被清空的副本在 `deriveEventMessage` 里返回 `null`，根本不进请求。

按实测，这一步能把该会话的请求体量减掉 31%、上下文峰值从 56 万回到约 34 万。

### 2. 复读熔断

`llm/stream` 包住每一次模型调用，对 `reasoning-delta` 做最小周期检测：
找到 ≤ 8 字符的周期，连续重复 **≥ 20 次**就中止本次 attempt。

- 只作用于 `reasoning-delta`；`text-delta` 不碰（写代码时 `=====` 是正常内容）
- 一旦出现 `tool-call` 块就不再熔断，避免切坏半截工具调用
- 纯符号、纯数字不算语言，不触发

### 3. 状态灯

会话底部（`conversation.composer.dock`）一个圆点，**跟着当前会话走**，单击展开面板：

```
● 正常   → 副本 1 份、无复读、上下文健康
● 注意   → 单份 prompt ≥ 6 万字符
● 警告   → 副本 ≥ 2 份，或上下文 ≥ 30 万
● 危险   → 副本 ≥ 4 份，或上下文 ≥ 45 万，或 2 分钟内熔断过
● 待命   → 这个会话还没有任何请求记录（刚装插件、或刚开的新会话）
```

面板里给出副本数、单份字符/token、上下文、缓存命中率、请求数、回收次数、告警/熔断次数，
以及一句人能读懂的结论。**每个会话独立**：切换会话时灯会换成那个会话的状态，不会串。

## 阈值

目前是常量，改 `index.js` 顶部后重装：

```js
const MAX_UNIT = 8         // 参与判定的最长周期
const WARN_REPEAT = 8      // 告警
const BREAK_REPEAT = 20    // 熔断
```

回收触发条件在 `apply()` 里：`state.systemBlocks >= 2`。

## 已知限制

1. **不要指望它省钱** —— 见上文，钱上约 10% 量级。它治「退化」，不治「成本」。
2. **回收滞后一次变化** —— 内核在 `rendered` 与最新副本相同时直接返回空，所以只有 prompt
   真的变了那一步才清空旧副本。表现为：切模型后 `systemBlocks` 先到 2，下一次变化时归 1。
3. **熔断是 abort 语义** —— 触发时这一轮 turn 报错结束。要「悄悄收尾」需改成吞 delta + 伪造
   `finish: stop`，但截断带 tool-call 的流会让后续 step 拿到半截状态。
4. **不解决根因** —— 单份 prompt 的体积（PTC 的 `tools:sdk` 段）和步数上限都不在本插件职责内。

## 自检

```bash
node test-repeat.mjs    # 复读检测器：循环/告警/正常文本/符号串/英文/四字轮换/流式/解除
node test-recycle.mjs   # 回收决策：1 份不干预、2 份触发、reject 不动、旁路请求不改计数
```

都不需要调用模型。

## 注意

`/guard-lite/state` 是只读诊断端点，靠 Harness 自身的连接鉴权把守，插件没有再额外判权限。
返回内容是会话 id 前 8 位与用量指标（副本数、字符数、token 数、命中率），**不含对话正文**。
如果你把 Harness 暴露到局域网或公网（remote access），这个端点会随之可达。

## 目录

```
index.js            Host 半边：两条干预 + 状态计数 + /guard-lite/state
client.js           底部状态灯与详情面板
cordis.patch.yml    bundle 行：id guard-lite
locale/{zh,en}.json 插件页显示名与描述
```
