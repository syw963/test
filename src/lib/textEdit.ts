import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import notoSansKrUrl from '@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf?url'
import { loadPdf } from './pdfCore'
import type { EditMethod, EditOperation, OverlayTextStyle, TextOccurrence, TextOccurrenceRect } from '../types'

type MuPdfModule = typeof import('mupdf')
type PdfObject = InstanceType<MuPdfModule['PDFObject']>
type MuPdfDocument = InstanceType<MuPdfModule['Document']>
type MuPdfPage = InstanceType<MuPdfModule['Page']>
type MuPdfPDFPage = InstanceType<MuPdfModule['PDFPage']>
type MuPdfQuad = import('mupdf').Quad
type Quad = number[]

interface ReplaceResult {
  changed: boolean
  content: string
  method?: string
}

interface FontEncodingMap {
  codeLengths: number[]
  codeToText: Map<string, string>
  textToCode: Map<string, string>
}

interface TextSegment {
  end: number
  encode: (value: string) => string | null
  method: string
  start: number
  text: string
}

interface RedactionOptions {
  deleteAnnotations?: boolean
  deleteLinks?: boolean
  imageMethod?: number
  lineArtMethod?: number
  padding?: number
  textMethod?: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function hexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/\s+/g, '')
  const bytes = new Uint8Array(Math.floor(compact.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function parseLiteralBytes(value: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      bytes.push(char.charCodeAt(0) & 0xff)
      continue
    }

    const next = value[index + 1]
    if (!next) continue
    if (next === 'n') bytes.push(0x0a)
    else if (next === 'r') bytes.push(0x0d)
    else if (next === 't') bytes.push(0x09)
    else if (next === 'b') bytes.push(0x08)
    else if (next === 'f') bytes.push(0x0c)
    else if (next === '\n' || next === '\r') {
      index += next === '\r' && value[index + 2] === '\n' ? 2 : 1
      continue
    } else if (/[0-7]/.test(next)) {
      let octal = next
      let offset = 2
      while (offset <= 3 && /[0-7]/.test(value[index + offset] ?? '')) {
        octal += value[index + offset]
        offset += 1
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      index += octal.length
      continue
    } else {
      bytes.push(next.charCodeAt(0) & 0xff)
    }
    index += 1
  }
  return new Uint8Array(bytes)
}

function decodePdfLiteral(value: string): string {
  return decodeSingleByteText(parseLiteralBytes(value))
}

function encodePdfLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function decodeSingleByteText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
}

function encodeSingleByteText(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0xff) return null
    bytes[index] = code
  }
  return bytes
}

function decodeUtf16Be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) return ''
  let output = ''
  const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0
  for (let index = start; index < bytes.length; index += 2) {
    output += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
  }
  return output
}

function encodeUtf16Be(value: string, withBom: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2 + (withBom ? 2 : 0))
  let offset = 0
  if (withBom) {
    bytes[0] = 0xfe
    bytes[1] = 0xff
    offset = 2
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    bytes[offset + index * 2] = code >> 8
    bytes[offset + index * 2 + 1] = code & 0xff
  }
  return bytes
}

function hexToText(hex: string): string {
  const bytes = hexToBytes(hex)
  let output = ''
  for (let index = 0; index < bytes.length; index += 2) {
    output += String.fromCharCode((bytes[index] << 8) | (bytes[index + 1] ?? 0))
  }
  return output
}

function numberToHex(value: number, byteLength: number): string {
  return value.toString(16).toUpperCase().padStart(byteLength * 2, '0')
}

function parseCMap(cmap: string): FontEncodingMap {
  const codeToText = new Map<string, string>()
  const textToCode = new Map<string, string>()
  const record = (code: string, text: string) => {
    const normalized = code.replace(/\s+/g, '').toUpperCase()
    codeToText.set(normalized, text)
    if (!textToCode.has(text)) textToCode.set(text, normalized)
  }

  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const line of section[1].split(/\r?\n/)) {
      const match = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/)
      if (match) record(match[1], hexToText(match[2]))
    }
  }

  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of section[1].split(/\r?\n/)) {
      const arrayMatch = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+\[([^\]]+)\]/)
      if (arrayMatch) {
        const start = Number.parseInt(arrayMatch[1], 16)
        const byteLength = arrayMatch[1].length / 2
        const values = Array.from(arrayMatch[3].matchAll(/<([0-9a-fA-F]+)>/g), (match) => match[1])
        values.forEach((value, offset) => record(numberToHex(start + offset, byteLength), hexToText(value)))
        continue
      }

      const rangeMatch = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/)
      if (!rangeMatch) continue
      const start = Number.parseInt(rangeMatch[1], 16)
      const end = Number.parseInt(rangeMatch[2], 16)
      const byteLength = rangeMatch[1].length / 2
      const targetStart = Number.parseInt(rangeMatch[3], 16)
      for (let code = start; code <= end; code += 1) {
        record(numberToHex(code, byteLength), hexToText(numberToHex(targetStart + code - start, rangeMatch[3].length / 2)))
      }
    }
  }

  const codeLengths = Array.from(
    new Set(Array.from(codeToText.keys(), (code) => code.length / 2)),
  ).sort((a, b) => b - a)

  return { codeLengths, codeToText, textToCode }
}

function decodeWithCMap(bytes: Uint8Array, map: FontEncodingMap): string | null {
  let output = ''
  for (let index = 0; index < bytes.length;) {
    let matched = false
    for (const length of map.codeLengths) {
      if (index + length > bytes.length) continue
      const code = bytesToHex(bytes.slice(index, index + length))
      const text = map.codeToText.get(code)
      if (!text) continue
      output += text
      index += length
      matched = true
      break
    }
    if (!matched) return null
  }
  return output
}

function encodeWithCMap(value: string, map: FontEncodingMap): Uint8Array | null {
  let hex = ''
  for (const char of Array.from(value)) {
    const code = map.textToCode.get(char)
    if (!code) return null
    hex += code
  }
  return hexToBytes(hex)
}

