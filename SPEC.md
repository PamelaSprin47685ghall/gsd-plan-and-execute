# Plan & Execute Extension - 体系化设计方案

> 一个基于 JavaScript 运行时的动态编排引擎，通过 `task()` 原语实现 Agent 的动态 Fork 与结构化返回

---

## 一、设计目标与核心理念

### 1.1 核心目标
- **统一抽象**：将 DAG、Loop、状态管理等复杂编排模式，统一为「写一段 JS 代码」的简单心智模型
- **类型安全**：通过 JSON Schema + 大模型原生 Tool Calling 机制，实现物理级别的结构化输出保证
- **轻量调度**：在 LLM 层面实现类操作系统的进程调度模型（Fork/Join、上下文隔离、资源回收）

### 1.2 设计原则
```
✅ 最小侵入：不修改宿主框架核心，通过 Tool 扩展实现能力注入
✅ 声明式编排：LLM 只需关注「做什么」，引擎负责「怎么做」
✅ 强类型契约：schema 即契约，返回即合规，消除运行时校验
✅ 用完即弃：子 Session 生命周期与 task() 调用严格绑定，自动回收
✅ 递归可组合：子 Agent 可再次调用 plan_and_execute，形成执行树
```

---

## 二、整体架构

```
┌─────────────────────────────────────────┐
│           LLM (Orchestrator)            │
│  ┌─────────────────────────────────┐   │
│  │ async function orchestrate() {  │   │
│  │   const a = await task("...", schemaA) │
│  │   const b = await task("...", schemaB) │
│  │   return { a, b }               │   │
│  │ }                               │   │
│  └─────────────────────────────────┘   │
└────────────────┬────────────────────────┘
                 │ plan_and_execute(code)
                 ▼
┌─────────────────────────────────────────┐
│         JS Orchestration Engine         │
│  • AsyncFunction 执行用户代码            │
│  • 注入 task<T>(prompt, schema) 原语    │
│  • 管理 Fork 生命周期与 Promise 解析    │
└────────────────┬────────────────────────┘
                 │ spawnTaskFork(...)
                 ▼
┌─────────────────────────────────────────┐
│           Child Session (Fork)          │
│  • 继承父级 context/tools/model         │
│  • 动态注入专属 return 工具 (带 schema) │
│  • 执行 prompt → 等待 return → 销毁    │
└────────────────┬────────────────────────┘
                 │ return(result)
                 ▼
┌─────────────────────────────────────────┐
│         Result Propagation              │
│  • 解析父级 Promise                    │
│  • 子 Session abort + 资源回收          │
│  • 返回值透传至 orchestrator           │
└─────────────────────────────────────────┘
```

---

## 三、核心 API 设计

### 3.1 注入给 LLM 的原语函数

```typescript
/**
 * Fork 当前上下文，创建子 Agent 执行指定任务
 * @template T - 返回值的 TypeScript 泛型，与 schema 强绑定
 * @param prompt - 子任务的自然语言指令
 * @param schema - (可选) JSON Schema，用于强制结构化输出
 * @returns Promise<T> - 解析后必定符合 schema 的 JavaScript 对象
 */
async function task<T>(prompt: string, schema?: JSONSchema<T>): Promise<T>;
```

### 3.2 工具注册定义

#### `plan_and_execute` 工具
```javascript
{
  name: 'plan_and_execute',
  description: `
    Write JavaScript to orchestrate complex tasks.
    
    Injected signature:
      async function task<T>(prompt: string, schema?: JSONSchema<T>): Promise<T>;
    
    Rules:
    • Call await task(...) to fork sub-agents
    • Use standard JS control flow (if/for/Promise.all)
    • MUST end with: return final_value;
  `,
  parameters: {
    type: 'object',
    properties: {
      code: { 
        type: 'string',
        description: 'Async function body JavaScript code'
      }
    },
    required: ['code']
  }
}
```

