// tool.js — plan_exec tool definition + dynamic return-schema generation

import { executePlan } from './executor.js'

const TOOL_DESCRIPTION = `Write JavaScript to orchestrate complex tasks by forking sub-agents.

Injected signature:
  async function task<T>(prompt: string, schema?: JSONSchema<T>): Promise<T>;

Rules:
• Write an async function named main that receives task as its parameter
• Call await task(...) inside the function to fork sub-agents
• Use standard JS control flow (if/for/while/Promise.all/Promise.race)
• task() returns a Promise that resolves when the sub-agent calls its return tool
• Sub-agents inherit the parent session's model, tools, and context
• You MAY nest: a sub-agent can call plan_exec again
• Return the final result from main`

const TOOL_PROMPT_SNIPPET =
  'Write an async function named main to orchestrate complex multi-step tasks by forking typed sub-agents via task().'

const TOOL_PROMPT_GUIDELINES = [
  'Use plan_exec when a task naturally breaks into multiple subtasks that can be orchestrated with JS control flow.',
  'Pass a JSON Schema to task() to guarantee structured output from the sub-agent.',
  'Use Promise.all([]) to run independent subtasks in parallel.',
  'Write an async function named main that receives task as its parameter and returns the final result.',
]

export async function createPlanAndExecuteTool(pi) {
  const [{ Type }] = await Promise.all([
    import('@sinclair/typebox').catch(() => ({
      Type: {
        Object: (properties) => ({ type: 'object', properties }),
        String: (options) => ({ type: 'string', ...options }),
      },
    })),
  ])

  return {
    name: 'plan_exec',
    label: 'Plan & Execute',
    description: TOOL_DESCRIPTION,
    promptSnippet: TOOL_PROMPT_SNIPPET,
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: Type.Object({
      code: Type.String({
        description:
          'An async function named main that takes task as its parameter. Inside the function, use await task(prompt, schema) to fork sub-agents. Use standard JS control flow. The function must return the final result.',
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now()

      try {
        const result = await executePlan(params.code, ctx, pi, signal, onUpdate)

        const duration = Date.now() - start
        const preview =
          typeof result === 'object'
            ? JSON.stringify(result, null, 2).slice(0, 800)
            : String(result).slice(0, 800)

        return {
          content: [
            {
              type: 'text',
              text: `Plan execution completed in ${duration}ms.\n\nResult:\n${preview}${typeof result === 'object' && JSON.stringify(result, null, 2).length > 800 ? '\n... (truncated)' : ''}`,
            },
          ],
          details: { result, durationMs: duration },
        }
      } catch (err) {
        const duration = Date.now() - start
        const reason = err?.message ?? String(err)
        return {
          content: [
            {
              type: 'text',
              text: `Plan execution failed after ${duration}ms.\n\nReason: ${reason}`,
            },
          ],
          details: { error: reason, durationMs: duration },
          isError: true,
        }
      }
    },
  }
}