function getFontEncodingMaps(pageObject: PdfObject): Map<string, FontEncodingMap> {
  const maps = new Map<string, FontEncodingMap>()
  const resources = pageObject.getInheritable('Resources')
  if (resources.isNull()) return maps
  const fonts = resources.get('Font')
  if (fonts.isNull() || !fonts.isDictionary()) return maps

  fonts.forEach((fontObject, key) => {
    try {
      const font = fontObject.resolve()
      const toUnicode = font.get('ToUnicode')
      if (toUnicode.isNull() || !toUnicode.isStream()) return
      const map = parseCMap(toUnicode.readStream().asString())
      if (map.codeToText.size > 0) maps.set(String(key), map)
    } catch {
      // Some font dictionaries are malformed; skip them and keep editing other fonts.
    }
  })

  return maps
}

function isDelimiter(char: string): boolean {
  return /\s/.test(char) || '[]<>/(){}%'.includes(char)
}

function parseLiteralEnd(content: string, start: number): number {
  let depth = 1
  for (let index = start + 1; index < content.length; index += 1) {
    const char = content[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return start + 1
}

function makeHexSegment(
  start: number,
  end: number,
  hex: string,
  fontMap: FontEncodingMap | undefined,
): TextSegment {
  const bytes = hexToBytes(hex)
  const cmapText = fontMap ? decodeWithCMap(bytes, fontMap) : null
  if (cmapText !== null && fontMap) {
    return {
      start,
      end,
      text: cmapText,
      method: 'ToUnicode subset 폰트 hex 문자열',
      encode: (value) => {
        const encoded = encodeWithCMap(value, fontMap)
        return encoded ? `<${bytesToHex(encoded)}>` : null
      },
    }
  }

  const utf16Text = decodeUtf16Be(bytes)
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || utf16Text.includes('\u0000')) {
    return {
      start,
      end,
      text: utf16Text,
      method: 'hex UTF-16BE 문자열',
      encode: (value) => `<${bytesToHex(encodeUtf16Be(value, bytes[0] === 0xfe && bytes[1] === 0xff))}>`,
    }
  }

  return {
    start,
    end,
    text: decodeSingleByteText(bytes),
    method: 'hex 단일바이트 문자열',
    encode: (value) => {
      const encoded = encodeSingleByteText(value)
      return encoded ? `<${bytesToHex(encoded)}>` : null
    },
  }
}

function makeLiteralSegment(
  start: number,
  end: number,
  literal: string,
  fontMap: FontEncodingMap | undefined,
): TextSegment {
  const bytes = parseLiteralBytes(literal)
  const cmapText = fontMap ? decodeWithCMap(bytes, fontMap) : null
  if (cmapText !== null && fontMap) {
    return {
      start,
      end,
      text: cmapText,
      method: 'ToUnicode subset 폰트 literal 문자열',
      encode: (value) => {
        const encoded = encodeWithCMap(value, fontMap)
        return encoded ? `<${bytesToHex(encoded)}>` : null
      },
    }
  }

  return {
    start,
    end,
    text: decodePdfLiteral(literal),
    method: 'literal 문자열',
    encode: (value) => `(${encodePdfLiteral(value)})`,
  }
}

function scanTextSegments(
  content: string,
  fontMaps: Map<string, FontEncodingMap>,
): TextSegment[] {
  const segments: TextSegment[] = []
  const operands: string[] = []
  let currentFont: string | undefined

  for (let index = 0; index < content.length;) {
    const char = content[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '%') {
      const nextLine = content.indexOf('\n', index)
      index = nextLine === -1 ? content.length : nextLine + 1
      continue
    }
    if (char === '/') {
      let end = index + 1
      while (end < content.length && !isDelimiter(content[end])) end += 1
      operands.push(content.slice(index, end))
      index = end
      continue
    }
    if (char === '(') {
      const end = parseLiteralEnd(content, index)
      segments.push(makeLiteralSegment(index, end, content.slice(index + 1, end - 1), currentFont ? fontMaps.get(currentFont) : undefined))
      operands.push('string')
      index = end
      continue
    }
    if (char === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index + 1)
      if (end === -1) break
      segments.push(makeHexSegment(index, end + 1, content.slice(index + 1, end), currentFont ? fontMaps.get(currentFont) : undefined))
      operands.push('string')
      index = end + 1
      continue
    }
    if ('[]{}'.includes(char)) {
      index += 1
      continue
    }

    let end = index + 1
    while (end < content.length && !isDelimiter(content[end])) end += 1
    const word = content.slice(index, end)
    if (/^[A-Za-z'"*]+$/.test(word)) {
      if (word === 'Tf') {
        const fontName = [...operands].reverse().find((operand) => operand.startsWith('/'))
        if (fontName) currentFont = fontName.slice(1)
      }
      operands.length = 0
    } else {
      operands.push(word)
    }
    index = end
  }

  return segments
}

function replaceAcrossSegments(
  content: string,
  segments: TextSegment[],
  originalText: string,
  replacementText: string,
  occurrenceIndex?: number,
): ReplaceResult {
  const combined = segments.map((segment) => segment.text).join('')
  const matchStart = findOccurrenceIndex(combined, originalText, occurrenceIndex)
  if (matchStart === -1) return { changed: false, content }
  if (occurrenceIndex === undefined && combined.indexOf(originalText, matchStart + originalText.length) !== -1) {
    return { changed: false, content }
  }

  const matchEnd = matchStart + originalText.length
  let cursor = 0
  const affected: Array<TextSegment & { from: number; to: number }> = []
  for (const segment of segments) {
    const from = cursor
    const to = cursor + segment.text.length
    if (to > matchStart && from < matchEnd) affected.push({ ...segment, from, to })
    cursor = to
  }
  if (affected.length === 0) return { changed: false, content }

  const first = affected[0]
  const last = affected[affected.length - 1]
  const firstPrefix = first.text.slice(0, Math.max(0, matchStart - first.from))
  const lastSuffix = last.text.slice(Math.max(0, matchEnd - last.from))
  const firstReplacement = first.encode(`${firstPrefix}${replacementText}${lastSuffix}`)
  if (firstReplacement === null) return { changed: false, content }

  const replacements = new Map<TextSegment, string | null>()
  replacements.set(first, firstReplacement)
  for (const segment of affected.slice(1)) {
    const empty = segment.encode('')
    if (empty === null) return { changed: false, content }
    replacements.set(segment, empty)
  }

  let nextContent = content
  for (const segment of [...affected].sort((a, b) => b.start - a.start)) {
    const replacement = replacements.get(segment)
    if (replacement === undefined || replacement === null) return { changed: false, content }
    nextContent = `${nextContent.slice(0, segment.start)}${replacement}${nextContent.slice(segment.end)}`
  }

  const method = affected.length > 1 ? `${first.method} 조각 ${affected.length}개` : first.method
  return { changed: true, content: nextContent, method }
}

function findOccurrenceIndex(value: string, search: string, occurrenceIndex?: number): number {
  if (occurrenceIndex === undefined) return value.indexOf(search)
  let offset = 0
  for (let index = 0; index <= occurrenceIndex; index += 1) {
    const found = value.indexOf(search, offset)
    if (found === -1) return -1
    if (index === occurrenceIndex) return found
    offset = found + search.length
  }
  return -1
}

function countTextOccurrences(value: string, search: string): number {
  if (!search) return 0
  let count = 0
  let offset = 0
  for (;;) {
    const found = value.indexOf(search, offset)
    if (found === -1) return count
    count += 1
    offset = found + search.length
  }
}

function countStreamTextOccurrences(
  content: string,
  originalText: string,
  fontMaps: Map<string, FontEncodingMap>,
): number {
  const segments = scanTextSegments(content, fontMaps)
  const combined = segments.map((segment) => segment.text).join('')
  const segmentCount = countTextOccurrences(combined, originalText)
  if (segmentCount > 0) return segmentCount
  return countTextOccurrences(content, originalText)
}

function replaceHexStrings(
  content: string,
  originalText: string,
  replacementText: string,
  occurrenceIndex?: number,
): ReplaceResult {
  const hexPattern = /<([0-9a-fA-F\s]+)>/g
  let method: string | undefined
  let seen = 0
  const nextContent = content.replace(hexPattern, (token, hex: string) => {
    if (method) return token
    const bytes = hexToBytes(hex)
    const singleByteText = decodeSingleByteText(bytes)
    if (singleByteText.includes(originalText)) {
      const count = countTextOccurrences(singleByteText, originalText)
      if (occurrenceIndex !== undefined && occurrenceIndex >= seen + count) {
        seen += count
        return token
      }
      const target = occurrenceIndex === undefined ? undefined : occurrenceIndex - seen
      const matchStart = findOccurrenceIndex(singleByteText, originalText, target)
      const nextText = target === undefined
        ? singleByteText.replace(originalText, replacementText)
        : `${singleByteText.slice(0, matchStart)}${replacementText}${singleByteText.slice(matchStart + originalText.length)}`
      const encoded = encodeSingleByteText(nextText)
      if (!encoded) return token
      method = 'hex 단일바이트 문자열'
      return `<${bytesToHex(encoded)}>`
    }

    const utf16Text = decodeUtf16Be(bytes)
    if (utf16Text.includes(originalText)) {
      const count = countTextOccurrences(utf16Text, originalText)
      if (occurrenceIndex !== undefined && occurrenceIndex >= seen + count) {
        seen += count
        return token
      }
      const target = occurrenceIndex === undefined ? undefined : occurrenceIndex - seen
      const matchStart = findOccurrenceIndex(utf16Text, originalText, target)
      const nextText = target === undefined
        ? utf16Text.replace(originalText, replacementText)
        : `${utf16Text.slice(0, matchStart)}${replacementText}${utf16Text.slice(matchStart + originalText.length)}`
      method = 'hex UTF-16BE 문자열'
      return `<${bytesToHex(encodeUtf16Be(nextText, bytes[0] === 0xfe && bytes[1] === 0xff))}>`
    }

    return token
  })

  return { changed: Boolean(method), content: nextContent, method }
}

function replaceLiteralStrings(
  content: string,
  originalText: string,
  replacementText: string,
  occurrenceIndex?: number,
): ReplaceResult {
  const literalPattern = /\(((?:\\.|[^\\()])*)\)/g
  let method: string | undefined
  let seen = 0
  const nextContent = content.replace(literalPattern, (token, literal: string) => {
    if (method) return token
    const decoded = decodePdfLiteral(literal)
    if (!decoded.includes(originalText)) return token
    const count = countTextOccurrences(decoded, originalText)
    if (occurrenceIndex !== undefined && occurrenceIndex >= seen + count) {
      seen += count
      return token
    }
    const target = occurrenceIndex === undefined ? undefined : occurrenceIndex - seen
    const matchStart = findOccurrenceIndex(decoded, originalText, target)
    const nextText = target === undefined
      ? decoded.replace(originalText, replacementText)
      : `${decoded.slice(0, matchStart)}${replacementText}${decoded.slice(matchStart + originalText.length)}`
    method = 'literal 문자열'
    return `(${encodePdfLiteral(nextText)})`
  })

  return { changed: Boolean(method), content: nextContent, method }
}

function replaceInContentStream(
  content: string,
  originalText: string,
  replacementText: string,
  fontMaps: Map<string, FontEncodingMap>,
  occurrenceIndex?: number,
): ReplaceResult {
  const segmentResult = replaceAcrossSegments(
    content,
    scanTextSegments(content, fontMaps),
    originalText,
    replacementText,
    occurrenceIndex,
  )
  if (segmentResult.changed) return segmentResult

  const hexResult = replaceHexStrings(content, originalText, replacementText, occurrenceIndex)
  if (hexResult.changed) return hexResult

  const literalResult = replaceLiteralStrings(content, originalText, replacementText, occurrenceIndex)
  if (literalResult.changed) return literalResult

  const directPattern = new RegExp(escapeRegExp(originalText), 'g')
  if (directPattern.test(content)) {
    if (occurrenceIndex !== undefined) {
      const matchStart = findOccurrenceIndex(content, originalText, occurrenceIndex)
      if (matchStart === -1) return { changed: false, content }
      return {
        changed: true,
        content: `${content.slice(0, matchStart)}${replacementText}${content.slice(matchStart + originalText.length)}`,
        method: '비압축 직접 문자열',
      }
    }
    return {
      changed: true,
      content: content.replace(directPattern, replacementText),
      method: '비압축 직접 문자열',
    }
  }

  return { changed: false, content }
}

function getContentStreams(pageObject: PdfObject): PdfObject[] {
  const contents = pageObject.get('Contents')
  if (contents.isStream()) return [contents]
  const resolved = contents.resolve()
  if (resolved.isStream()) return [resolved]
  if (!resolved.isArray()) return []

  const streams: PdfObject[] = []
  for (let index = 0; index < resolved.length; index += 1) {
    const item = resolved.get(index)
    if (item.isStream()) streams.push(item)
    else {
      const resolvedItem = item.resolve()
      if (resolvedItem.isStream()) streams.push(resolvedItem)
    }
  }
  return streams
}

function occurrenceFromQuads(
  quads: Quad[],
  index: number,
  pageNumber: number,
  text: string,
): TextOccurrence {
  const xs = quads.flatMap((quad) => [quad[0], quad[2], quad[4], quad[6]])
  const ys = quads.flatMap((quad) => [quad[1], quad[3], quad[5], quad[7]])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rect = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
  return {
    index,
    pageNumber,
    id: `mupdf-${pageNumber}-${index}`,
    source: 'mupdf',
    snippet: text,
    confidence: 0.96,
    rect,
    rects: [rect],
  }
}

function rectFromQuads(quads: Quad[]): [number, number, number, number] {
  const xs = quads.flatMap((quad) => [quad[0], quad[2], quad[4], quad[6]])
  const ys = quads.flatMap((quad) => [quad[1], quad[3], quad[5], quad[7]])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function tupleToTextRect(rect: number[]): TextOccurrenceRect {
  return normalizeRect({
    x: rect[0] ?? 0,
    y: rect[1] ?? 0,
    width: (rect[2] ?? 0) - (rect[0] ?? 0),
    height: (rect[3] ?? 0) - (rect[1] ?? 0),
  })
}

function expandRect(rect: TextOccurrenceRect, padding: number, bounds?: number[]): TextOccurrenceRect {
  const normalized = normalizeRect(rect)
  const minX = bounds?.[0] ?? 0
  const minY = bounds?.[1] ?? 0
  const maxX = bounds?.[2] ?? Number.POSITIVE_INFINITY
  const maxY = bounds?.[3] ?? Number.POSITIVE_INFINITY
  const left = Math.max(minX, normalized.x - padding)
  const top = Math.max(minY, normalized.y - padding)
  const right = Math.min(maxX, normalized.x + normalized.width + padding)
  const bottom = Math.min(maxY, normalized.y + normalized.height + padding)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function textRectToTuple(rect: TextOccurrenceRect): [number, number, number, number] {
  const normalized = normalizeRect(rect)
  return [
    normalized.x,
    normalized.y,
    normalized.x + normalized.width,
    normalized.y + normalized.height,
  ]
}

function rectsIntersect(first: TextOccurrenceRect, second: TextOccurrenceRect): boolean {
  const a = normalizeRect(first)
  const b = normalizeRect(second)
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
}

function closestHitIndex(hits: Quad[][], occurrence?: TextOccurrence): number {
  if (!occurrence) return 0
  const target = occurrence.rect
  const targetCenterX = target.x + target.width / 2
  const targetCenterY = target.y + target.height / 2
  let closestIndex = Math.min(occurrence.index, hits.length - 1)
  let closestDistance = Number.POSITIVE_INFINITY

  hits.forEach((hit, index) => {
    const [x1, y1, x2, y2] = rectFromQuads(hit)
    const centerX = (x1 + x2) / 2
    const centerY = (y1 + y2) / 2
    const distance = Math.hypot(centerX - targetCenterX, centerY - targetCenterY)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })

  return closestIndex
}

function toMuPdfQuad(quad: Quad): MuPdfQuad {
  return [
    quad[0],
    quad[1],
    quad[2],
    quad[3],
    quad[4],
    quad[5],
    quad[6],
    quad[7],
  ]
}

function saveMuPdfDocument(pdfDoc: InstanceType<MuPdfModule['PDFDocument']>): ArrayBuffer {
  const saved = pdfDoc.saveToBuffer('garbage=4,compress=yes')
  try {
    const savedBytes = new Uint8Array(saved.asUint8Array())
    return savedBytes.buffer.slice(savedBytes.byteOffset, savedBytes.byteOffset + savedBytes.byteLength)
  } finally {
    saved.destroy()
  }
}

function destroyMuPdfValue(value: { destroy: () => void } | null | undefined): void {
  try {
    value?.destroy()
  } catch {
    // MuPDF may already have invalidated borrowed objects after a page update.
  }
}

function releaseMuPdf(module: MuPdfModule | undefined, ...values: Array<{ destroy: () => void } | null | undefined>): void {
  for (const value of values) destroyMuPdfValue(value)
  try {
    module?.emptyStore()
    module?.shrinkStore(1)
  } catch {
    // Store cleanup is best-effort; the operation result has already been decided.
  }
}

function describeMuPdfError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/out of memory|cannot allocate wasm memory|webassembly\.instantiate/i.test(message)) {
    return '브라우저가 PDF 삭제 엔진용 메모리를 확보하지 못했습니다. 다른 큰 탭을 닫고 새로고침한 뒤 다시 시도하세요.'
  }
  return error instanceof Error ? error.message : fallback
}

export function normalizeRect(rect: TextOccurrenceRect): TextOccurrenceRect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

function unionRects(rects: TextOccurrenceRect[]): TextOccurrenceRect {
  const normalized = rects.map(normalizeRect)
  const minX = Math.min(...normalized.map((rect) => rect.x))
  const minY = Math.min(...normalized.map((rect) => rect.y))
  const maxX = Math.max(...normalized.map((rect) => rect.x + rect.width))
  const maxY = Math.max(...normalized.map((rect) => rect.y + rect.height))
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function rectIntersectionArea(a: TextOccurrenceRect, b: TextOccurrenceRect): number {
  const first = normalizeRect(a)
  const second = normalizeRect(b)
  const left = Math.max(first.x, second.x)
  const top = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function rectContainsCenter(container: TextOccurrenceRect, target: TextOccurrenceRect): boolean {
  const normalized = normalizeRect(container)
  const centerX = target.x + target.width / 2
  const centerY = target.y + target.height / 2
  return centerX >= normalized.x &&
    centerX <= normalized.x + normalized.width &&
    centerY >= normalized.y &&
    centerY <= normalized.y + normalized.height
}

function snippetFor(value: string, matchStart: number, matchLength: number): string {
  const before = value.slice(Math.max(0, matchStart - 16), matchStart)
  const match = value.slice(matchStart, matchStart + matchLength)
  const after = value.slice(matchStart + matchLength, matchStart + matchLength + 16)
  return `${before}${match}${after}`.trim()
}

function multiplyTransforms(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

interface PdfTextRectItem {
  rect: TextOccurrenceRect
  text: string
}

function rectForPdfTextItem(item: PdfTextItem, viewportTransform: number[]): TextOccurrenceRect {
  const transformed = multiplyTransforms(viewportTransform, item.transform)
  const itemWidth = Math.max(1, item.width)
  const itemHeight = Math.max(8, Math.abs(transformed[3]) || item.height || 8)
  return normalizeRect({
    x: transformed[4],
    y: transformed[5] - itemHeight,
    width: itemWidth,
    height: itemHeight,
  })
}

async function listPdfJsOccurrences(
  pdfData: ArrayBuffer,
  pageNumber: number,
  text: string,
  startIndex: number,
): Promise<TextOccurrence[]> {
  const doc = await loadPdf(pdfData)
  try {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent()
    const occurrences: TextOccurrence[] = []

    for (const item of textContent.items) {
      if (!('str' in item) || typeof item.str !== 'string') continue
      const textItem = item as PdfTextItem
      if (!textItem.str.includes(text)) continue

      let offset = 0
      while (offset < textItem.str.length) {
        const matchStart = textItem.str.indexOf(text, offset)
        if (matchStart === -1) break

        const itemWidth = Math.max(1, textItem.width)
        const itemRect = rectForPdfTextItem(textItem, viewport.transform)
        const charWidth = itemWidth / Math.max(1, textItem.str.length)
        const rect = normalizeRect({
          x: itemRect.x + charWidth * matchStart,
          y: itemRect.y,
          width: charWidth * text.length,
          height: itemRect.height,
        })
        const index = startIndex + occurrences.length
        occurrences.push({
          index,
          pageNumber,
          id: `pdfjs-${pageNumber}-${index}`,
          source: 'pdfjs',
          snippet: snippetFor(textItem.str, matchStart, text.length),
          confidence: 0.74,
          rect,
          rects: [rect],
        })
        offset = matchStart + text.length
      }
    }

    return occurrences
  } finally {
    doc.destroy()
  }
}

export async function listTextOccurrencesInRect(
  pdfData: ArrayBuffer,
  pageNumber: number,
  rect: TextOccurrenceRect,
): Promise<TextOccurrence[]> {
  const selectionRect = normalizeRect(rect)
  const doc = await loadPdf(pdfData)
  try {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent()
    const selectedItems: PdfTextRectItem[] = []

    for (const item of textContent.items) {
      if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) continue
      const textItem = item as PdfTextItem
      const itemRect = rectForPdfTextItem(textItem, viewport.transform)
      const itemArea = Math.max(1, itemRect.width * itemRect.height)
      const overlap = rectIntersectionArea(selectionRect, itemRect)
      if (overlap / itemArea < 0.18 && !rectContainsCenter(selectionRect, itemRect)) continue
      selectedItems.push({ rect: itemRect, text: textItem.str.trim() })
    }

    if (selectedItems.length === 0) return []

    const sortedItems = selectedItems.toSorted((a, b) => {
      const lineDelta = a.rect.y - b.rect.y
      if (Math.abs(lineDelta) > Math.max(a.rect.height, b.rect.height) * 0.55) return lineDelta
      return a.rect.x - b.rect.x
    })
    const lines: PdfTextRectItem[][] = []
    for (const item of sortedItems) {
      const lastLine = lines.at(-1)
      const lastRect = lastLine?.[0].rect
      if (!lastLine || !lastRect || Math.abs(item.rect.y - lastRect.y) > Math.max(item.rect.height, lastRect.height) * 0.55) {
        lines.push([item])
      } else {
        lastLine.push(item)
      }
    }
    const text = lines
      .map((line) => line.toSorted((a, b) => a.rect.x - b.rect.x).map((item) => item.text).join(' '))
      .join('\n')
      .trim()
    const rects = selectedItems.map((item) => item.rect)
    const union = unionRects(rects)

    return [{
      index: 0,
      pageNumber,
      id: `selection-${pageNumber}-${Math.round(selectionRect.x)}-${Math.round(selectionRect.y)}-${Math.round(selectionRect.width)}-${Math.round(selectionRect.height)}`,
      source: 'pdfjs',
      snippet: text,
      confidence: 0.82,
      rect: union,
      rects,
    }]
  } finally {
    doc.destroy()
  }
}

function hasNonWinAnsiText(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) > 0xff)
}

function colorToRgb(color: string | undefined, fallback: [number, number, number]) {
  const match = color?.match(/^#?([0-9a-fA-F]{6})$/)
  if (!match) return rgb(fallback[0], fallback[1], fallback[2])
  const value = match[1]
  return rgb(
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  )
}

async function loadOverlayFont(pdfDoc: PDFDocument, replacementText: string) {
  const useEmbeddedFont = hasNonWinAnsiText(replacementText)
  if (!useEmbeddedFont) return pdfDoc.embedFont(StandardFonts.Helvetica)

  pdfDoc.registerFontkit(fontkit)
  const response = await fetch(notoSansKrUrl)
  if (!response.ok) throw new Error('한글 폰트를 불러오지 못했습니다. 잠시 후 다시 시도하세요.')
  return pdfDoc.embedFont(await response.arrayBuffer(), { subset: true })
}

export function createManualOccurrence(
  pageNumber: number,
  rect: TextOccurrenceRect,
): TextOccurrence {
  const normalized = normalizeRect(rect)
  return {
    index: 0,
    pageNumber,
    id: `manual-${pageNumber}`,
    source: 'manual',
    snippet: '수동 지정 영역',
    confidence: 1,
    rect: normalized,
    rects: [normalized],
  }
}

async function overlayRectReplacement(
  pdfData: ArrayBuffer,
  pageNumber: number,
  rect: TextOccurrenceRect,
  replacementText: string,
  style?: OverlayTextStyle,
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.load(pdfData.slice(0))
  const pages = pdfDoc.getPages()
  const page = pages[pageNumber - 1]
  if (!page) throw new Error('덮어쓸 페이지를 찾지 못했습니다.')

  const font = await loadOverlayFont(pdfDoc, replacementText)
  const pageHeight = page.getHeight()
  const normalized = normalizeRect(rect)
  const paddingX = 1.5
  const paddingY = 1.2
  const boxHeight = Math.max(8, normalized.height + paddingY * 2)
  const fontSize = Math.max(5, Math.min(96, style?.fontSize ?? normalized.height * 0.78))
  const textWidth = font.widthOfTextAtSize(replacementText, fontSize)
  const pdfX = Math.max(0, normalized.x - paddingX)
  const pdfY = pageHeight - (normalized.y + normalized.height) - paddingY

  page.drawRectangle({
    x: pdfX,
    y: pdfY,
    width: Math.max(normalized.width, textWidth) + paddingX * 2,
    height: boxHeight,
    color: colorToRgb(style?.backgroundColor, [1, 1, 1]),
    opacity: 1,
  })
  page.drawText(replacementText, {
    x: normalized.x,
    y: pdfY + Math.max(1, (boxHeight - fontSize) * 0.42),
    size: fontSize,
    font,
    color: colorToRgb(style?.textColor, [0, 0, 0]),
  })

  const saved = await pdfDoc.save()
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer
}

function deleteIntersectingPageExtras(page: MuPdfPDFPage, rects: TextOccurrenceRect[], options: RedactionOptions): void {
  if (options.deleteAnnotations) {
    const extras = [...page.getAnnotations(), ...page.getWidgets()]
    for (const extra of extras) {
      if (rects.some((rect) => rectsIntersect(rect, tupleToTextRect(extra.getBounds())))) {
        page.deleteAnnotation(extra)
      }
    }
  }

  if (options.deleteLinks) {
    for (const link of page.getLinks()) {
      if (rects.some((rect) => rectsIntersect(rect, tupleToTextRect(link.getBounds())))) {
        page.deleteLink(link)
      }
    }
  }
}

function applyRectRedactions(page: MuPdfPDFPage, rects: TextOccurrenceRect[], options: RedactionOptions = {}): void {
  const pageBounds = page.getBounds()
  const redactionRects = rects.map((rect) => expandRect(rect, options.padding ?? 0, pageBounds))
  deleteIntersectingPageExtras(page, redactionRects, options)

  for (const rect of redactionRects) {
    const redaction = page.createAnnotation('Redact')
    redaction.setRect(textRectToTuple(rect))
    redaction.update()
  }
  page.applyRedactions(
    false,
    options.imageMethod ?? 0,
    options.lineArtMethod ?? 0,
    options.textMethod ?? 0,
  )
}

export async function listTextOccurrences(
  pdfData: ArrayBuffer,
  pageNumber: number,
  text: string,
): Promise<TextOccurrence[]> {
  if (!text.trim()) return []
  let mupdfOccurrences: TextOccurrence[] = []
  let mupdf: MuPdfModule | undefined
  let doc: MuPdfDocument | undefined
  let page: MuPdfPage | MuPdfPDFPage | undefined
  try {
    mupdf = await import('mupdf')
    doc = mupdf.Document.openDocument(pdfData.slice(0), 'application/pdf')
    if (!doc.needsPassword()) {
      page = doc.loadPage(pageNumber - 1)
      mupdfOccurrences = page
        .search(text, 100)
        .map((quads, index) => occurrenceFromQuads(quads, index, pageNumber, text))
    }
  } catch {
    mupdfOccurrences = []
  } finally {
    releaseMuPdf(mupdf, page, doc)
  }

  if (mupdfOccurrences.length > 0) return mupdfOccurrences
  return listPdfJsOccurrences(pdfData, pageNumber, text, 0)
}

function operationResult(
  pdfData: ArrayBuffer,
  operation: Omit<EditOperation, 'id'>,
): { data: ArrayBuffer; operation: EditOperation } {
  return {
    data: pdfData,
    operation: {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...operation,
    },
  }
}

function operationMethodFor(occurrence: TextOccurrence | undefined): EditMethod | undefined {
  if (!occurrence) return undefined
  return occurrence.source === 'manual' ? 'overlay-manual' : 'overlay-auto'
}

export async function attemptExperimentalTextEdit(
  pdfData: ArrayBuffer,
  pageNumber: number,
  originalText: string,
  replacementText: string,
  occurrenceIndex?: number,
  occurrence?: TextOccurrence,
  style?: OverlayTextStyle,
): Promise<{ data: ArrayBuffer; operation: EditOperation }> {
  const baseOperation = {
    pageNumber,
    originalText,
    replacementText,
    occurrenceIndex,
    occurrenceId: occurrence?.id,
    appliedRect: occurrence?.rect,
  }

  if (!replacementText.trim()) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'unsupported',
      method: operationMethodFor(occurrence),
      reason: '바꿀 문구를 입력해야 합니다.',
    })
  }

  if (occurrence?.source === 'manual' || occurrence?.source === 'pdfjs') {
    try {
      const overlaid = await overlayRectReplacement(pdfData, pageNumber, occurrence.rect, replacementText, style)
      return operationResult(overlaid, {
        ...baseOperation,
        status: 'applied',
        method: occurrence.source === 'manual' ? 'overlay-manual' : 'overlay-auto',
        verified: true,
        reason: occurrence.source === 'manual'
          ? '수동 지정 영역을 덮어쓰기 방식으로 수정했습니다.'
          : 'PDF.js로 찾은 위치를 덮어쓰기 방식으로 수정했습니다.',
      })
    } catch (error) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'failed',
        method: operationMethodFor(occurrence),
        verified: false,
        reason: error instanceof Error ? error.message : '덮어쓰기 수정 중 오류가 발생했습니다.',
      })
    }
  }

  if (!originalText.trim()) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'unsupported',
      reason: '원문을 입력하거나 수동 영역을 지정해야 합니다.',
    })
  }

  let mupdf: MuPdfModule | undefined
  let doc: MuPdfDocument | undefined
  let page: MuPdfPDFPage | undefined
  try {
    mupdf = await import('mupdf')
    doc = mupdf.Document.openDocument(pdfData.slice(0), 'application/pdf')
    const pdfDoc = doc.asPDF()
    if (!pdfDoc) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: operationMethodFor(occurrence),
        reason: 'PDF 문서가 아니어서 직접 수정할 수 없습니다.',
      })
    }
    if (doc.needsPassword()) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: operationMethodFor(occurrence),
        reason: '암호화 PDF는 브라우저 내부 직접 수정 대상에서 제외됩니다.',
      })
    }

    page = pdfDoc.loadPage(pageNumber - 1) as MuPdfPDFPage
    const hits = page.search(originalText, 100)
    if (hits.length === 0) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: operationMethodFor(occurrence),
        reason: '선택한 페이지에서 원문을 찾지 못했습니다.',
      })
    }
    if (hits.length > 1 && occurrenceIndex === undefined) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: operationMethodFor(occurrence),
        reason: `같은 문구가 ${hits.length}개 있습니다. 수정할 후보를 먼저 선택하세요.`,
      })
    }
    const selectedIndex = occurrenceIndex ?? 0
    const selectedHit = hits[selectedIndex]
    if (!selectedHit) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: operationMethodFor(occurrence),
        reason: '선택한 수정 후보를 찾지 못했습니다.',
      })
    }

    const pageObject = page.getObject()
    const streams = getContentStreams(pageObject)

    if (hits.length === 1 && streams.length > 0) {
      const fontMaps = getFontEncodingMaps(pageObject)
      for (const stream of streams) {
        const content = stream.readStream().asString()
        const result = replaceInContentStream(content, originalText, replacementText, fontMaps)
        if (!result.changed) continue

        stream.writeStream(result.content)
        return {
          data: saveMuPdfDocument(pdfDoc),
          operation: {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            ...baseOperation,
            status: 'applied',
            method: 'direct',
            verified: true,
            reason: `${result.method}을 content stream에서 교체했습니다.`,
          },
        }
      }
    }

    const selectedOccurrence = occurrenceFromQuads(selectedHit, selectedIndex, pageNumber, originalText)
    const overlaid = await overlayRectReplacement(pdfData, pageNumber, selectedOccurrence.rect, replacementText, style)
    return {
      data: overlaid,
      operation: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...baseOperation,
        appliedRect: selectedOccurrence.rect,
        occurrenceId: selectedOccurrence.id,
        status: 'applied',
        method: 'overlay-auto',
        verified: true,
        reason: hits.length > 1
          ? `${selectedIndex + 1}번째 후보를 덮어쓰기 방식으로 수정했습니다.`
          : '직접 수정이 어려워 덮어쓰기 방식으로 수정했습니다.',
      },
    }
  } catch (error) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'failed',
      method: operationMethodFor(occurrence),
      verified: false,
      reason: describeMuPdfError(error, 'MuPDF 직접 수정 중 오류가 발생했습니다.'),
    })
  } finally {
    releaseMuPdf(mupdf, page, doc)
  }
}