#### 动态生成的 `return` 工具（每次 Fork 时创建）
```javascript
{
  name: 'return',
  description: 'Submit final result and terminate this task fork. NO RETURN to caller.',
  parameters: {
    type: 'object',
    properties: {
      result: schema || { description: 'Task result (any type)' } // 动态绑定传入的 schema
    },
    required: ['result']
  },
  // execute: 解析父级 Promise + abort 当前 session + 隐藏 UI
}
```

---

## 四、执行模型详解

### 4.1 Fork 语义（类 POSIX fork）
```
父执行流: plan_and_execute 被调用 1 次
         ↓
      执行 JS 代码
         ↓
    await task("subtask", schema)  ←─┐
         │                           │
         │ 创建子 Session            │ 挂起父流，等待 Promise
         │ 注入专属 return 工具      │
         │ 继承 context + 历史消息   │
         ↓                           │
    子执行流: 执行 prompt          │
              ↓                      │
        调用 return(result) ◄────────┘
              ↓
        解析父级 Promise
        abort 子 Session
        资源回收
              ↓
    父执行流: task() 返回 result (类型 T)
              ↓
         继续执行 JS...
```

### 4.2 Context 继承策略
```javascript
// 子 Session 配置组装
const options = {
  cwd: rootCtx?.cwd,
  tools: [
    ...(rootCtx?.tools?.filter(t => t.name !== 'return') || []), // 移除旧 return
    dynamicReturnTool // 注入本次专属的、带 schema 的 return
  ],
  // 可选继承
  resourceLoader: parentSession?.resourceLoader,
  modelRegistry: parentSession?.modelRegistry,
  model: parentSession?.model,
};

// 历史消息深拷贝注入（让子 Agent 知晓宏观上下文）
if (parentSession?.state?.messages) {
  childSession.state.messages = JSON.parse(
    JSON.stringify(parentSession.state.messages)
  );
}
```

### 4.3 Schema 强制校验链路
```
1. LLM 编写: await task("extract", { type: "object", properties: { name: { type: "string" } } })
              ↓
2. executor: 将该 schema 注入 dynamicReturnTool.parameters.properties.result
              ↓
3. 子 Session: 调用大模型 API 时，将 return 工具定义（含 schema）作为 tools 参数传入
              ↓
4. 大模型: 生成 tool_call，若 result 字段不符合 schema → API 层拒绝 + 要求重试
              ↓
5. 引擎: 收到合规的 params.result → 解析 Promise → 父流获得 100% 类型安全的对象
```

### 4.4 `noreturn` 语义与防逃逸机制
```javascript
// return 工具执行时
async execute(params, childCtx) {
  childCtx.session._task_resolver(params.result); // 解析父级 Promise
  childCtx.session.abort(new Error('TASK_RETURN_CALLED')); // 立即终止子流
  return { display: false }; // 隐藏底层工具返回，避免干扰 LLM
}

// 子 Session 事件循环防御
while (!taskResolved) {
  await childSession.prompt(currentPrompt);
  
  // 如果流结束但未调用 return → 强制追问
  if (!taskResolved) {
    currentPrompt = "ERROR: You must call `return` tool to finish!";
  }
}
```

---

## 五、关键实现文件结构

```
plan-execute-extension/
├── index.js          # 入口：激活时注册 plan_and_execute 工具
├── tools.js          # 工具定义：plan_and_execute + 动态 return 生成逻辑
├── executor.js       # 执行引擎：JS 脚本执行 + Fork 生命周期管理
└── types.d.ts        # (可选) TypeScript 类型定义，辅助 LLM 理解签名
```

### 核心依赖传递（无 Patch 设计）
```javascript
// index.js
export function activate(pi, ctx) {
  registerPlanAndExecuteTool(pi, ctx); // 直接透传 pi
}

// tools.js → executor.js → spawnTaskFork
// 全程通过参数传递 pi，避免全局状态污染
```

---

## 六、使用示例

### 6.1 基础场景：串行 + 并行混合
```javascript
// LLM 生成的 orchestration code
const [frontend, backend] = await Promise.all([
  task("Implement React Button component", componentSchema),
  task("Implement Express /api/button route", routeSchema)
]);

const integration = await task(
  `Integrate: ${JSON.stringify({ frontend, backend })}`,
  integrationSchema
);

return { status: "done", artifact: integration };
```

