import { readFile } from 'node:fs/promises'
import * as mupdf from 'mupdf'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const buf = await readFile('/Users/user/projects/test/문제파일2.pdf')
const data = new Uint8Array(buf)
const CMAP = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).pathname
const PAGE = 12

function boxOf(obj, name) {
  let o = obj
  for (let d = 0; o && !o.isNull() && d < 16; d += 1) {
    const b = o.get(name)
    if (b && !b.isNull() && b.isArray()) return [0,1,2,3].map((i) => b.get(i).asNumber())
    o = o.get('Parent')
  }
  return null
}

const mdoc = mupdf.Document.openDocument(data.slice(0), 'application/pdf').asPDF()
const mp = mdoc.loadPage(PAGE - 1)
const obj = mp.getObject()
console.log('=== mupdf page', PAGE, '===')
console.log('  getBounds =', mp.getBounds())
console.log('  MediaBox  =', boxOf(obj, 'MediaBox'))
console.log('  CropBox   =', boxOf(obj, 'CropBox'))
const rot = obj.get('Rotate')
console.log('  Rotate    =', rot && !rot.isNull() ? rot.asNumber() : '(none/inherited)')
const userUnit = obj.get('UserUnit')
console.log('  UserUnit  =', userUnit && !userUnit.isNull() ? userUnit.asNumber() : '(none)')

const st = JSON.parse(mp.toStructuredText().asJSON())
const mlines = []
for (const b of st.blocks ?? []) for (const l of b.lines ?? []) mlines.push(l)
console.log('  mupdf MHC search:')
for (const q of mp.search('MHC', 10)) {
  const xs = q.flatMap((p) => [p[0], p[2], p[4], p[6]]); const ys = q.flatMap((p) => [p[1], p[3], p[5], p[7]])
  console.log('    @', Math.round(Math.min(...xs)), Math.round(Math.min(...ys)))
}

const jsDoc = await pdfjs.getDocument({ data: data.slice(0), cMapUrl: CMAP, cMapPacked: true }).promise
const page = await jsDoc.getPage(PAGE)
const vp = page.getViewport({ scale: 1 })
console.log('\n=== pdf.js page', PAGE, '===')
console.log('  view =', page.view, 'rotate =', page.rotate, 'userUnit =', page.userUnit)
console.log('  viewport w/h =', Math.round(vp.width), Math.round(vp.height), 'transform', vp.transform.map((n) => Math.round(n * 100) / 100))
const tc = await page.getTextContent()
console.log('  pdf.js MHC items:')
for (const it of tc.items) {
  if (!('str' in it) || !it.str.includes('MHC')) continue
  const t = pdfjs.Util.transform(vp.transform, it.transform)
  console.log('    @', Math.round(t[4]), Math.round(t[5] - 8), JSON.stringify(it.str).slice(0, 16))
}
