import { readFile } from 'node:fs/promises'
import * as mupdf from 'mupdf'

const buf = await readFile('/Users/user/projects/test/문제파일2.pdf')
const data = new Uint8Array(buf)
const PAGE = 12

function lines(p) {
  const st = JSON.parse(p.toStructuredText().asJSON())
  const o = []
  for (const b of st.blocks ?? []) for (const l of b.lines ?? []) o.push(l)
  return o
}
function loadPage() {
  const d = mupdf.Document.openDocument(data.slice(0), 'application/pdf').asPDF()
  return d.loadPage(PAGE - 1)
}

const before = lines(loadPage())
console.error('--- before lines:', before.length)

// redact a small rect over the first MHC occurrence (mupdf bbox ~ 440,247)
const page = loadPage()
const rect = [440, 245, 466, 256]
const a = page.createAnnotation('Redact')
a.setRect(rect)
a.update()
page.applyRedactions(false, 1, 2, 0)
const after = lines(page)

const key = (l) => `${l.text}@${Math.round(l.bbox.x)},${Math.round(l.bbox.y)}`
const ak = new Set(after.map(key))
const removed = before.filter((l) => !ak.has(key(l)))
// print to stdout (warnings go to stderr)
process.stdout.write(`\nredact rect ${JSON.stringify(rect)}\nbefore/after lines: ${before.length}/${after.length}\nREMOVED ${removed.length} lines:\n`)
for (const l of removed) process.stdout.write(`  - ${JSON.stringify(l.text).slice(0, 40)} @ ${Math.round(l.bbox.x)},${Math.round(l.bbox.y)}\n`)
