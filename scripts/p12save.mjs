import { readFile } from 'node:fs/promises'
import * as mupdf from 'mupdf'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const buf = await readFile('/Users/user/projects/test/문제파일2.pdf')
const data = new Uint8Array(buf)
const CMAP = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).pathname
const PAGE = 12

async function pdfjsText(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), cMapUrl: CMAP, cMapPacked: true }).promise
  const page = await doc.getPage(PAGE)
  const tc = await page.getTextContent()
  const vp = page.getViewport({ scale: 1 })
  const items = []
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const t = pdfjs.Util.transform(vp.transform, it.transform)
    items.push({ s: it.str, x: Math.round(t[4]), y: Math.round(t[5] - 8) })
  }
  await doc.destroy()
  return items
}

const before = await pdfjsText(data)
process.stdout.write(`before pdf.js items on page ${PAGE}: ${before.length}\n`)

// Replicate app element-delete: redact MHC rect, save with garbage=2.
const doc = mupdf.Document.openDocument(data.slice(0), 'application/pdf').asPDF()
const page = doc.loadPage(PAGE - 1)
const a = page.createAnnotation('Redact')
a.setRect([440, 245, 466, 256])
a.update()
page.applyRedactions(false, 1, 2, 0)
const saved = doc.saveToBuffer('garbage=2')
const outBytes = new Uint8Array(saved.asUint8Array())

const after = await pdfjsText(outBytes)
process.stdout.write(`after  pdf.js items on page ${PAGE}: ${after.length}\n`)

const akey = (i) => `${i.s}@${i.x},${i.y}`
const aset = new Set(after.map(akey))
const removed = before.filter((i) => !aset.has(akey(i)))
process.stdout.write(`\nREMOVED ${removed.length} pdf.js items (sorted by y):\n`)
for (const i of removed.sort((p, q) => p.y - q.y)) process.stdout.write(`  - y=${i.y} x=${i.x} ${JSON.stringify(i.s).slice(0, 24)}\n`)
