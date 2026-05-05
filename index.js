import { ensureBundledExtensionPath } from './src/self-injection.js'
import { createPlanAndExecuteTool } from './src/tool.js'
import { getActiveForksForSession } from './src/executor.js'
import { rememberSession } from './src/session-registry.js'

ensureBundledExtensionPath(import.meta.url)

const registeredPluginApis = new WeakSet()

export default async function planAndExecutePlugin(pi) {
  if (registeredPluginApis.has(pi)) return

  try {
    const tool = await createPlanAndExecuteTool(pi)
    pi.registerTool(tool)

    pi.on('session_start', (_event, ctx) => {
      rememberSession(ctx?.sessionManager?.session)
    })

    // Broadcast user input to all running task forks
    pi.on('input', (event, ctx) => {
      const sessionId = ctx?.sessionManager?.getSessionId?.()
      if (!sessionId) return undefined

      const forks = getActiveForksForSession(sessionId)
      const running = forks.filter((f) => f.status === 'running' && f.session)
      if (running.length === 0) return undefined

      ctx?.ui?.notify?.(
        `[plan-exec] Steering user input to ${running.length} running fork(s): ${running.map((f) => `#${f.id}`).join(', ')}`,
        'info',
      )

      const text = event.text
      for (const rec of running) {
        try {
          if (rec.session.isStreaming) {
            rec.session.steer(text)
          } else {
            rec.session.prompt(text).catch(() => {})
          }
        } catch (steerErr) {
          ctx?.ui?.notify?.(
            `[plan-exec] Failed to steer to fork #${rec.id}: ${steerErr.message}`,
            'warning',
          )
        }
      }

      return { action: 'handled' }
    })

    pi.on('session_shutdown', async (_event, ctx) => {
      const sessionId = ctx?.sessionManager?.getSessionId?.()
      if (!sessionId) return
      const forks = getActiveForksForSession(sessionId)
      if (forks.length === 0) return
      ctx?.ui?.notify?.(
        `[plan-exec] Aborting ${forks.length} active task fork(s) on session shutdown`,
        'info',
      )
      for (const fork of forks) {
        try {
          fork.controller?.abort()
        } catch {}
      }
    })

    registeredPluginApis.add(pi)
  } catch (error) {
    registeredPluginApis.delete(pi)
    throw error
  }
}
