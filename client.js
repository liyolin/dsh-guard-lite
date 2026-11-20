window.__ModuleLoader__.load({
  id: 'dsh-guard-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const POLL_MS = 2000
    const FEED = '/guard-lite/state'

    const TONE = {
      ok: { color: 'var(--dsw-alias-state-success-primary)', label: '正常' },
      watch: { color: 'var(--dsw-alias-label-tertiary)', label: '注意' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', label: '警告' },
      danger: { color: 'var(--dsw-alias-state-error-primary)', label: '危险' },
      idle: { color: 'var(--dsw-alias-state-idle-primary)', label: '待命' },
    }

    const shortId = (id) => {
      const text = String(id ?? '')
      const tail = text.startsWith('session-') ? text.slice(8) : text
      return tail.slice(0, 8)
    }
    const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—')
    const num = (v) => (typeof v === 'number' && v > 0 ? v.toLocaleString('en-US') : '0')
    const clock = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toLocaleTimeString() : '—')

    function Row({ label, value, tone }) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 18, padding: '3px 0', fontSize: 12 } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h(
          'span',
          {
            style: {
              color: tone ?? 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 500,
            },
          },
          value,
        ),
      )
    }

    function verdict(state) {
      if (state === undefined) return '本会话尚无请求记录。发出一次消息后开始观测。'
      if (state.lastRepeat) {
        return `复读熔断已触发 ${state.repeatHits} 次，最近一次单元为「${state.lastRepeat.unit}」重复 ${state.lastRepeat.run} 遍。`
      }
      if (state.systemBlocks >= 2) {
        return `历史里存有 ${state.systemBlocks} 份 system prompt，每一步都在重传；下一次 prompt 变化会触发回收，压回 1 份。`
      }
      if (state.contextTokens >= 300000) {
        return '上下文已过 30 万 token，单份 prompt 不算大但历史很长；建议收紧工具输出或换新会话。'
      }
      return '只有 1 份 system prompt，未检出复读，指标在安全区内。'
    }

    function Panel({ state, feed, error, onClose, onRefresh }) {
      const tone = TONE[state?.status ?? 'idle'] ?? TONE.idle
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 52,
            width: 364,
            maxHeight: '60vh',
            overflow: 'auto',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
            padding: '12px 14px',
            zIndex: 60,
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', {
            style: {
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: tone.color,
              boxShadow: `0 0 10px ${tone.color}`,
            },
          }),
          h('strong', { style: { fontSize: 13 } }, 'Guard Lite'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, `· ${tone.label}`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: onRefresh,
              title: '立即刷新',
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: 6,
                padding: '2px 7px',
                fontSize: 11,
                cursor: 'pointer',
              },
            },
            '刷新',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onClose,
              title: '关闭',
              style: {
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary)',
                fontSize: 14,
                cursor: 'pointer',
                lineHeight: 1,
                padding: '0 2px',
              },
            },
            '×',
          ),
        ),
        h(
          'div',
          { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 8 } },
          state ? `会话 ${shortId(state.id)} · 更新于 ${clock(state.lastAt)}` : '未取到该会话状态',
        ),
        state
          ? h(
              'div',
              null,
              h(Row, {
                label: 'system prompt 副本',
                value: `× ${state.systemBlocks}`,
                tone: state.systemBlocks >= 2 ? 'var(--dsw-alias-state-warn-primary)' : undefined,
              }),
              h(Row, { label: '单份 prompt', value: `${num(state.promptChars)} 字符 ≈ ${num(state.promptTokens)} tok` }),
              h(Row, { label: '上下文（含缓存）', value: `${num(state.contextTokens)} tok` }),
              h(Row, { label: '缓存命中', value: pct(state.cacheHit) }),
              h(Row, { label: '请求数', value: num(state.requests) }),
              h(Row, { label: '副本回收触发', value: `${num(state.recycleCount)} 次` }),
              h(Row, {
                label: '复读告警 / 熔断',
                value: `${num(state.repeatWarnings)} / ${num(state.repeatHits)}`,
                tone: state.repeatHits > 0 ? 'var(--dsw-alias-state-error-primary)' : undefined,
              }),
              h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    paddingTop: 8,
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                verdict(state),
              ),
            )
          : null,
        h(
          'div',
          {
            style: {
              marginTop: 8,
              fontSize: 11,
              lineHeight: 1.5,
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          feed
            ? `阈值：副本 ≥2 回收 · 连续 ≥8 告警 · ≥20 熔断 · 上下文 30/45 万`
            : null,
          error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `状态源不可用：${error}`) : null,
        ),
      )
    }

    function Lamp(props) {
      const sessionId = props.sessionId
      const [body, setBody] = useState(null)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const response = await fetch(FEED, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          if (!alive.current) return
          setBody(next)
          setError(null)
        } catch (cause) {
          if (!alive.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const rows = body?.sessions ?? []
      const own = rows.find((row) => String(row.id) === String(sessionId)) ?? (rows.length === 1 ? rows[0] : undefined)
      const status = error ? 'idle' : own?.status ?? (rows.length > 0 ? rows[0].status : 'idle')
      const tone = TONE[status] ?? TONE.idle

      const label = own === undefined ? '守卫 · 待命' : `守卫 · ${tone.label}`

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            title: 'Guard Lite 详情',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '1px 7px',
              border: '1px solid transparent',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              font: 'inherit',
              fontSize: 11,
              cursor: 'pointer',
              lineHeight: 1.6,
            },
          },
          h('span', {
            style: {
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: tone.color,
              boxShadow: status === 'ok' || status === 'idle' ? 'none' : `0 0 8px ${tone.color}`,
              transition: 'background 160ms ease',
            },
          }),
          h('span', null, label),
          own && own.systemBlocks >= 2
            ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 10.5 } }, `×${own.systemBlocks}`)
            : null,
        ),
        open
          ? h(Panel, {
              state: own,
              feed: body !== null,
              error,
              onClose: () => setOpen(false),
              onRefresh: load,
            })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'guard-lite',
              order: 2,
            },
            Lamp,
          ),
        )
      },
    }
  },
})