export async function attemptSelectedRectDelete(
  pdfData: ArrayBuffer,
  pageNumber: number,
  occurrence: TextOccurrence,
  options?: {
    originalText?: string
    redactionOptions?: RedactionOptions
    successReason?: string
  },
): Promise<{ data: ArrayBuffer; operation: EditOperation }> {
  const originalText = options?.originalText ?? (occurrence.source === 'manual' ? '선택 영역' : occurrence.snippet)
  const baseOperation = {
    pageNumber,
    originalText,
    replacementText: '',
    occurrenceIndex: occurrence.index,
    occurrenceId: occurrence.id,
    appliedRect: occurrence.rect,
  }

  let mupdf: MuPdfModule | undefined
  let doc: MuPdfDocument | undefined
  let page: MuPdfPDFPage | undefined
  try {
    mupdf = await import('mupdf')
    doc = mupdf.Document.openDocument(pdfData.slice(0), 'application/pdf')
    const pdfDoc = doc.asPDF()
    if (!pdfDoc || doc.needsPassword()) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'redaction-delete',
        verified: false,
        reason: doc.needsPassword()
          ? '암호화 PDF는 선택 영역 삭제 대상에서 제외됩니다.'
          : 'PDF 문서가 아니어서 선택 영역을 삭제할 수 없습니다.',
      })
    }

    page = pdfDoc.loadPage(pageNumber - 1) as MuPdfPDFPage
    const rects = occurrence.rects.length > 0 ? occurrence.rects : [occurrence.rect]
    applyRectRedactions(page, rects, options?.redactionOptions)
    return {
      data: saveMuPdfDocument(pdfDoc),
      operation: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...baseOperation,
        status: 'applied',
        method: 'redaction-delete',
        verified: true,
        reason: options?.successReason ?? (occurrence.source === 'manual'
          ? '드래그로 선택한 영역을 PDF 내부 redaction으로 실제 삭제했습니다.'
          : '드래그로 선택한 텍스트를 PDF 내부 redaction으로 실제 삭제했습니다.'),
      },
    }
  } catch (error) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'failed',
      method: 'redaction-delete',
      verified: false,
      reason: describeMuPdfError(error, '선택 영역 삭제 중 오류가 발생했습니다.'),
    })
  } finally {
    releaseMuPdf(mupdf, page, doc)
  }
}

