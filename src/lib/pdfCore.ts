import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { parsePageRange } from './pageRanges'
import type { MergeRecipe, SourceDocument } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url,
).toString()

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    cMapPacked: true,
    cMapUrl: '/pdfjs/cmaps/',
    data: new Uint8Array(data.slice(0)),
    disableFontFace: false,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    useSystemFonts: true,
    useWorkerFetch: false,
    wasmUrl: '/pdfjs/wasm/',
  }).promise
}

export async function readPdfFile(file: File): Promise<SourceDocument> {
  const data = await file.arrayBuffer()
  const pdf = await loadPdf(data)
  try {
    const pageCount = pdf.numPages
    return {
      id: crypto.randomUUID(),
      fileName: file.name,
      pageCount,
      size: file.size,
      data,
      rangeText: `1-${pageCount}`,
      rotation: 0,
    }
  } finally {
    void pdf.destroy()
  }
}

export async function mergeDocuments(recipe: MergeRecipe): Promise<ArrayBuffer> {
  const output = await PDFDocument.create()
  output.setTitle(recipe.title || '병합 PDF')
  output.setAuthor(recipe.author || '브라우저 PDF 편집기')
  output.setProducer('브라우저 PDF 편집기')
  output.setCreator('브라우저 PDF 편집기')
  output.setCreationDate(new Date())
  output.setModificationDate(new Date())

  const separatorFont = recipe.addSeparatorPages
    ? await output.embedFont(StandardFonts.Helvetica)
    : null

  for (const [sourceIndex, source] of recipe.sources.entries()) {
    const input = await PDFDocument.load(source.data.slice(0), {
      ignoreEncryption: false,
    })
    const pages = parsePageRange(source.rangeText, input.getPageCount())
    const copiedPages = await output.copyPages(
      input,
      pages.map((page) => page - 1),
    )
    for (const copiedPage of copiedPages) {
      if (source.rotation !== 0) copiedPage.setRotation(degrees(source.rotation))
      output.addPage(copiedPage)
    }
    if (recipe.addSeparatorPages && sourceIndex < recipe.sources.length - 1 && separatorFont) {
      const separator = output.addPage([595.28, 841.89])
      separator.drawText('PDF Separator', {
        x: 72,
        y: 760,
        size: 18,
        font: separatorFont,
        color: rgb(0.05, 0.46, 0.43),
      })
      separator.drawText(`Next file: ${recipe.sources[sourceIndex + 1].fileName}`, {
        x: 72,
        y: 728,
        size: 12,
        font: separatorFont,
        color: rgb(0.25, 0.32, 0.29),
      })
    }
  }

  const saved = await output.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

export async function extractPages(
  source: SourceDocument,
  rangeText: string,
): Promise<ArrayBuffer> {
  return extractPagesFromData(source.data, source.fileName, rangeText)
}

export async function extractPagesFromData(
  data: ArrayBuffer,
  fileName: string,
  rangeText: string,
): Promise<ArrayBuffer> {
  const input = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: false,
  })
  const output = await PDFDocument.create()
  output.setTitle(`${fileName} 추출`)
  output.setAuthor('브라우저 PDF 편집기')
  const pages = parsePageRange(rangeText, input.getPageCount())
  const copiedPages = await output.copyPages(
    input,
    pages.map((page) => page - 1),
  )
  copiedPages.forEach((page) => output.addPage(page))
  const saved = await output.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

export async function reorderPdfPages(
  data: ArrayBuffer,
  pageOrder: number[],
): Promise<ArrayBuffer> {
  const input = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: false,
  })
  const pageCount = input.getPageCount()
  if (pageOrder.length !== pageCount) throw new Error('페이지 순서 정보가 현재 PDF와 맞지 않습니다.')
  const seen = new Set(pageOrder)
  if (seen.size !== pageCount || pageOrder.some((page) => page < 1 || page > pageCount)) {
    throw new Error('페이지 순서 정보가 올바르지 않습니다.')
  }

  const output = await PDFDocument.create()
  output.setTitle(input.getTitle() ?? '재정렬 PDF')
  output.setAuthor(input.getAuthor() ?? '브라우저 PDF 편집기')
  output.setProducer('브라우저 PDF 편집기')
  output.setCreator('브라우저 PDF 편집기')
  output.setCreationDate(input.getCreationDate() ?? new Date())
  output.setModificationDate(new Date())
  const copiedPages = await output.copyPages(
    input,
    pageOrder.map((page) => page - 1),
  )
  copiedPages.forEach((page) => output.addPage(page))
  const saved = await output.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

export async function rotatePdfPages(
  data: ArrayBuffer,
  pages: number[],
  delta: -90 | 90,
): Promise<ArrayBuffer> {
  const input = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: false,
  })
  const pageCount = input.getPageCount()
  validatePages(pages, pageCount)
  for (const pageNumber of pages) {
    const page = input.getPage(pageNumber - 1)
    const currentAngle = page.getRotation().angle
    page.setRotation(degrees((currentAngle + delta + 360) % 360))
  }
  const saved = await input.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

export async function deletePdfPages(
  data: ArrayBuffer,
  pages: number[],
): Promise<ArrayBuffer> {
  const input = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: false,
  })
  const pageCount = input.getPageCount()
  validatePages(pages, pageCount)
  if (new Set(pages).size >= pageCount) throw new Error('모든 페이지를 삭제할 수는 없습니다.')
  const deleteSet = new Set(pages)
  const output = await PDFDocument.create()
  const keepPages = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => !deleteSet.has(page))
  const copiedPages = await output.copyPages(
    input,
    keepPages.map((page) => page - 1),
  )
  copiedPages.forEach((page) => output.addPage(page))
  const saved = await output.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

export async function duplicatePdfPages(
  data: ArrayBuffer,
  pages: number[],
): Promise<ArrayBuffer> {
  const input = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: false,
  })
  const pageCount = input.getPageCount()
  validatePages(pages, pageCount)
  const duplicateSet = new Set(pages)
  const output = await PDFDocument.create()
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const [page] = await output.copyPages(input, [pageNumber - 1])
    output.addPage(page)
    if (duplicateSet.has(pageNumber)) {
      const [copy] = await output.copyPages(input, [pageNumber - 1])
      output.addPage(copy)
    }
  }
  const saved = await output.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

function validatePages(pages: number[], pageCount: number): void {
  if (pages.length === 0) throw new Error('작업할 페이지 범위를 입력하세요.')
  const unique = new Set(pages)
  if (unique.size !== pages.length || pages.some((page) => page < 1 || page > pageCount)) {
    throw new Error('페이지 범위가 현재 PDF와 맞지 않습니다.')
  }
}

export function downloadBytes(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
  mime = 'application/pdf',
): void {
  const blobPart =
    data instanceof Uint8Array ? new Uint8Array(data).buffer : data
  const blob = new Blob([blobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
