# Guard Lite

DeepSeek Harness 插件：**回收重复的 system prompt 副本**、**熔断 reasoning 复读**、并在会话底部用**状态灯**实时显示健康度。

A Harness plugin that recycles duplicate system-prompt copies, breaks reasoning repetition loops, and shows a live health lamp under the composer.

```bash
git clone https://github.com/liyolin/dsh-guard-lite.git
```

然后在 Harness 里对这个目录执行 `plugin_manager` 的 `install_bundle`，target 指向 clone 下来的路径。
`plugin_manager` 会把它 link 进当前 profile 并激活，不需要发布到 npm。

## 它解决什么

长会话退化不是随机的。对一个 2,344 步的会话做过全量日志复算：

| 现象 | 实测 |
|---|---|
| system prompt 在历史里累积 16–18 份 | 每步全量重传，占总发送量 **31.2%** |
| 上下文峰值 | 559,694 token（其中 24 万是重复副本） |
| 单次 reasoning 抽搐 | 26,881 字符（连续 3,908 次「好。」） |
| 步数 | 无上限，单轮跑到 592 步 |

三个守卫分别对准这三条：

### 1. 副本回收

`agent/pre-step` 读到「历史里 system 消息 ≥ 2 份」时返回 `startsRequestSeries: true`，
让 loop 的投影从 **append** 切到 **replace**：替换 head、清空其余副本。
被清空的副本在 `deriveEventMessage` 里返回 `null`，根本不进请求。

按实测，这一步能把发送量砍掉 31%、上下文峰值从 56 万压到约 34 万。

### 2. 复读熔断

`llm/stream` 包住每一次模型调用，对 `reasoning-delta` 做最小周期检测：
找到 ≤ 8 字符的周期，连续重复 **≥ 20 次**就中止本次 attempt。

- 只作用于 `reasoning-delta`；`text-delta` 不碰（写代码时 `=====` 是正常内容）
- 一旦出现 `tool-call` 块就不再熔断，避免切坏半截工具调用
- 纯符号、纯数字不算语言，不触发

### 3. 状态灯

会话底部（`conversation.composer.dock`）一个圆点，单击展开面板：

```
● 正常   → 副本 1 份、无复读、上下文健康
● 注意   → 单份 prompt ≥ 6 万字符
● 警告   → 副本 ≥ 2 份，或上下文 ≥ 30 万
● 危险   → 副本 ≥ 4 份，或上下文 ≥ 45 万，或 2 分钟内熔断过
```

面板里给出副本数、单份字符/token、上下文、缓存命中率、请求数、回收次数、告警/熔断次数，
以及一句人能读懂的结论。

## 阈值

目前是常量，改 `index.js` 顶部后重装：

```js
const MAX_UNIT = 8         // 参与判定的最长周期
const WARN_REPEAT = 8      // 告警
const BREAK_REPEAT = 20    // 熔断
```

回收触发条件在 `apply()` 里：`state.systemBlocks >= 2`。

## 已知限制

1. **回收滞后一次变化**。内核在 `rendered` 与最新副本相同时直接返回空，所以只有 prompt
   真的变了那一步才清空旧副本。表现为：切模型后 `systemBlocks` 先到 2，下一次变化时归 1。
2. **熔断是 abort 语义**：触发时这一轮 turn 报错结束。要「悄悄收尾」需改成吞 delta + 伪造
   `finish: stop`，但截断带 tool-call 的流会让后续 step 拿到半截状态。
3. **不解决根因**：单份 prompt 的体积（PTC 的 `tools:sdk` 段）和步数上限都不在本插件职责内。

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