### 6.2 循环 + 条件判断
```javascript
let code = await task("Generate initial code", codeSchema);
let review = await task(`Review: ${code}`, reviewSchema);

while (review.issues.length > 0) {
  code = await task(`Fix: ${review.issues}`, codeSchema);
  review = await task(`Re-review: ${code}`, reviewSchema);
}

return { finalCode: code, reviewSummary: review.summary };
```

### 6.3 嵌套编排（递归 Fork）
```javascript
// 主 orchestrator
const modules = await task("List project modules", moduleListSchema);

// 子 orchestrator (在子 Agent 内部再次调用 plan_and_execute)
const results = await Promise.all(
  modules.map(m => task(`Implement ${m.name}`, {
    type: "object",
    properties: {
      code: { type: "string" },
      tests: { type: "array" }
    }
  }))
);

return { modules: results };
```

---

## 七、扩展性与最佳实践

### 7.1 类型定义辅助（提升 LLM 理解）
```typescript
// types.d.ts - 可作为 system prompt 片段注入
interface JSONSchema<T = any> {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
}

declare function task<T>(
  prompt: string, 
  schema?: JSONSchema<T>
): Promise<T>;
```

### 7.2 错误处理与超时
```javascript
// 在 executor 中添加
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('Task timeout')), 300000) // 5min
);

const result = await Promise.race([
  resultPromise,
  ...(parentSignal ? [new Promise((_, r) => parentSignal.addEventListener('abort', () => r(new Error('Parent aborted'))))] : []),
  timeoutPromise
]);
```

### 7.3 调试与可观测性
```javascript
// 在 taskSpawner 中添加日志
const taskSpawner = async (prompt, schema) => {
  rootCtx?.ui?.notify?.(`[Fork] task: ${prompt.slice(0, 50)}...`, 'debug');
  const start = Date.now();
  const result = await spawnTaskFork(...);
  rootCtx?.ui?.notify?.(`[Join] +${Date.now() - start}ms`, 'debug');
  return result;
};
```

### 7.4 资源清理最佳实践
```javascript
// spawnTaskFork 末尾
try {
  await resultPromise;
} finally {
  // 确保即使异常也能回收
  if (typeof childSession.destroy === 'function') {
    childSession.destroy();
  }
  delete childSession._task_resolver; // 断开闭包引用
}
```

---

## 八、与现有方案的对比优势

| 能力 | 传统 DAG/Loop | Plan & Execute Engine |
|------|--------------|----------------------|
| **编排表达** | 配置式/硬编码 | 原生 JS，图灵完备 |
| **类型安全** | 运行时校验/手动解析 | Schema + Tool Calling 物理保证 |
| **上下文传递** | 显式传参/全局状态 | 自动继承 + 历史消息注入 |
| **嵌套能力** | 需特殊设计 | 天然支持（子 Agent 也可 fork） |
| **调试体验** | 黑盒执行 | JS 代码 + 日志 + 逐层返回 |
| **扩展成本** | 新增节点需改框架 | 新增能力只需注册新 Tool |

---

## 九、潜在演进方向

1. **增量执行**：缓存 task(prompt, schema) 的结果，相同输入直接返回
2. **优先级调度**：task(prompt, schema, { priority: 'high' }) 支持紧急任务插队
3. **资源配额**：限制子 Session 的 token 用量/执行时长，防止失控
4. **可视化调试**：将执行树渲染为可交互的 DAG 图，支持断点/重放
5. **多模态扩展**：task 支持 image/audio 等富媒体 schema，拓展应用场景

---

> **设计哲学总结**：  
> 「让 LLM 写代码来调度 LLM」—— 通过将控制流下放为可执行的 JavaScript，配合强类型契约与轻量级进程模型，我们获得了一个既灵活又可靠的 Agent 编排范式。这不是在框架内硬编码工作流，而是赋予系统「自我编排」的元能力。
