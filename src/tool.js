// tool.js — plan_and_execute tool definition + dynamic return-schema generation

import { executePlan } from './executor.js'

const TOOL_DESCRIPTION = `Write JavaScript to orchestrate complex tasks by forking sub-agents.

Injected signature:
  async function task<T>(prompt: string, schema?: JSONSchema<T>): Promise<T>;

Rules:
• Write a named async function that receives task as its parameter
• Call await task(...) inside the function to fork sub-agents
• Use standard JS control flow (if/for/while/Promise.all/Promise.race)
• task() returns a Promise that resolves when the sub-agent calls its return tool
• Sub-agents inherit the parent session's model, tools, and context
• You MAY nest: a sub-agent can call plan_and_execute again
• Return the final result from the function`

const TOOL_PROMPT_SNIPPET =
  'Write a named async function to orchestrate complex multi-step tasks by forking typed sub-agents via task().'

const TOOL_PROMPT_GUIDELINES = [
  'Use plan_and_execute when a task naturally breaks into multiple subtasks that can be orchestrated with JS control flow.',
  'Pass a JSON Schema to task() to guarantee structured output from the sub-agent.',
  'Use Promise.all([]) to run independent subtasks in parallel.',
  'Write a named async function that receives task as its parameter and returns the final result.',
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
    name: 'plan_and_execute',
    label: 'Plan & Execute',
    description: TOOL_DESCRIPTION,
    promptSnippet: TOOL_PROMPT_SNIPPET,
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: Type.Object({
      code: Type.String({
        description:
          'A named async function definition that takes task as its parameter. Inside the function, use await task(prompt, schema) to fork sub-agents. Use standard JS control flow. The function must return the final result.',
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now()

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
    },
  }
}
