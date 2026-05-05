// executor.js — JS orchestration engine + Fork lifecycle + UI bridging

import { getSession } from './session-registry.js'

let createAgentSession = null
let importPromise = null
let nextForkId = 0

async function ensureCodingAgent() {
  if (!importPromise) {
    importPromise = import('@gsd/pi-coding-agent').catch(() => ({
      createAgentSession: null,
    }))
  }
  const mod = await importPromise
  if (mod.createAgentSession) createAgentSession = mod.createAgentSession
  return mod
}

// ---------------------------------------------------------------------------
// Active fork registry
// ---------------------------------------------------------------------------

const activeForksBySessionId = new Map() // sessionId → ForkRecord[]

export function getActiveForksForSession(sessionId) {
  return activeForksBySessionId.get(sessionId) ?? []
}

function addFork(sessionId, record) {
  if (!activeForksBySessionId.has(sessionId)) {
    activeForksBySessionId.set(sessionId, [])
  }
  activeForksBySessionId.get(sessionId).push(record)
}

function removeFork(sessionId, record) {
  const forks = activeForksBySessionId.get(sessionId)
  if (!forks) return
  const idx = forks.indexOf(record)
  if (idx >= 0) forks.splice(idx, 1)
  if (forks.length === 0) activeForksBySessionId.delete(sessionId)
}

// ---------------------------------------------------------------------------
// TurnOutputGate — serializes child-session output to the main UI
// ---------------------------------------------------------------------------

const FORBIDDEN_EVENTS = new Set([
  'agent_start',
  'agent_end',
  'session_start',
  'session_shutdown',
  'session_before_switch',
])

class TurnOutputGate {
  constructor() {
    this.owner = null
    this.buffers = new Map()
    this.listeners = []
  }

  _emitToMain(event, forkId) {
    if (FORBIDDEN_EVENTS.has(event?.type)) return
    const marked =
      event && typeof event === 'object'
        ? { ...event, _planForkId: forkId }
        : event
    for (const listener of this.listeners) {
      try {
        listener(marked)
      } catch {}
    }
  }

  handleEvent(event, forkId) {
    const isTurnStart = event?.type === 'turn_start'
    const isTurnEnd = event?.type === 'turn_end'

    if (isTurnStart) {
      if (!this.owner || this.owner === forkId) {
        this.owner = forkId
        this._emitToMain(event, forkId)
      } else {
        this._buffer(event, forkId)
      }
      return
    }

    if (isTurnEnd) {
      if (this.owner === forkId) {
        this._emitToMain(event, forkId)
        this.owner = null
        this._drain()
      } else {
        this._buffer(event, forkId)
      }
      return
    }

    if (!this.owner || this.owner === forkId) {
      this._emitToMain(event, forkId)
    } else {
      this._buffer(event, forkId)
    }
  }

  release(forkId) {
    if (this.owner === forkId) {
      this.owner = null
      this._drain()
    }
    this.buffers.delete(forkId)
  }

  _buffer(event, forkId) {
    if (!this.buffers.has(forkId)) this.buffers.set(forkId, [])
    this.buffers.get(forkId).push(event)
  }

  _drain() {
    while (!this.owner) {
      const nextId = this._pickNextFork()
      if (!nextId) break
      const events = this.buffers.get(nextId) ?? []
      this.buffers.delete(nextId)
      this.owner = nextId
      for (const event of events) {
        this._emitToMain(event, nextId)
        if (event?.type === 'turn_end') this.owner = null
      }
    }
  }

  _pickNextFork() {
    for (const [forkId, events] of this.buffers) {
      if (events.length > 0) return forkId
    }
    return null
  }
}

const turnOutputGates = new WeakMap()

function getTurnOutputGate(mainSession, listeners) {
  if (!turnOutputGates.has(mainSession)) {
    const gate = new TurnOutputGate()
    gate.listeners = listeners
    turnOutputGates.set(mainSession, gate)
  }
  const gate = turnOutputGates.get(mainSession)
  gate.listeners = listeners
  return gate
}

// ---------------------------------------------------------------------------
// Return tool — dynamically generated per fork with schema binding
// ---------------------------------------------------------------------------

function buildReturnTool(schema, resolver) {
  return {
    name: 'return',
    label: 'Return',
    description:
      'Submit final result and terminate this task fork. NO RETURN to caller.',
    parameters: {
      type: 'object',
      properties: {
        result: schema ?? {
          type: 'string',
          description: 'Task result (any type)',
        },
      },
      required: ['result'],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, childCtx) {
      resolver(params.result)
      try {
        childCtx?.session?.abort?.(new Error('TASK_RETURN_CALLED'))
      } catch {}
      return { display: false }
    },
  }
}

function buildSessionOptions(parentSession, returnTool, customTools) {
  const options = { cwd: process.cwd() }

  if (parentSession?.resourceLoader) {
    options.resourceLoader = parentSession.resourceLoader
  }
  if (parentSession?.modelRegistry) {
    options.modelRegistry = parentSession.modelRegistry
  }
  if (parentSession?.settingsManager) {
    options.settingsManager = parentSession.settingsManager
  }
  if (parentSession?.model) {
    options.model = parentSession.model
  }
  if (parentSession?.thinkingLevel) {
    options.thinkingLevel = parentSession.thinkingLevel
  }
  if (parentSession?.getActiveToolNames) {
    const active = parentSession.getActiveToolNames()
    if (active?.length > 0) {
      options.extraActiveToolNames = active
    }
  }
  if (parentSession?._scopedModels?.length > 0) {
    options.scopedModels = parentSession._scopedModels
  }

  const tools = [...(customTools ?? [])]
  if (returnTool) tools.push(returnTool)
  if (tools.length > 0) options.customTools = tools

  return options
}

