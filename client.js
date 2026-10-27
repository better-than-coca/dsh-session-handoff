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
        blurb: '上下文到阈值时把这一会话摘要出来，交给一个新会话接着做。旧会话永远不会被压缩或改动。',
        live: '本会话上下文',
        close: '关闭',
        secTrigger: '触发',
        secTriggerNote: '什么时候提醒你，要不要自动做',
        secBehaviour: '行为',
        secBehaviourNote: '交接本身怎么执行',
        save: '已保存',
        reset: '恢复默认',
        ready: '可交接',
        waiting: '没有等待中的摘要',
        last: '最近一次',
        label: '会话交接',
        hint: {
          mode: '询问＝到阈值时提醒你；自动＝达到自动阈值直接交接；关闭＝只保留消息行里的手动按钮',
          askRatio: '上下文占用超过这个比例就提醒你一次',
          autoRatio: '必须高于询问阈值，否则自动交接会抢在提醒之前发生',
          noticeCooldownMs: '同一会话里两次提醒之间至少隔这么久，避免反复打断',
          dryRun: '只报告会做什么，不真的调用摘要模型',
          maxHandoffsPerSession: '防止一个会话被反反复复地交接出去',
          includeHistoryTool: '给模型 handoff_history，可以只读搜索旧会话日志',
          autoOpenSession: '交接完成后自动开一个新会话、注入摘要并切过去'
        },
        name: {
          mode: '模式', askRatio: '询问阈值', autoRatio: '自动阈值', noticeCooldownMs: '提醒冷却',
          dryRun: '试运行', maxHandoffsPerSession: '每个会话最多交接次数', includeHistoryTool: '提供原文检索工具',
          autoOpenSession: '自动开新会话'
        },
        modes: { ask: '询问', auto: '自动', off: '关闭' },
        minute: '分'
      },
      en: {
        title: 'Session handoff',
        blurb: 'Summarize this session at a threshold and continue in a new one. The old session is never compacted or modified.',
        live: 'This session',
        close: 'Close',
        secTrigger: 'Trigger',
        secTriggerNote: 'when to ask, and whether to act alone',
        secBehaviour: 'Behaviour',
        secBehaviourNote: 'how the handoff itself runs',
        save: 'Saved',
        reset: 'Reset to defaults',
        ready: 'Eligible',
        waiting: 'No waiting checkpoint',
        last: 'Last one',
        label: 'Session handoff',
        hint: {
          mode: 'ask = check in at the threshold; auto = hand off at the auto threshold; off = keep only the manual button',
          askRatio: 'How full the context must get before you are asked',
          autoRatio: 'Must stay above the ask threshold, or auto mode would act before asking',
          noticeCooldownMs: 'Minimum gap between two notices in one session',
          dryRun: 'Report what would happen without calling the summarizer',
          maxHandoffsPerSession: 'Stops one session being handed off over and over',
          includeHistoryTool: 'Give the model handoff_history to search the old log read-only',
          autoOpenSession: 'After the summary, open a new session, inject it there and switch over'
        },
        name: {
          mode: 'Mode', askRatio: 'Ask threshold', autoRatio: 'Auto threshold', noticeCooldownMs: 'Notice cooldown',
          dryRun: 'Dry run', maxHandoffsPerSession: 'Max handoffs per session', includeHistoryTool: 'Archive search tool',
          autoOpenSession: 'Open the new session'
        },
        modes: { ask: 'Ask', auto: 'Auto', off: 'Off' },
        minute: 'min'
      }
    }

    const PANEL_CSS = [
      '.dsh-ho-panel{height:100%;display:flex;flex-direction:column;background:#fff;color:#1c1c1a;font-size:13px;line-height:1.5;--ho-ink:#1c1c1a;--ho-ink2:#57574f;--ho-ink3:#8b8b82;--ho-ink4:#a8a89f;--ho-line:#e6e5df;--ho-line-soft:#efeee9;--ho-sunken:#faf9f6;--ho-hover:#f4f3ee;--ho-accent:#6b7f72;--ho-accent-soft:#eef2ef;--ho-ok:#4f8a6d}',
      '.dsh-ho-scroll{flex:1;min-height:0;overflow:auto}',
      '.dsh-ho-head{padding:16px 26px 13px;border-bottom:1px solid var(--ho-line-soft)}',
      '.dsh-ho-title{display:flex;align-items:center;gap:9px}',
      '.dsh-ho-title h1{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0}',
      '.dsh-ho-badge{font-size:10.5px;font-weight:500;letter-spacing:.03em;color:var(--ho-accent);background:var(--ho-accent-soft);border-radius:4px;padding:2px 6px}',
      '.dsh-ho-x{margin-left:auto;width:26px;height:26px;border:0;background:none;border-radius:6px;color:var(--ho-ink3);cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.dsh-ho-x:hover{background:var(--ho-hover);color:var(--ho-ink)}',
      '.dsh-ho-blurb{margin:4px 0 0;font-size:12px;color:var(--ho-ink3);max-width:56ch}',
      '.dsh-ho-live{padding:13px 26px 15px;background:var(--ho-sunken);border-bottom:1px solid var(--ho-line-soft)}',
      '.dsh-ho-liverow{display:flex;align-items:baseline;gap:10px;margin-bottom:9px}',
      '.dsh-ho-livelab{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--ho-ink3)}',
      '.dsh-ho-liveval{margin-left:auto;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh-ho-liveval small{font-weight:400;color:var(--ho-ink4);font-family:inherit}',
      '.dsh-ho-meter{position:relative;height:8px;border-radius:4px;background:#e9e8e2}',
      '.dsh-ho-fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:linear-gradient(90deg,#82968a,#6b7f72)}',
      '.dsh-ho-tick{position:absolute;top:-3px;bottom:-3px;width:1.5px;background:var(--ho-ink4);border-radius:1px}',
      '.dsh-ho-tickcap{position:absolute;top:13px;font-size:10.5px;color:var(--ho-ink3);transform:translateX(-50%);white-space:nowrap}',
      '.dsh-ho-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:26px}',
      '.dsh-ho-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ho-ink2);background:#fff;border:1px solid var(--ho-line);border-radius:99px;padding:3px 9px}',
      '.dsh-ho-chip b{font-weight:500;font-variant-numeric:tabular-nums;color:var(--ho-ink)}',
      '.dsh-ho-dot{width:6px;height:6px;border-radius:99px;background:var(--ho-ink4)}',
      '.dsh-ho-dot.on{background:var(--ho-ok)}',
      '.dsh-ho-body{padding:4px 26px 16px}',
      '.dsh-ho-sec{padding:15px 0}',
      '.dsh-ho-sec + .dsh-ho-sec{border-top:1px solid var(--ho-line-soft)}',
      '.dsh-ho-sechead{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}',
      '.dsh-ho-sechead h2{font-size:11px;font-weight:600;letter-spacing:.07em;color:var(--ho-ink3);margin:0;text-transform:uppercase}',
      '.dsh-ho-sechead span{font-size:11px;color:var(--ho-ink4)}',
      '.dsh-ho-field{padding:9px 0}',
      '.dsh-ho-fieldtop{display:flex;align-items:baseline;gap:12px}',
      '.dsh-ho-name{font-size:13px;font-weight:500;flex:1;min-width:0}',
      '.dsh-ho-hint{font-size:11.5px;color:var(--ho-ink3);margin-top:1px}',
      '.dsh-ho-out{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-variant-numeric:tabular-nums;background:var(--ho-sunken);border:1px solid var(--ho-line);border-radius:5px;padding:1px 7px;min-width:50px;text-align:center}',
      '.dsh-ho-inline{display:flex;align-items:center;gap:12px}',
      '.dsh-ho-inline .dsh-ho-txt{flex:1;min-width:0}',
      '.dsh-ho-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;background:var(--ho-sunken);border:1px solid var(--ho-line);border-radius:8px;padding:3px;margin-top:8px}',
      '.dsh-ho-seg button{border:0;background:none;font-family:inherit;font-size:12.5px;color:var(--ho-ink2);padding:6px 0;border-radius:6px;cursor:pointer}',
      '.dsh-ho-seg button:hover{color:var(--ho-ink)}',
      '.dsh-ho-seg button[aria-pressed=true]{background:#fff;color:var(--ho-ink);font-weight:500;box-shadow:0 1px 2px rgba(28,28,26,.1),0 0 0 1px rgba(28,28,26,.05)}',
      '.dsh-ho-range{appearance:none;-webkit-appearance:none;width:100%;height:18px;background:transparent;margin:7px 0 0;display:block;cursor:pointer}',
      '.dsh-ho-range::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:linear-gradient(90deg,#8c9a92 0%,#8c9a92 var(--p,50%),#e9e8e2 var(--p,50%),#e9e8e2 100%)}',
      '.dsh-ho-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:99px;background:#fff;border:1.5px solid #6b7f72;box-shadow:0 1px 3px rgba(28,28,26,.22);margin-top:-4.5px}',
      '.dsh-ho-range::-moz-range-track{height:5px;border-radius:3px;background:#e9e8e2}',
      '.dsh-ho-range::-moz-range-thumb{width:13px;height:13px;border-radius:99px;background:#fff;border:1.5px solid #6b7f72}',
      '.dsh-ho-tg{width:34px;height:19px;border-radius:99px;background:#dcdbd4;border:0;padding:0;cursor:pointer;position:relative;flex:0 0 auto;transition:background .14s}',
      '.dsh-ho-tg i{position:absolute;top:2.5px;left:2.5px;width:14px;height:14px;border-radius:99px;background:#fff;box-shadow:0 1px 2px rgba(28,28,26,.25);transition:left .14s}',
      '.dsh-ho-tg[aria-checked=true]{background:#7d9186}',
      '.dsh-ho-tg[aria-checked=true] i{left:17.5px}',
      '.dsh-ho-steps{display:inline-flex;align-items:center;border:1px solid var(--ho-line);border-radius:6px;background:#fff;overflow:hidden}',
      '.dsh-ho-steps button{width:27px;height:26px;border:0;background:none;color:var(--ho-ink2);cursor:pointer;font-size:14px;line-height:1;font-family:inherit}',
      '.dsh-ho-steps button:hover:not(:disabled){background:var(--ho-hover)}',
      '.dsh-ho-steps button:disabled{color:var(--ho-ink4);cursor:not-allowed}',
      '.dsh-ho-steps b{min-width:30px;text-align:center;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:400;border-left:1px solid var(--ho-line-soft);border-right:1px solid var(--ho-line-soft);line-height:26px}',
      '.dsh-ho-foot{display:flex;align-items:center;gap:12px;padding:10px 26px;border-top:1px solid var(--ho-line-soft);background:var(--ho-sunken)}',
      '.dsh-ho-saved{font-size:11.5px;color:var(--ho-ok);opacity:0;transition:opacity .15s}',
      '.dsh-ho-saved.show{opacity:1}',
      '.dsh-ho-path{flex:1;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--ho-ink4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ho-btn{font-family:inherit;font-size:11.5px;color:var(--ho-ink2);background:#fff;border:1px solid var(--ho-line);border-radius:6px;padding:5px 11px;cursor:pointer}',
      '.dsh-ho-btn:hover{background:var(--ho-hover);color:var(--ho-ink)}'
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
        return h('div', { className: 'dsh-ho-panel' },
          h('div', { className: 'dsh-ho-head' }, h('div', { className: 'dsh-ho-title' }, h('h1', null, c.title)))
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

      const field = (control, body, inline) => h('div', { className: 'dsh-ho-field', key: control.key },
        inline === true
          ? h('div', { className: 'dsh-ho-inline' },
            h('div', { className: 'dsh-ho-txt' },
              h('div', { className: 'dsh-ho-name' }, nameOf(control.key)),
              h('div', { className: 'dsh-ho-hint' }, hintOf(control.key))
            ),
            body
          )
          : h('div', null,
            h('div', { className: 'dsh-ho-fieldtop' },
              h('span', { className: 'dsh-ho-name' }, nameOf(control.key)),
              h('span', { className: 'dsh-ho-out' }, body.label)
            ),
            h('div', { className: 'dsh-ho-hint' }, hintOf(control.key)),
            body.input
          )
      )

      const sliderField = control => {
        const value = get(control.key)
        const input = h('input', {
          key: 'r', type: 'range', className: 'dsh-ho-range',
          min: control.min, max: control.max, step: control.step, value,
          'aria-label': nameOf(control.key),
          style: { '--p': barrier(value, control) },
          onChange: event => setDraft(current => ({ ...current, [control.key]: Number(event.target.value) })),
          onPointerUp: event => commit({ [control.key]: Number(event.target.value) }),
          onKeyUp: event => commit({ [control.key]: Number(event.target.value) })
        })
        const label = control.kind === 'duration' ? durationText(value) : ratioText(value)
        return field(control, { label, input })
      }

      const modeField = control => {
        const value = get(control.key)
        const seg = h('div', { className: 'dsh-ho-seg', role: 'group', 'aria-label': nameOf(control.key) },
          control.options.map(option => h('button', {
            key: option, type: 'button',
            'aria-pressed': value === option,
            onClick: () => commit({ [control.key]: option })
          }, c.modes[option] || option))
        )
        return h('div', { className: 'dsh-ho-field', key: control.key },
          h('div', { className: 'dsh-ho-name' }, nameOf(control.key)),
          h('div', { className: 'dsh-ho-hint' }, hintOf(control.key)),
          seg
        )
      }

      const toggleField = control => {
        const value = get(control.key) === true
        return field(control, h('button', {
          key: 't', type: 'button', className: 'dsh-ho-tg', role: 'switch',
          'aria-checked': value, 'aria-label': nameOf(control.key),
          onClick: () => commit({ [control.key]: !value })
        }, h('i', null)), true)
      }

      const countField = control => {
        const value = get(control.key)
        return field(control, h('div', { className: 'dsh-ho-steps' },
          h('button', {
            key: 'm', type: 'button', disabled: value <= control.min,
            'aria-label': '−', onClick: () => commit({ [control.key]: Math.max(control.min, value - 1) })
          }, '−'),
          h('b', { key: 'v' }, String(value)),
          h('button', {
            key: 'p', type: 'button', disabled: value >= control.max,
            'aria-label': '＋', onClick: () => commit({ [control.key]: Math.min(control.max, value + 1) })
          }, '＋')
        ), true)
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

      return h('div', { className: 'dsh-ho-panel' },
        h('div', { className: 'dsh-ho-scroll' },
          h('div', { className: 'dsh-ho-head' },
            h('div', { className: 'dsh-ho-title' },
              h('h1', null, c.title),
              h('span', { className: 'dsh-ho-badge' }, '0.5.3'),
              h('button', { type: 'button', className: 'dsh-ho-x', 'aria-label': c.close, onClick: close },
                svgPanel([h('path', { key: 'x', d: 'M6 6l12 12M18 6L6 18' })], { strokeWidth: 1.7 }))
            ),
            h('p', { className: 'dsh-ho-blurb' }, c.blurb)
          ),

          h('div', { className: 'dsh-ho-live' },
            h('div', { className: 'dsh-ho-liverow' },
              h('span', { className: 'dsh-ho-livelab' }, c.live),
              h('span', { className: 'dsh-ho-liveval' },
                ratio === null ? '—' : ratioText(ratio),
                snapshot && snapshot.pressure && snapshot.pressure.text
                  ? h('small', null, ' · ' + snapshot.pressure.text.replace(/^[\d.]+%\s*/, ''))
                  : null
              )
            ),
            h('div', { className: 'dsh-ho-meter' },
              ratio === null ? null : h('div', { className: 'dsh-ho-fill', style: { width: ratioText(Math.min(1, ratio)) } }),
              h('div', { className: 'dsh-ho-tick', style: { left: ratioText(ask) } }),
              h('div', { className: 'dsh-ho-tickcap', style: { left: ratioText(ask) } }, c.name.askRatio + ' ' + ratioText(ask)),
              h('div', { className: 'dsh-ho-tick', style: { left: ratioText(auto) } }),
              h('div', { className: 'dsh-ho-tickcap', style: { left: ratioText(auto) } }, c.name.autoRatio + ' ' + ratioText(auto))
            ),
            h('div', { className: 'dsh-ho-chips' },
              h('span', { className: 'dsh-ho-chip' },
                h('span', { className: 'dsh-ho-dot' + (snapshot && snapshot.eligible ? ' on' : '') }),
                snapshot && snapshot.eligible ? c.ready : (snapshot && snapshot.reason ? snapshot.reason : '—')
              ),
              h('span', { className: 'dsh-ho-chip' },
                h('span', { className: 'dsh-ho-dot' + (snapshot && snapshot.pending === 'waiting' ? ' on' : '') }),
                snapshot && snapshot.pending === 'waiting' ? '等待新会话取走' : c.waiting
              ),
              last === undefined || last === null
                ? null
                : h('span', { className: 'dsh-ho-chip' }, c.last + ' ',
                  h('b', null, String(Math.round(last.ratio || 0)) + ' : 1'),
                  last.summaryTokens ? ' · ' + last.summaryTokens + ' tokens' : '')
            )
          ),

          h('div', { className: 'dsh-ho-body' },
            h('div', { className: 'dsh-ho-sec' },
              h('div', { className: 'dsh-ho-sechead' },
                h('h2', null, c.secTrigger),
                h('span', null, c.secTriggerNote)
              ),
              renderControl('mode'),
              renderControl('askRatio'),
              renderControl('autoRatio'),
              renderControl('noticeCooldownMs')
            ),
            h('div', { className: 'dsh-ho-sec' },
              h('div', { className: 'dsh-ho-sechead' },
                h('h2', null, c.secBehaviour),
                h('span', null, c.secBehaviourNote)
              ),
              renderControl('dryRun'),
              renderControl('maxHandoffsPerSession'),
              renderControl('includeHistoryTool'),
              renderControl('autoOpenSession')
            )
          )
        ),
        h('div', { className: 'dsh-ho-foot' },
          h('span', { className: 'dsh-ho-saved' + (saved ? ' show' : '') }, '✓ ' + c.save),
          h('span', { className: 'dsh-ho-path' }, data.path),
          h('button', {
            type: 'button', className: 'dsh-ho-btn',
            onClick: () => { void post({ reset: true }) }
          }, c.reset)
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