export async function attemptDirectTextDelete(
  pdfData: ArrayBuffer,
  pageNumber: number,
  originalText: string,
  occurrence?: TextOccurrence,
): Promise<{ data: ArrayBuffer; operation: EditOperation }> {
  const baseOperation = {
    pageNumber,
    originalText,
    replacementText: '',
    occurrenceIndex: occurrence?.index,
    occurrenceId: occurrence?.id,
    appliedRect: occurrence?.rect,
  }

  if (!originalText.trim()) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'unsupported',
      method: 'direct-delete',
      verified: false,
      reason: '삭제할 원문을 입력해야 합니다.',
    })
  }

  if (occurrence?.source === 'manual') {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'unsupported',
      method: 'direct-delete',
      verified: false,
      reason: '수동 영역은 실제 텍스트 객체를 특정할 수 없어 삭제할 수 없습니다. 검색된 텍스트 후보를 선택하세요.',
    })
  }

  let mupdf: MuPdfModule | undefined
  let doc: MuPdfDocument | undefined
  let page: MuPdfPDFPage | undefined
  try {
    mupdf = await import('mupdf')
    doc = mupdf.Document.openDocument(pdfData.slice(0), 'application/pdf')
    const pdfDoc = doc.asPDF()
    if (!pdfDoc || doc.needsPassword()) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'direct-delete',
        verified: false,
        reason: doc.needsPassword()
          ? '암호화 PDF는 실제 텍스트 삭제 대상에서 제외됩니다.'
          : 'PDF 문서가 아니어서 실제 텍스트를 삭제할 수 없습니다.',
      })
    }

    page = pdfDoc.loadPage(pageNumber - 1) as MuPdfPDFPage
    const hits = page.search(originalText, 100)
    if (hits.length === 0) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'direct-delete',
        verified: false,
        reason: '선택한 페이지에서 삭제할 원문을 찾지 못했습니다.',
      })
    }
    if (hits.length > 1 && occurrence === undefined) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'direct-delete',
        verified: false,
        reason: `같은 문구가 ${hits.length}개 있습니다. 삭제할 후보를 먼저 선택하세요.`,
      })
    }

    const selectedIndex = closestHitIndex(hits, occurrence)
    if (!hits[selectedIndex]) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'direct-delete',
        verified: false,
        reason: '선택한 삭제 후보를 찾지 못했습니다.',
      })
    }

    const pageObject = page.getObject()
    const streams = getContentStreams(pageObject)
    const fontMaps = getFontEncodingMaps(pageObject)
    let remainingIndex = selectedIndex
    for (const stream of streams) {
      const content = stream.readStream().asString()
      const streamCount = countStreamTextOccurrences(content, originalText, fontMaps)
      if (streamCount === 0) continue
      if (remainingIndex >= streamCount) {
        remainingIndex -= streamCount
        continue
      }

      const result = replaceInContentStream(content, originalText, '', fontMaps, remainingIndex)
      if (!result.changed) break

      stream.writeStream(result.content)
      return {
        data: saveMuPdfDocument(pdfDoc),
        operation: {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ...baseOperation,
          occurrenceIndex: selectedIndex,
          appliedRect: occurrence?.rect ?? occurrenceFromQuads(hits[selectedIndex], selectedIndex, pageNumber, originalText).rect,
          status: 'applied',
          method: 'direct-delete',
          verified: true,
          reason: `${selectedIndex + 1}번째 텍스트를 PDF content stream에서 실제 삭제했습니다.`,
        },
      }
    }

    try {
      const hit = hits[selectedIndex]
      const redaction = page.createAnnotation('Redact')
      redaction.setRect(rectFromQuads(hit))
      redaction.setQuadPoints(hit.map(toMuPdfQuad))
      redaction.update()
      page.applyRedactions(false, 0, 0, 0)

      return {
        data: saveMuPdfDocument(pdfDoc),
        operation: {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ...baseOperation,
          occurrenceIndex: selectedIndex,
          appliedRect: occurrence?.rect ?? occurrenceFromQuads(hit, selectedIndex, pageNumber, originalText).rect,
          status: 'applied',
          method: 'redaction-delete',
          verified: true,
          reason: `${selectedIndex + 1}번째 텍스트 영역을 PDF 내부 redaction으로 실제 삭제했습니다.`,
        },
      }
    } catch (redactionError) {
      return operationResult(pdfData, {
        ...baseOperation,
        status: 'unsupported',
        method: 'direct-delete',
        verified: false,
        reason: redactionError instanceof Error
          ? `텍스트 위치는 찾았지만 PDF 내부 삭제 적용에 실패했습니다: ${redactionError.message}`
          : '텍스트 위치는 찾았지만 PDF 내부 삭제 적용에 실패했습니다.',
      })
    }
  } catch (error) {
    return operationResult(pdfData, {
      ...baseOperation,
      status: 'failed',
      method: 'direct-delete',
      verified: false,
      reason: describeMuPdfError(error, '실제 텍스트 삭제 중 오류가 발생했습니다.'),
    })
  } finally {
    releaseMuPdf(mupdf, page, doc)
  }
}
