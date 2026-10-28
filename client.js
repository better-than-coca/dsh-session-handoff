/**
 * Client half of dsh-session-handoff: one icon button in the assistant message
 * action row, the row that already carries copy / rating / branch / usage.
 *
 * The button only asks; it never summarizes in the browser. Clicking it POSTs to
 * this plugin's Host half, which decides between "run now" (idle session) and
 * "queue" (mid-turn), using exactly the same rules as the session_handoff tool.
 *
 * The row is rendered once per finalized assistant message, so every button
 * shares one snapshot store and one refresh loop instead of polling per row.
 *
 * Contract with the Host half:
 *   GET  /api/dsh-session-handoff/status?sessionId=...  -> status payload
 *   POST /api/dsh-session-handoff/handoff { sessionId }  -> { ok, running|queued }
 */
window.__ModuleLoader__.load({
  id: '@better-than-coca/dsh-session-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATUS_URL = '/api/dsh-session-handoff/status'
    const HANDOFF_URL = '/api/dsh-session-handoff/handoff'
    /** How often an accepted handoff is re-checked, and its budget. */
    const POLL_MS = 2000
    const POLL_TICKS = 90
    /** Idle re-read cadence so the dot appears without a click. */
    const IDLE_REFRESH_MS = 20000

    const TEXT = {
      zh: {
        idle: '交接上下文',
        attention: '上下文 {p}% · 点这里交接',
        busy: '正在生成摘要…',
        done: '摘要已就绪 · 开新对话即可接收',
        dryRun: '试运行：未做任何改动',
        refused: '暂时不能交接：{e}',
        failed: '交接失败：{e}',
        off: '插件已关闭',
        dormant: '重启后这个会话还没跑过一轮，先在这里发一句话再点',
        summarizing: '正在生成摘要…',
        opening: '摘要好了，正在开新会话…',
        opened: '已在新会话继续',
        manual: '摘要已就绪，请新建对话取走',
        unavailable: '宿主没提供新建会话的通道，请手动新建对话',
        'no-cwd': '拿不到工作目录，请手动新建对话',
        slow: '新会话还没开出来，稍后重开对话就能取走',
        'create-failed': '新会话没建成：{e}',
        'prompt-failed': '新会话建好了，但第一条消息没发出去：{e}'
      },
      en: {
        idle: 'Hand off context',
        attention: 'Context at {p}% · click to hand off',
        busy: 'Summarizing…',
        done: 'Checkpoint ready · open a new chat to receive it',
        dryRun: 'Dry run: nothing changed',
        refused: 'Cannot hand off: {e}',
        failed: 'Handoff failed: {e}',
        off: 'Plugin is off',
        dormant: 'No turn has run in this chat since the host started — send one message, then click',
        summarizing: 'Summarizing…',
        opening: 'Checkpoint ready, opening a new session…',
        opened: 'Continued in a new session',
        manual: 'Checkpoint ready — open a new chat to receive it',
        unavailable: 'This host offers no session channel — start a new chat yourself',
        'no-cwd': 'No working directory to open a session in — start one yourself',
        slow: 'The new session has not appeared yet; a new chat will still pick the checkpoint up',
        'create-failed': 'Could not create the new session: {e}',
        'prompt-failed': 'Session created, but the first message was not accepted: {e}'
      }
    }

    const lang = () => {
      const raw = (typeof document !== 'undefined' && document.documentElement.lang) || navigator.language || 'en'
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    const fill = (template, params) => {
      let out = template
      for (const key of Object.keys(params || {})) out = out.split('{' + key + '}').join(String(params[key]))
      return out
    }

    /** Turn one follow-up outcome into the label the button shows. */
    const noteFor = followUp => {
      const dict = TEXT[lang()]
      if (followUp === null || followUp === undefined) return dict.slow
      const template = dict[followUp.code] || dict.failed
      return followUp.detail === undefined ? template : fill(template, { e: followUp.detail })
    }

    // ----------------------------------------------------------------- store
    const store = { snapshot: null, listeners: new Set(), inflight: null, pollTimer: null, ticking: false }

    const emit = () => {
      for (const listener of [...store.listeners]) {
        try {
          listener(store.snapshot)
        } catch {
          /* one bad subscriber must not stop the others */
        }
      }
    }

    const refresh = sessionId => {
      if (store.inflight !== null) return store.inflight
      const url = sessionId === undefined || sessionId === null || sessionId === ''
        ? STATUS_URL
        : STATUS_URL + '?sessionId=' + encodeURIComponent(String(sessionId))
      store.inflight = fetch(url, { headers: { accept: 'application/json' } })
        .then(response => response.json())
        .then(body => {
          if (body && body.ok === true) {
            store.snapshot = body
            emit()
          }
          return body
        })
        .catch(() => null)
        .finally(() => {
          store.inflight = null
        })
      return store.inflight
    }

    const stopPolling = () => {
      if (store.pollTimer !== null) {
        clearInterval(store.pollTimer)
        store.pollTimer = null
      }
    }

    const startPolling = sessionId => {
      stopPolling()
      let ticks = 0
      store.pollTimer = setInterval(() => {
        ticks += 1
        const done = store.snapshot !== null && store.snapshot.running !== true
          && store.snapshot.pending === 'waiting'
        if (done || ticks > POLL_TICKS) {
          stopPolling()
          return
        }
        void refresh(sessionId)
      }, POLL_MS)
    }

    // ------------------------------------------------- follow-up session
    /**
     * Navigation service the Host exposes to Client plugins. Captured only when
     * it resolves: switching to the new Session is a convenience — the Session
     * itself is created by the host half, not here.
     */
    let workspace = null

    const captureServices = ctx => {
      try {
        ctx.inject(['uiWorkspace'], scoped => {
          workspace = scoped.get('uiWorkspace') ?? scoped.uiWorkspace ?? null
        })
      } catch {
        /* no session navigation service */
      }
    }

    /** How long the button watches for the host's follow-up Session. */
    const FOLLOW_UP_WAIT_MS = 240000
    const FOLLOW_UP_TICK_MS = 900

    const sleep = ms => new Promise(resolve => {
      setTimeout(resolve, ms)
    })

    const statusNow = sessionId => {
      const url = sessionId === undefined || sessionId === null || sessionId === ''
        ? STATUS_URL
        : STATUS_URL + '?sessionId=' + encodeURIComponent(String(sessionId))
      return fetch(url, { headers: { accept: 'application/json' } })
        .then(response => response.json())
        .catch(() => null)
    }

    /**
     * Wait for the host half to report how the follow-up Session ended.
     * @param sessionId - the session being handed off.
     * @returns the outcome record, or null when it never arrived.
     */
    const waitForFollowUp = async sessionId => {
      const until = Date.now() + FOLLOW_UP_WAIT_MS
      while (Date.now() < until) {
        const status = await statusNow(sessionId)
        const followUp = status === null || status === undefined ? null : status.followUp
        if (followUp !== null && followUp !== undefined && typeof followUp.code === 'string') return followUp
        await sleep(FOLLOW_UP_TICK_MS)
      }
      return null
    }

    /** Switch to the Session the host opened, when navigation is available. */
    const revealSession = sessionId => {
      if (workspace === null || typeof workspace.openSession !== 'function') return
      try {
        workspace.openSession(sessionId)
      } catch {
        /* the sidebar lists the new Session either way */
      }
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(store.snapshot)
      React.useEffect(() => {
        const listener = value => setSnapshot(value)
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      }, [])
      return snapshot
    }

    // ------------------------------------------------------------------ icon
    const svg = (children, extra) => h('svg', {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      ...extra
    }, children)

    /** Candidate A: old session box -> arrow -> new session box. */
    const HANDOFF_ICON = svg([
      h('rect', { key: 'a', x: 2.5, y: 5.5, width: 7, height: 13, rx: 1.6 }),
      h('path', { key: 'b', d: 'M12.2 12h6.6' }),
      h('path', { key: 'c', d: 'M16.3 9.6 18.9 12l-2.6 2.4' }),
      h('rect', { key: 'd', x: 20, y: 8.5, width: 1.6, height: 7, rx: 0.8, fill: 'currentColor', stroke: 'none' })
    ])

    const CHECK_ICON = svg([h('path', { key: 'a', d: 'M4 12.5 9.5 18 20 6.5' })], { strokeWidth: 1.8 })

    const SPINNER_ICON = svg([h('path', { key: 'a', d: 'M12 3a9 9 0 1 1-9 9' })], { className: 'dsh-handoff-spin' })

    // ------------------------------------------------------------------- css
    const CSS = [
      '.dsh-handoff-btn{position:relative;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8f8f88);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
      '.dsh-handoff-btn svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));display:block}',
      '.dsh-handoff-btn:hover{background:var(--dsw-alias-fill-l1,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c5c57)}',
      '.dsh-handoff-btn:focus-visible{outline:2px solid var(--dsw-alias-line-focus,#7aa7d8);outline-offset:1px}',
      '.dsh-handoff-btn.is-attention{color:#b8862b}',
      '.dsh-handoff-btn.is-done{color:#4f8a6d}',
      '.dsh-handoff-btn.is-busy{cursor:progress}',
      '.dsh-handoff-dot{position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:999px;background:#d98a2b}',
      '.dsh-handoff-btn[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#2a2a27;color:#fff;font-size:11.5px;line-height:1.45;padding:4px 8px;border-radius:5px;white-space:nowrap;pointer-events:none;z-index:60}',
      '@keyframes dsh-handoff-spin{to{transform:rotate(360deg)}}',
      '.dsh-handoff-spin{animation:dsh-handoff-spin .9s linear infinite;transform-origin:center}'
    ].join('\n')


    // ------------------------------------------------------------ settings
    const SETTINGS_URL = '/api/dsh-session-handoff/settings'
    const PANEL_ID = 'session-handoff-panel'

    const COPY = {
      zh: {
        title: '会话交接',
        label: '会话交接',
        back: '返回会话',
        close: '关闭',
        check: '检查状态',
        connected: '已连接',
        scope: '存储范围',
        scopeGlobal: '全局',
        pageTitle: '系统状态',
        pageDesc: '交接触发器、上下文压力与落盘位置的运行状态。',
        metricPressure: '上下文压力',
        metricThreshold: '触发门槛',
        metricThresholdNote: '提醒 / 自动',
        metricLast: '上次交接',
        metricLastNone: '未交接',
        metricLastNote: '本会话还没有落过摘要',
        metricPending: '待取走',
        metricPendingNone: '无',
        metricPendingWaiting: '有摘要等新会话取走',
        metricPendingNote: '新会话第一条消息会收到',
        statusReady: '可交接',
        statusBlocked: '低于门槛',
        statusOff: '已关闭',
        statusRunning: '正在生成摘要',
        statusUnknown: '未知',
        secTrigger: '触发',
        secTriggerNote: '什么压力下提醒你、什么压力下自己动手。',
        secBehaviour: '行为',
        secBehaviourNote: '交接怎么执行、留给下一个会话什么。',
        save: '已保存',
        reset: '重置为默认',
        hint: {
          mode: '关＝只保留消息行里的手动按钮；询问＝到线时问你一次；自动＝到线后自己交接',
          askRatio: '上下文占用超过这个比例，就在回复前提醒你一次',
          autoRatio: '必须高于提醒门槛，否则自动交接会抢在提醒之前发生',
          noticeCooldownMs: '同一会话里两次提醒之间至少隔这么久，避免反复打断',
          dryRun: '只报告将要做什么，不真的调用摘要模型、不建会话',
          maxHandoffsPerSession: '防止一个会话被反反复复地交接出去',
          includeHistoryTool: '给模型 handoff_history，可以只读搜索旧会话原文',
          autoOpenSession: '交接完成后直接开一个新会话，第一条消息由插件发出'
        },
        name: {
          mode: '模式', askRatio: '提醒门槛', autoRatio: '自动门槛', noticeCooldownMs: '提醒冷却',
          dryRun: '试运行', maxHandoffsPerSession: '每会话上限', includeHistoryTool: '历史检索工具',
          autoOpenSession: '自动开新会话'
        },
        modes: { ask: '询问', auto: '自动', off: '关' },
        minute: '分钟'
      },
      en: {
        title: 'Session handoff',
        label: 'Session handoff',
        back: 'Back to chat',
        close: 'Close',
        check: 'Check status',
        connected: 'Connected',
        scope: 'Scope',
        scopeGlobal: 'Global',
        pageTitle: 'System status',
        pageDesc: 'How the trigger, the context pressure and the checkpoint on disk are doing.',
        metricPressure: 'Context pressure',
        metricThreshold: 'Trigger lines',
        metricThresholdNote: 'ask / auto',
        metricLast: 'Last handoff',
        metricLastNone: 'None yet',
        metricLastNote: 'this session has no checkpoint yet',
        metricPending: 'Waiting checkpoint',
        metricPendingNone: 'None',
        metricPendingWaiting: 'one is waiting for a new chat',
        metricPendingNote: 'the next new chat receives it',
        statusReady: 'Eligible',
        statusBlocked: 'Below the floor',
        statusOff: 'Off',
        statusRunning: 'Summarizing',
        statusUnknown: 'Unknown',
        secTrigger: 'Trigger',
        secTriggerNote: 'when to ask you, and when to act alone.',
        secBehaviour: 'Behaviour',
        secBehaviourNote: 'how the handoff runs and what it leaves behind.',
        save: 'Saved',
        reset: 'Reset to defaults',
        hint: {
          mode: 'off = keep only the manual button; ask = check in at the line; auto = hand off on its own',
          askRatio: 'How full the context must get before you are asked',
          autoRatio: 'Must stay above the ask line, or auto mode would act before asking',
          noticeCooldownMs: 'Minimum gap between two notices in one session',
          dryRun: 'Report what would happen without calling the summarizer or opening a session',
          maxHandoffsPerSession: 'Stops one session being handed off over and over',
          includeHistoryTool: 'Give the model handoff_history to search the old log read-only',
          autoOpenSession: 'After the checkpoint, open a new session and send its first message'
        },
        name: {
          mode: 'Mode', askRatio: 'Ask line', autoRatio: 'Auto line', noticeCooldownMs: 'Notice cooldown',
          dryRun: 'Dry run', maxHandoffsPerSession: 'Max per session', includeHistoryTool: 'Archive search tool',
          autoOpenSession: 'Open the new session'
        },
        modes: { ask: 'Ask', auto: 'Auto', off: 'Off' },
        minute: 'min'
      }
    }

    const PANEL_CSS = [
      /* The same layout grammar the Memory System page uses: a masthead, a page
         header, a hairline metric strip and bordered section cards. Every colour
         is a host alias token (with a literal fallback), so the panel follows the
         host theme instead of carrying its own palette. */
      '.dsh-ho-shell,.dsh-ho-shell *,.dsh-ho-shell *::before,.dsh-ho-shell *::after{box-sizing:border-box}',
      '.dsh-ho-shell{height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px}',
      '.dsh-ho-shell :where(button,input,select,textarea){color:inherit;font:inherit}',
      '.dsh-ho-masthead{flex:none;display:flex;align-items:center;gap:12px;min-height:48px;padding:10px 24px 4px}',
      '.dsh-ho-back{flex:none;display:inline-flex;align-items:center;gap:4px;min-width:max-content;height:28px;padding:0 8px 0 4px;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-tertiary,#979da6);font:inherit;cursor:pointer}',
      '.dsh-ho-back:hover{color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-ho-brand{flex:auto;display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;min-width:0}',
      '.dsh-ho-brand h1{flex:none;margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.dsh-ho-chip{display:inline-flex;align-items:center;gap:4px;flex:none;padding:1px 8px;border-radius:999px;white-space:nowrap;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#979da6);background:var(--dsw-alias-bg-module-platform,#f9fafb)}',
      '.dsh-ho-chip strong{font-weight:500;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsh-ho-status{flex:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#d4d4d4)}',
      '.dsh-ho-dot.good{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dsh-ho-dot.warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dsh-ho-dot.bad{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-ho-actions{flex:none;display:flex;align-items:center;gap:8px;justify-content:flex-end}',
      '.dsh-ho-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-caption,#adb2b8);cursor:pointer}',
      '.dsh-ho-iconbtn:hover{color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-ho-banner{flex:none;margin:8px 24px 0;padding:8px 12px;border-radius:var(--dsw-radius-md,12px);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#8a5a00);background:var(--dsw-alias-state-warn-tertiary,#fef5e7)}',
      '.dsh-ho-canvas{flex:1;min-width:0;overflow:auto}',
      '.dsh-ho-page{width:100%;padding:20px 24px 40px}',
      '.dsh-ho-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px 24px;margin-bottom:16px}',
      '.dsh-ho-pagehead h2{margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.dsh-ho-pagehead p{margin:2px 0 0;max-width:72ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsh-ho-pagemeta{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px}',
      '.dsh-ho-pagemeta code{padding:1px 8px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:999px;white-space:nowrap;font:500 11px/17px var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-secondary{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-md,12px);background:none;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;cursor:pointer}',
      '.dsh-ho-secondary:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-ho-strip{display:flex;flex-wrap:wrap;position:relative;overflow:hidden;margin-bottom:16px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-lg,16px)}',
      '.dsh-ho-strip article{flex:150px;min-width:0;min-height:76px;display:flex;align-items:flex-start;gap:10px;padding:14px 16px;margin:-.5px 0 0 -.5px;border-top:.5px solid var(--dsw-alias-border-l2,#0000001a);border-left:.5px solid var(--dsw-alias-border-l2,#0000001a)}',
      '.dsh-ho-strip article>div{min-width:0}',
      '.dsh-ho-strip .dsh-ho-dot{margin-top:6px}',
      '.dsh-ho-strip small{display:block;margin-bottom:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-strip strong{display:block;font-size:14px;line-height:22px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ho-strip p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#979da6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ho-card{margin-bottom:16px;padding:16px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-lg,16px)}',
      '.dsh-ho-shead{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:36px;margin-bottom:8px}',
      '.dsh-ho-shead h3{margin:0;font-size:14px;line-height:22px;font-weight:500}',
      '.dsh-ho-shead span{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-shead em{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-style:normal;font-weight:500;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-module-platform,#f9fafb)}',
      '.dsh-ho-row{display:grid;grid-template-columns:minmax(0,1fr) 220px;align-items:center;gap:16px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2,#0000001a)}',
      '.dsh-ho-rows>.dsh-ho-row:first-child{border-top:0;padding-top:4px}',
      '.dsh-ho-rowtxt b{display:block;font-size:13px;line-height:20px;font-weight:500}',
      '.dsh-ho-rowtxt span{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-ctrl{display:flex;justify-content:flex-end;min-width:0}',
      '.dsh-ho-seg{display:grid;grid-auto-flow:column;gap:2px;width:100%;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform,#f9fafb)}',
      '.dsh-ho-seg button{height:26px;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-tertiary,#979da6);font:inherit;cursor:pointer}',
      '.dsh-ho-seg button:hover{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsh-ho-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#0000001f)}',
      '.dsh-ho-slider{width:100%}',
      '.dsh-ho-readout{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}',
      '.dsh-ho-readout b{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}',
      '.dsh-ho-readout em{font-size:11px;font-style:normal;color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-range{appearance:none;-webkit-appearance:none;display:block;width:100%;height:16px;margin:0;background:transparent;cursor:pointer}',
      '.dsh-ho-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-state-business-primary,#4176e6) 0%,var(--dsw-alias-state-business-primary,#4176e6) var(--p,50%),var(--dsw-alias-border-l2,#0000001a) var(--p,50%),var(--dsw-alias-border-l2,#0000001a) 100%)}',
      '.dsh-ho-range::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#00000029),0 1px 2px rgba(0,0,0,.16)}',
      '.dsh-ho-range::-moz-range-track{height:4px;border-radius:999px;background:var(--dsw-alias-border-l2,#0000001a)}',
      '.dsh-ho-range::-moz-range-progress{height:4px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.dsh-ho-range::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#00000029)}',
      '.dsh-ho-tg{position:relative;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l4,#00000029);cursor:pointer;transition:background .14s}',
      '.dsh-ho-tg i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .14s}',
      '.dsh-ho-tg[aria-checked=true]{background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.dsh-ho-tg[aria-checked=true] i{left:16px}',
      '.dsh-ho-steps{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform,#f9fafb)}',
      '.dsh-ho-steps button{width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;line-height:1;cursor:pointer}',
      '.dsh-ho-steps button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-ho-steps button:disabled{color:var(--dsw-alias-label-caption,#adb2b8);cursor:not-allowed}',
      '.dsh-ho-steps b{min-width:28px;text-align:center;font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}',
      '.dsh-ho-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:4px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform,#f9fafb)}',
      '.dsh-ho-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px/18px var(--ds-font-family-code,ui-monospace,Consolas,monospace);color:var(--dsw-alias-label-tertiary,#979da6)}',
      '.dsh-ho-footacts{flex:none;display:flex;align-items:center;gap:12px}',
      '.dsh-ho-saved{font-size:12px;color:var(--dsw-alias-state-success-primary,#22c55e);opacity:0;transition:opacity .15s}',
      '.dsh-ho-saved.show{opacity:1}'
    ].join('\n')

    const injectCss = () => {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-handoff-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-handoff-style'
      style.textContent = CSS + '\n' + PANEL_CSS
      document.head.appendChild(style)
    }

    // -------------------------------------------------------------- component
    const toneOf = snapshot => {
      if (snapshot === null) return 'idle'
      if (snapshot.mode === 'off') return 'off'
      if (snapshot.running === true) return 'busy'
      if (snapshot.pending === 'waiting') return 'done'
      const ratio = snapshot.pressure && typeof snapshot.pressure.ratio === 'number' ? snapshot.pressure.ratio : 0
      const ask = typeof snapshot.askRatio === 'number' ? snapshot.askRatio : 0.55
      return ratio >= ask ? 'attention' : 'idle'
    }

    const percentOf = snapshot => {
      const ratio = snapshot && snapshot.pressure && typeof snapshot.pressure.ratio === 'number' ? snapshot.pressure.ratio : 0
      return Math.round(ratio * 100)
    }

    function HandoffAction(props) {
      const sessionId = props.sessionId
      const snapshot = useSnapshot()
      const tone = toneOf(snapshot)
      const [note, setNote] = React.useState(null)
      const clicking = React.useRef(false)

      // One idle refresh loop for the whole row set; the dot should appear on its
      // own without the user hovering or clicking anything.
      React.useEffect(() => {
        void refresh(sessionId)
        const timer = setInterval(() => {
          if (store.pollTimer === null) void refresh(sessionId)
        }, IDLE_REFRESH_MS)
        return () => clearInterval(timer)
      }, [sessionId])

      React.useEffect(() => () => stopPolling(), [])

      const dict = TEXT[lang()]
      let label
      if (note !== null) label = note
      else if (tone === 'attention') label = fill(dict.attention, { p: percentOf(snapshot) })
      else label = dict[tone] || dict.idle

      const onClick = () => {
        if (clicking.current || tone === 'busy' || tone === 'off') return
        clicking.current = true
        const payload = sessionId === undefined || sessionId === null || sessionId === ''
          ? {}
          : { sessionId: String(sessionId) }
        fetch(HANDOFF_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(response => response.json())
          .then(body => {
            const d = TEXT[lang()]
            if (body && body.ok === true) {
              if (body.dryRun === true) setNote(d.dryRun)
              else if (body.running === true || body.queued === true) {
                startPolling(sessionId)
                if (body.autoOpen === false) {
                  setNote(null)
                } else {
                  setNote(d.summarizing)
                  void waitForFollowUp(sessionId).then(followUp => {
                    if (followUp !== null && followUp !== undefined && followUp.code === 'opened'
                      && typeof followUp.sessionId === 'string') {
                      revealSession(followUp.sessionId)
                    }
                    setNote(noteFor(followUp))
                    void refresh(sessionId)
                  })
                }
              }
            } else if (body && body.code === 'session-dormant') {
              // The Session is real but its live surface is not loaded yet: the
              // host creates an Agent on the first turn, and only then can the
              // summarizer replay it.
              setNote(d.dormant)
            } else {
              const reason = body && (body.error || body.code) ? String(body.error || body.code) : 'unknown'
              setNote(fill(d.refused, { e: reason }))
            }
            void refresh(sessionId)
          })
          .catch(error => {
            setNote(fill(TEXT[lang()].failed, { e: error instanceof Error ? error.message : String(error) }))
          })
          .finally(() => {
            clicking.current = false
          })
      }

      const className = 'dsh-handoff-btn' + (tone === 'idle' ? '' : ' is-' + tone)
      return h('button', {
        type: 'button',
        className,
        'data-tip': label,
        'aria-label': label,
        'data-handoff-state': tone,
        onClick
      },
        tone === 'busy' ? SPINNER_ICON : tone === 'done' ? CHECK_ICON : HANDOFF_ICON,
        tone === 'attention' ? h('span', { className: 'dsh-handoff-dot' }) : null
      )
    }


    // ------------------------------------------------------- settings panel
    const copy = () => COPY[lang()] || COPY.en

    const ratioText = value => Math.round(value * 100) + '%'

    const durationText = value => {
      const minutes = Math.round(value / 60000)
      return minutes + ' ' + copy().minute
    }

    const barrier = (value, control) => {
      const span = control.max - control.min
      if (!(span > 0)) return '0%'
      return ((value - control.min) / span * 100).toFixed(1) + '%'
    }

    const svgPanel = (children, extra) => h('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', ...extra
    }, children)

    function SidebarIcon({ size }) {
      return h('span', { style: { display: 'inline-flex' } },
        h('svg', {
          viewBox: '0 0 24 24', width: size || 17, height: size || 17, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'
        },
        h('rect', { key: 'a', x: 2.5, y: 5.5, width: 7, height: 13, rx: 1.6 }),
        h('path', { key: 'b', d: 'M12.2 12h6.6' }),
        h('path', { key: 'c', d: 'M16.3 9.6 18.9 12l-2.6 2.4' }),
        h('rect', { key: 'd', x: 20, y: 8.5, width: 1.6, height: 7, rx: 0.8, fill: 'currentColor', stroke: 'none' })
        )
      )
    }

    function SettingsPanel(props) {
      const c = copy()
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const timer = React.useRef(null)
      const snapshot = useSnapshot()

      React.useEffect(() => {
        let alive = true
        fetch(SETTINGS_URL, { headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(body => {
            if (!alive || !body || body.ok !== true) return
            setData(body)
            setDraft(body.values)
          })
          .catch(() => {})
        void refresh()
        return () => {
          alive = false
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [])

      const flash = () => {
        setSaved(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setSaved(false), 1400)
      }

      const post = body => fetch(SETTINGS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(response => response.json())
        .then(payload => {
          if (!payload || payload.ok !== true) return
          setData(payload)
          setDraft(payload.values)
          flash()
        })
        .catch(() => {})

      const commit = patch => {
        setDraft(current => ({ ...current, ...patch }))
        void post({ values: patch })
      }

      const close = () => {
        try {
          if (props.close !== undefined) props.close()
        } catch {
          /* a host without the layout service simply keeps the panel open */
        }
      }

      if (data === null || draft === null) {
        return h('div', { className: 'dsh-ho-shell' },
          h('header', { className: 'dsh-ho-masthead' },
            h('div', { className: 'dsh-ho-brand' }, h('h1', null, c.title))
          ),
          h('div', { className: 'dsh-ho-canvas' })
        )
      }
      const controls = new Map(data.controls.map(control => [control.key, control]))
      const get = key => (draft[key] === undefined ? controls.get(key).fallback : draft[key])

      const ratio = snapshot && snapshot.pressure && typeof snapshot.pressure.ratio === 'number'
        ? snapshot.pressure.ratio : null
      const ask = get('askRatio')
      const auto = get('autoRatio')

      const nameOf = key => (c.name[key] || key)
      const hintOf = key => (c.hint[key] || '')

      const row = (control, body) => h('div', { className: 'dsh-ho-row', key: control.key },
        h('div', { className: 'dsh-ho-rowtxt' },
          h('b', null, nameOf(control.key)),
          h('span', null, hintOf(control.key))
        ),
        h('div', { className: 'dsh-ho-ctrl' }, body)
      )

      const domainOf = control => control.kind === 'duration'
        ? Math.round(control.min / 60000) + ' – ' + Math.round(control.max / 60000) + ' ' + c.minute
        : ratioText(control.min) + ' – ' + ratioText(control.max)

      const sliderField = control => {
        const value = get(control.key)
        return row(control, h('div', { className: 'dsh-ho-slider' },
          h('div', { className: 'dsh-ho-readout' },
            h('b', null, control.kind === 'duration' ? durationText(value) : ratioText(value)),
            h('em', null, domainOf(control))
          ),
          h('input', {
            type: 'range', className: 'dsh-ho-range',
            min: control.min, max: control.max, step: control.step, value,
            'aria-label': nameOf(control.key),
            style: { '--p': barrier(value, control) },
            onChange: event => setDraft(current => ({ ...current, [control.key]: Number(event.target.value) })),
            onPointerUp: event => commit({ [control.key]: Number(event.target.value) }),
            onKeyUp: event => commit({ [control.key]: Number(event.target.value) })
          })
        ))
      }

      const modeField = control => {
        const value = get(control.key)
        return row(control, h('div', { className: 'dsh-ho-seg', role: 'group', 'aria-label': nameOf(control.key) },
          control.options.map(option => h('button', {
            key: option, type: 'button', 'aria-pressed': value === option,
            onClick: () => commit({ [control.key]: option })
          }, c.modes[option] || option))
        ))
      }

      const toggleField = control => {
        const value = get(control.key) === true
        return row(control, h('button', {
          type: 'button', className: 'dsh-ho-tg', role: 'switch',
          'aria-checked': value, 'aria-label': nameOf(control.key),
          onClick: () => commit({ [control.key]: !value })
        }, h('i', null)))
      }

      const countField = control => {
        const value = get(control.key)
        return row(control, h('div', { className: 'dsh-ho-steps' },
          h('button', {
            key: 'm', type: 'button', disabled: value <= control.min,
            'aria-label': '−', onClick: () => commit({ [control.key]: Math.max(control.min, value - 1) })
          }, '−'),
          h('b', { key: 'v' }, String(value)),
          h('button', {
            key: 'p', type: 'button', disabled: value >= control.max,
            'aria-label': '＋', onClick: () => commit({ [control.key]: Math.min(control.max, value + 1) })
          }, '＋')
        ))
      }

      const renderControl = key => {
        const control = controls.get(key)
        if (control === undefined) return null
        if (control.kind === 'enum') return modeField(control)
        if (control.kind === 'boolean') return toggleField(control)
        if (control.kind === 'count') return countField(control)
        return sliderField(control)
      }

      const last = snapshot && snapshot.lastHandoff
      const mode = get('mode')
      const hasSnap = snapshot !== undefined && snapshot !== null
      const ready = hasSnap && snapshot.eligible === true
      const running = hasSnap && snapshot.running === true
      const waiting = hasSnap && snapshot.pending === 'waiting'
      const reason = hasSnap && typeof snapshot.reason === 'string' && snapshot.reason !== '' ? snapshot.reason : null
      const dot = running ? ' warn' : ready ? ' good' : mode === 'off' ? '' : ' warn'
      const state = running ? c.statusRunning
        : mode === 'off' ? c.statusOff
          : ready ? c.statusReady
            : hasSnap ? c.statusBlocked : c.statusUnknown
      const pressure = hasSnap && snapshot.pressure !== null && snapshot.pressure !== undefined ? snapshot.pressure : null
      const pressureValue = pressure !== null
        ? String(pressure.text || '').replace(/\s*\(.*$/, '')
        : ratio === null ? '—' : ratioText(ratio)
      const pressureNote = pressure === null
        ? ''
        : (String(pressure.text || '').match(/\(([^)]*)\)/) || [null, ''])[1]

      /** One tile of the hairline metric strip. */
      const metric = (label, value, note, tone) => h('article', { key: label },
        h('span', { className: 'dsh-ho-dot' + (tone === '' ? '' : ' ' + tone) }),
        h('div', null, h('small', null, label), h('strong', null, value), h('p', null, note))
      )

      /** One bordered section card holding a run of control rows. */
      const section = (title, note, pill, keys) => h('section', { className: 'dsh-ho-card' },
        h('div', { className: 'dsh-ho-shead' },
          h('div', null, h('h3', null, title), h('span', null, note)),
          pill === null ? null : h('em', null, pill)
        ),
        h('div', { className: 'dsh-ho-rows' }, keys.map(renderControl).filter(entry => entry !== null))
      )

      return h('div', { className: 'dsh-ho-shell' },
        h('header', { className: 'dsh-ho-masthead' },
          h('button', { type: 'button', className: 'dsh-ho-back', onClick: close },
            svgPanel([h('path', { key: 'c', d: 'M15 5l-7 7 7 7' })], { width: 14, height: 14, strokeWidth: 1.8 }),
            c.back
          ),
          h('div', { className: 'dsh-ho-brand' },
            h('h1', null, c.title),
            h('span', { className: 'dsh-ho-chip' }, c.scope + ' ', h('strong', null, c.scopeGlobal))
          ),
          h('div', { className: 'dsh-ho-status' },
            h('span', { className: 'dsh-ho-dot' + dot }),
            c.connected + ' · ' + (c.modes[mode] || mode)
          ),
          h('div', { className: 'dsh-ho-actions' },
            h('button', { type: 'button', className: 'dsh-ho-iconbtn', title: c.check, onClick: () => { void refresh() } },
              svgPanel([h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { key: 'b', d: 'M20 5v6h-6' })], { width: 16, height: 16 })
            ),
            h('button', { type: 'button', className: 'dsh-ho-iconbtn', title: c.close, onClick: close },
              svgPanel([h('path', { key: 'x', d: 'M6 6l12 12M18 6L6 18' })], { width: 16, height: 16, strokeWidth: 1.7 })
            )
          )
        ),
        reason === null ? null : h('div', { className: 'dsh-ho-banner', role: 'status' }, reason),
        h('div', { className: 'dsh-ho-canvas' },
          h('div', { className: 'dsh-ho-page' },
            h('div', { className: 'dsh-ho-pagehead' },
              h('div', null, h('h2', null, c.pageTitle), h('p', null, c.pageDesc)),
              h('div', { className: 'dsh-ho-pagemeta' },
                typeof data.version === 'string' && data.version !== '' ? h('code', null, 'v' + data.version) : null,
                h('span', { className: 'dsh-ho-chip' }, h('span', { className: 'dsh-ho-dot' + dot }), state),
                h('button', { type: 'button', className: 'dsh-ho-secondary', onClick: () => { void refresh() } }, c.check)
              )
            ),
            h('div', { className: 'dsh-ho-strip' },
              metric(c.metricPressure, pressureValue, pressureNote, ready ? 'good' : 'warn'),
              metric(c.metricThreshold, ratioText(ask) + ' / ' + ratioText(auto), c.metricThresholdNote, 'good'),
              metric(c.metricLast,
                last === undefined || last === null ? c.metricLastNone : Math.round(last.ratio || 0) + ' : 1',
                last === undefined || last === null ? c.metricLastNote : String(last.summaryTokens || '') + ' tokens',
                ''),
              metric(c.metricPending,
                waiting ? c.metricPendingWaiting : c.metricPendingNone,
                c.metricPendingNote,
                waiting ? 'warn' : '')
            ),
            section(c.secTrigger, c.secTriggerNote, c.modes[mode] || mode,
              ['mode', 'askRatio', 'autoRatio', 'noticeCooldownMs']),
            section(c.secBehaviour, c.secBehaviourNote, null,
              ['dryRun', 'maxHandoffsPerSession', 'includeHistoryTool', 'autoOpenSession']),
            h('div', { className: 'dsh-ho-foot' },
              h('code', { className: 'dsh-ho-path' }, String(data.path || '')),
              h('div', { className: 'dsh-ho-footacts' },
                h('span', { className: 'dsh-ho-saved' + (saved ? ' show' : '') }, '✓ ' + c.save),
                h('button', { type: 'button', className: 'dsh-ho-secondary', onClick: () => { void post({ reset: true }) } }, c.reset)
              )
            )
          )
        )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        injectCss()
        // Capture the Host services the follow-up session needs; the button still
        // works (manually) when they are absent.
        captureServices(ctx)
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'handoff',
          order: 20,
          inject: sessionId => ({ sessionId })
        }, HandoffAction))

        // The settings page is a sidebar panel of its own, next to the Memory
        // System (order 30) and Skills (order 31). A layout without native panel
        // seats simply never declares these two slots, so nothing is registered.
        const closePanel = () => {
          try {
            if (ctx.layout !== undefined && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel(null)
            }
          } catch {
            /* a host without the layout service keeps the panel open */
          }
        }
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ close: closePanel })
          }, SettingsPanel)
          const stopIcon = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 32,
            label: () => copy().label
          }, SidebarIcon)
          return () => {
            stopIcon()
            stopMain()
          }
        }))
      },
      HandoffAction,
      SettingsPanel,
      toneOf,
      store
    }
  }
})