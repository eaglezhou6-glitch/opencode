import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { dbPath, indexAll, indexFile, open, removeFile, root } from "./lib"

const base = root(process.cwd())
await fs.mkdir(base, { recursive: true })

const db = open(dbPath(base))
const once = process.argv.includes("--once")
const stats = await indexAll(db, base)

console.log(`Indexed ${stats.files} files (${stats.chunks} chunks).`)

if (once) {
  db.close()
  process.exit(0)
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
const delay = 200

function schedule(file: string) {
  if (!file.endsWith(".md")) return
  const prev = pending.get(file)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    pending.delete(file)
    if (!existsSync(file)) {
      removeFile(db, file)
      return
    }
    void indexFile(db, file)
  }, delay)
  pending.set(file, timer)
}

Bun.watch({
  path: base,
  recursive: true,
  onChange: (_event, file) => {
    if (!file) return
    const full = path.isAbsolute(file) ? file : path.join(base, file)
    schedule(full)
  },
})

console.log(`Watching ${base}`)