// ---------------------------------------------------------------------------
// Fork lifecycle — create child session, bridge UI, run, join, cleanup
// ---------------------------------------------------------------------------

async function spawnTaskFork(
  prompt,
  schema,
  parentSession,
  parentSessionId,
  parentSignal,
  ctx,
  onUpdate,
) {
  if (!createAgentSession) {
    throw new Error(
      'plan_and_execute engine not initialized: createAgentSession unavailable',
    )
  }

  const forkId = ++nextForkId
  let resolved = false
  let resolver, rejecter
  const resultPromise = new Promise((resolve, reject) => {
    resolver = (val) => {
      if (resolved) return
      resolved = true
      resolve(val)
    }
    rejecter = (err) => {
      if (resolved) return
      resolved = true
      reject(err)
    }
  })

  let parentAbortHandler
  if (parentSignal) {
    parentAbortHandler = () => {
      rejecter(new Error('Parent session aborted'))
    }
    parentSignal.addEventListener('abort', parentAbortHandler, { once: true })
  }

  const childAbort = new AbortController()

  const forkRecord = {
    id: forkId,
    session: null,
    status: 'starting',
    controller: childAbort,
    startedAt: Date.now(),
  }
  addFork(parentSessionId, forkRecord)

  let childSession = null
  let gateCleanup = () => {}

  try {
    const returnTool = buildReturnTool(schema, resolver)
    const parentCustomTools = parentSession?._customTools ?? []
    const options = buildSessionOptions(
      parentSession,
      returnTool,
      parentCustomTools,
    )

    const factoryResult = await createAgentSession(options)
    if (!factoryResult?.session) {
      throw new Error('createAgentSession returned no session instance')
    }

    childSession = factoryResult.session
    childSession.isSubSession = true
    childSession._task_resolver = resolver
    forkRecord.session = childSession
    forkRecord.status = 'running'

    // UI bridge — wire child session events through TurnOutputGate to main listeners
    const mainListeners = parentSession?._eventListeners ?? []
    if (Array.isArray(mainListeners) && mainListeners.length > 0) {
      const gate = getTurnOutputGate(parentSession, mainListeners)
      const unsubscribe = childSession.subscribe((event) => {
        gate.handleEvent(event, forkId)
      })
      gateCleanup = () => {
        try {
          unsubscribe?.()
        } catch {}
        gate.release(forkId)
      }
    }

    onUpdate?.({
      content: [
        {
          type: 'text',
          text: `[Fork #${forkId}] ${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}`,
        },
      ],
      details: { phase: 'fork', forkId, promptPreview: prompt.slice(0, 120) },
    })

    ctx?.ui?.notify?.(
      `[plan-execute] Fork #${forkId}: ${prompt.slice(0, 50)}...`,
      'info',
    )

    await childSession.prompt(prompt)

    let emptyTurnCount = 0
    const MAX_EMPTY_TURNS = 20

    while (!resolved && emptyTurnCount < MAX_EMPTY_TURNS) {
      if (childAbort.signal.aborted) break
      if (parentSignal?.aborted) break

      while (childSession.isStreaming || childSession.agent?.isStreaming) {
        await new Promise((r) => setTimeout(r, 200))
        if (resolved || childAbort.signal.aborted || parentSignal?.aborted)
          break
      }

      if (resolved) break

      emptyTurnCount++
      await childSession.prompt(
        'ERROR: You must call the `return` tool to submit your result and finish this task. Do not output prose — call the tool.',
      )
    }

    if (!resolved && emptyTurnCount >= MAX_EMPTY_TURNS) {
      rejecter(
        new Error(
          `Task fork exited ${MAX_EMPTY_TURNS} times without calling return`,
        ),
      )
    }

    forkRecord.status = 'completed'
    const result = await resultPromise

    onUpdate?.({
      content: [{ type: 'text', text: `[Join #${forkId}] task completed` }],
      details: { phase: 'join', forkId },
    })

    ctx?.ui?.notify?.(`[plan-execute] Join #${forkId}`, 'info')

    return result
  } catch (err) {
    forkRecord.status = 'failed'
    throw err
  } finally {
    forkRecord.status = resolved ? 'completed' : 'failed'
    if (parentSignal && parentAbortHandler) {
      parentSignal.removeEventListener('abort', parentAbortHandler)
    }
    removeFork(parentSessionId, forkRecord)
    gateCleanup()

    try {
      childAbort.abort()
    } catch {}
    try {
      childSession?.abort?.(new Error('TASK_FORK_CLEANUP'))
    } catch {}
    try {
      if (typeof childSession?.destroy === 'function') {
        childSession.destroy()
      }
    } catch {}
    try {
      delete childSession?._task_resolver
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Public execute entry — runs the orchestration code
// ---------------------------------------------------------------------------

export async function executePlan(code, ctx, pi, signal, onUpdate) {
  await ensureCodingAgent()

  if (!createAgentSession) {
    throw new Error(
      'plan_and_execute requires @gsd/pi-coding-agent but it is not available',
    )
  }

  const sessionId = ctx?.sessionManager?.getSessionId?.()
  const parentSession = getSession(sessionId)

  const taskSpawner = async (prompt, schema) => {
    return spawnTaskFork(
      prompt,
      schema,
      parentSession,
      sessionId,
      signal,
      ctx,
      onUpdate,
    )
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const runner = new AsyncFunction(
    '__task__',
    `
    "use strict";
    ${code};
    if (typeof plan !== 'function') {
      throw new Error('No named async function found. Please define a function like: async function plan(task) { ... }');
    }
    return plan(__task__);
  `,
  )

  const result = await runner(taskSpawner)
  return result
}
