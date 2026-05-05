import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CORE_MODULES = [
  'auto-dispatch', 'gsd-db', 'auto-prompts', 'reactive-graph', 'rule-registry',
]

function resolveCoreExtDir() {
  const root = process.env.GSD_PKG_ROOT
  if (!root) return null
  return path.join(root, 'dist', 'resources', 'extensions', 'gsd')
}

export async function loadGsdCore() {
  const dir = resolveCoreExtDir()
  if (!dir || !fs.existsSync(dir)) return null

  const isComplete = CORE_MODULES.every(m => fs.existsSync(path.join(dir, `${m}.js`)))
  if (!isComplete) return null

  const loaded = {}
  try {
    for (const mod of CORE_MODULES) {
      loaded[mod] = await import(pathToFileURL(path.join(dir, `${mod}.js`)).href)
    }
    return loaded
  } catch {
    return null
  }
}
