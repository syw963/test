import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent, RefObject } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileArchive,
  FilePlus2,
  FileText,
  FolderOpen,
  LayoutGrid,
  List,
  Merge,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Search,
  ShieldCheck,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import './App.css'
import { describePages, estimateRecipePageCount, parsePageRange } from './lib/pageRanges'
import {
  downloadBytes,
  deletePdfPages,
  duplicatePdfPages,
  extractPagesFromData,
  loadPdf,
  mergeDocuments,
  readPdfFile,
  reorderPdfPages,
  rotatePdfPages,
} from './lib/pdfCore'
import { exportProjectPackage, importProjectPackage } from './lib/projectPackage'
import { createManualOccurrence, normalizeRect } from './lib/textEdit'
import { listRecentProjects, loadProject, removeProject, saveProject } from './lib/projectStore'
import type {
  EditOperation,
  MergeRecipe,
  OverlayTextStyle,
  PageOperation,
  ProjectBundle,
  ProjectDocumentSession,
  ProjectManifest,
  RecentProject,
  SourceDocument,
  TextOccurrence,
  TextOccurrenceRect,
  ToolMode,
} from './types'

interface PageScrollRequest {
  id: number
  page: number
}

type RailTab = 'pages' | 'recent'
type InspectorTab = 'text' | 'pages' | 'merge'
type ThumbView = 'grid' | 'list'
type PdfReloadTarget = 'all' | number | number[]

interface SearchResult {
  id: string
  pageNumber: number
  snippet: string
}

interface UndoSnapshot {
  id: string
  label: string
  operationId?: string
  activeSourceId: string | null
  mode: ToolMode
  manifest: ProjectManifest | null
  pdfData: ArrayBuffer | null
  sourceDocuments: SourceDocument[]
  editOperations: EditOperation[]
  editSnapshots: Record<string, ArrayBuffer>
  pageOperations: PageOperation[]
  currentPage: number
  extractRange: string
  mergeTitle: string
  mergeAuthor: string
  createdAt: string
}

interface DocumentSessionState extends ProjectDocumentSession {
  undoStack: UndoSnapshot[]
}

interface ZoomAnchor {
  contentX: number
  contentY: number
  offsetX: number
  offsetY: number
  ratio: number
}

interface BrowserTextSelection {
  pageNumber: number
  occurrence: TextOccurrence
}

interface PageRenderMetrics {
  width: number
  height: number
}

const APP_VERSION = '0.1.0'
const AUTO_SAVE_MAX_SNAPSHOT_COUNT = 5
const AUTO_SAVE_MAX_SNAPSHOT_BYTES = 80 * 1024 * 1024
const UNDO_MAX_SNAPSHOT_COUNT = 10
const UNDO_MAX_SNAPSHOT_BYTES = 350 * 1024 * 1024
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const ZOOM_STEP_FACTOR = 1.12
const DEFAULT_RENDER_ZOOM = 1
const PAGE_RENDER_MARGIN = 2
const DEFAULT_PAGE_METRICS: PageRenderMetrics = {
  width: Math.floor(595.28 * 1.35 * DEFAULT_RENDER_ZOOM),
  height: Math.floor(841.89 * 1.35 * DEFAULT_RENDER_ZOOM),
}
const DEFAULT_OVERLAY_STYLE: OverlayTextStyle = {
  backgroundColor: '#ffffff',
  textColor: '#111111',
}

function snippetForSearch(value: string, matchStart: number, matchLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  const start = Math.max(0, matchStart - 28)
  const end = Math.min(compact.length, matchStart + matchLength + 34)
  return `${start > 0 ? '...' : ''}${compact.slice(start, end)}${end < compact.length ? '...' : ''}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function copySourceDocuments(sources: SourceDocument[]): SourceDocument[] {
  return sources.map((source) => ({ ...source, data: source.data.slice(0) }))
}

function copyEditSnapshots(snapshots: Record<string, ArrayBuffer>): Record<string, ArrayBuffer> {
  return Object.fromEntries(
    Object.entries(snapshots).map(([id, data]) => [id, data.slice(0)]),
  )
}

function estimateEditSnapshotBytes(snapshots: Record<string, ArrayBuffer>): number {
  return Object.values(snapshots).reduce((total, snapshot) => total + snapshot.byteLength, 0)
}

function estimateSourceDocumentBytes(sources: SourceDocument[]): number {
  return sources.reduce((total, source) => total + source.data.byteLength, 0)
}

function estimateUndoSnapshotBytes(snapshot: UndoSnapshot): number {
  return (
    (snapshot.pdfData?.byteLength ?? 0) +
    estimateSourceDocumentBytes(snapshot.sourceDocuments) +
    estimateEditSnapshotBytes(snapshot.editSnapshots)
  )
}

function trimUndoSnapshots(snapshots: UndoSnapshot[]): UndoSnapshot[] {
  const trimmed: UndoSnapshot[] = []
  let totalBytes = 0
  for (const snapshot of snapshots) {
    if (trimmed.length >= UNDO_MAX_SNAPSHOT_COUNT) break
    const snapshotBytes = estimateUndoSnapshotBytes(snapshot)
    if (trimmed.length > 0 && totalBytes + snapshotBytes > UNDO_MAX_SNAPSHOT_BYTES) continue
    trimmed.push(snapshot)
    totalBytes += snapshotBytes
  }
  return trimmed
}

function toProjectDocumentSession(session: DocumentSessionState): ProjectDocumentSession {
  return {
    editOperations: session.editOperations.map((operation) => ({ ...operation })),
    editSnapshots: copyEditSnapshots(session.editSnapshots),
    pageOperations: session.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
    currentPage: session.currentPage,
    extractRange: session.extractRange,
  }
}

function toDocumentSessionState(session: ProjectDocumentSession): DocumentSessionState {
  return {
    editOperations: session.editOperations.map((operation) => ({ ...operation })),
    editSnapshots: copyEditSnapshots(session.editSnapshots ?? {}),
    pageOperations: session.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
    currentPage: session.currentPage,
    extractRange: session.extractRange,
    undoStack: [],
  }
}

function trimEditSnapshotsForAutoSave(
  operations: EditOperation[],
  snapshots: Record<string, ArrayBuffer>,
): Record<string, ArrayBuffer> {
  const trimmed: Record<string, ArrayBuffer> = {}
  let totalBytes = 0
  let count = 0
  for (const operation of operations) {
    const snapshot = snapshots[operation.id]
    if (!snapshot) continue
    if (count >= AUTO_SAVE_MAX_SNAPSHOT_COUNT) break
    if (totalBytes + snapshot.byteLength > AUTO_SAVE_MAX_SNAPSHOT_BYTES) continue
    trimmed[operation.id] = snapshot
    totalBytes += snapshot.byteLength
    count += 1
  }
  return trimmed
}

function trimProjectSessionsForAutoSave(
  sessions: Record<string, ProjectDocumentSession>,
): Record<string, ProjectDocumentSession> {
  return Object.fromEntries(
    Object.entries(sessions).map(([sourceId, session]) => [
      sourceId,
      {
        ...session,
        editSnapshots: trimEditSnapshotsForAutoSave(session.editOperations, session.editSnapshots),
      },
    ]),
  )
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}

function elementFromNode(node: Node | null): Element | null {
  if (node instanceof Element) return node
  return node?.parentElement ?? null
}

function unionTextRects(rects: TextOccurrenceRect[]): TextOccurrenceRect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function pageSequence(start: number, end: number): number[] {
  if (end < start) return []
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function shouldRenderPage(pageNumber: number, currentPage: number): boolean {
  return Math.abs(pageNumber - currentPage) <= PAGE_RENDER_MARGIN
}

function normalizeReloadPages(target: PdfReloadTarget, pageCount: number): number[] {
  const pages = Array.isArray(target) ? target : [target]
  return [...new Set(pages)]
    .filter((page): page is number => typeof page === 'number' && Number.isFinite(page))
    .filter((page) => page >= 1 && page <= pageCount)
}

function normalizedWheelDelta(event: globalThis.WheelEvent, fallbackElement: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * fallbackElement.clientHeight
  return event.deltaY
}

function browserTextSelectionToOccurrence(): BrowserTextSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  const selectionElements = [
    elementFromNode(range.commonAncestorContainer),
    elementFromNode(range.startContainer),
    elementFromNode(range.endContainer),
    elementFromNode(selection.anchorNode),
    elementFromNode(selection.focusNode),
  ]
  const textLayers = selectionElements
    .map((element) => element?.closest<HTMLElement>('.textLayer') ?? null)
    .filter((element): element is HTMLElement => Boolean(element))
  const textLayer = textLayers[0]
  if (!textLayer || textLayers.some((layer) => layer !== textLayer)) return null

  const pageNode = textLayer.closest<HTMLElement>('.canvas-page')
  const pageNumber = Number(pageNode?.dataset.pageNumber)
  if (!Number.isFinite(pageNumber)) return null

  const scale = Number.parseFloat(textLayer.style.getPropertyValue('--display-scale-factor'))
    || Number.parseFloat(textLayer.style.getPropertyValue('--total-scale-factor'))
    || 1
  const bounds = textLayer.getBoundingClientRect()
  const rects = Array.from(range.getClientRects())
    .map((rect) => {
      const left = Math.max(rect.left, bounds.left)
      const top = Math.max(rect.top, bounds.top)
      const right = Math.min(rect.right, bounds.right)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      if (right - left < 1 || bottom - top < 1) return null
      return normalizeRect({
        x: (left - bounds.left) / scale,
        y: (top - bounds.top) / scale,
        width: (right - left) / scale,
        height: (bottom - top) / scale,
      })
    })
    .filter((rect): rect is TextOccurrenceRect => Boolean(rect))

  if (rects.length === 0) return null
  const union = unionTextRects(rects)
  return {
    pageNumber,
    occurrence: {
      index: 0,
      pageNumber,
      id: `browser-selection-${pageNumber}-${Math.round(union.x)}-${Math.round(union.y)}-${Date.now()}`,
      source: 'pdfjs',
      snippet: text,
      confidence: 0.88,
      rect: union,
      rects,
    },
  }
}

function App() {
  const [mode, setMode] = useState<ToolMode>('editor')
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [showHome, setShowHome] = useState(false)
  const [manifest, setManifest] = useState<ProjectManifest | null>(null)
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null)
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [sourceDocuments, setSourceDocuments] = useState<SourceDocument[]>([])
  const [editOperations, setEditOperations] = useState<EditOperation[]>([])
  const [editSnapshots, setEditSnapshots] = useState<Record<string, ArrayBuffer>>({})
  const [pageOperations, setPageOperations] = useState<PageOperation[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [railTab, setRailTab] = useState<RailTab>('pages')
  const [thumbView, setThumbView] = useState<ThumbView>('grid')
  const [pageListFullscreen, setPageListFullscreen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('pages')
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchState, setSearchState] = useState('검색어를 입력하세요.')
  const [status, setStatus] = useState('PDF를 열거나 여러 PDF 병합을 시작하세요.')
  const [editOriginal, setEditOriginal] = useState('')
  const [editReplacement, setEditReplacement] = useState('')
  const [textOccurrences, setTextOccurrences] = useState<TextOccurrence[]>([])
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | undefined>()
  const [manualOverlayEnabled, setManualOverlayEnabled] = useState(false)
  const [textSelectionEnabled, setTextSelectionEnabled] = useState(false)
  const [manualOverlayRect, setManualOverlayRect] = useState<TextOccurrenceRect | null>(null)
  const [overlayStyle, setOverlayStyle] = useState<OverlayTextStyle>(DEFAULT_OVERLAY_STYLE)
  const [extractRange, setExtractRange] = useState('1')
  const [mergeTitle, setMergeTitle] = useState('병합 PDF')
  const [mergeAuthor, setMergeAuthor] = useState('브라우저 PDF 편집기')
  const [mergeAddSeparatorPages, setMergeAddSeparatorPages] = useState(false)
  const [scrollRequest, setScrollRequest] = useState<PageScrollRequest | null>(null)
  const [draggedPage, setDraggedPage] = useState<number | null>(null)
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([])
  const [documentRenderVersion, setDocumentRenderVersion] = useState(0)
  const [pageRenderVersions, setPageRenderVersions] = useState<Record<number, number>>({})
  const [inspectorWidth, setInspectorWidth] = useState(540)
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  const pdfInputRef = useRef<HTMLInputElement>(null)
  const mergeInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pageJumpInputRef = useRef<HTMLInputElement>(null)
  const documentScrollRef = useRef<HTMLDivElement>(null)
  const pdfReloadTargetRef = useRef<PdfReloadTarget>('all')
  const inspectorResizeRef = useRef<{ max: number; right: number } | null>(null)
  const activeSourceIdRef = useRef<string | null>(null)
  const documentTabRefs = useRef(new Map<string, HTMLDivElement>())
  const documentSessionsRef = useRef<Record<string, DocumentSessionState>>({})
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const searchTextCacheRef = useRef(new Map<number, string>())
  const zoomRef = useRef(zoom)
  const currentPageRef = useRef(currentPage)
  const pendingZoomAnchorRef = useRef<ZoomAnchor | null>(null)
  const textDeleteActionRef = useRef<(() => void) | null>(null)
  const elementDeleteActionRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    listRecentProjects().then(setRecentProjects).catch(() => setRecentProjects([]))
  }, [])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    pdfDocRef.current = pdfDoc
  }, [pdfDoc])

  useEffect(() => () => {
    if (pdfDocRef.current) void pdfDocRef.current.destroy()
  }, [])

  useLayoutEffect(() => {
    const stage = documentScrollRef.current
    const anchor = pendingZoomAnchorRef.current
    if (!stage || !anchor) return
    pendingZoomAnchorRef.current = null
    stage.scrollLeft = anchor.contentX * anchor.ratio - anchor.offsetX
    stage.scrollTop = anchor.contentY * anchor.ratio - anchor.offsetY
  }, [zoom])

  useEffect(() => {
    const stage = documentScrollRef.current
    if (!stage) return undefined

    function handleTrackpadZoom(event: globalThis.WheelEvent): void {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()

      if (!stage) return
      const deltaY = normalizedWheelDelta(event, stage)
      if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.01) return

      const currentZoom = zoomRef.current
      const nextZoom = clamp(Number((currentZoom * Math.exp(-deltaY * 0.004)).toFixed(3)), MIN_ZOOM, MAX_ZOOM)
      if (Math.abs(nextZoom - currentZoom) < 0.001) return

      const bounds = stage.getBoundingClientRect()
      const offsetX = clamp(event.clientX - bounds.left, 0, stage.clientWidth)
      const offsetY = clamp(event.clientY - bounds.top, 0, stage.clientHeight)
      pendingZoomAnchorRef.current = {
        contentX: stage.scrollLeft + offsetX,
        contentY: stage.scrollTop + offsetY,
        offsetX,
        offsetY,
        ratio: nextZoom / currentZoom,
      }
      zoomRef.current = nextZoom
      setZoom(nextZoom)
    }

    stage.addEventListener('wheel', handleTrackpadZoom, { passive: false, capture: true })
    return () => stage.removeEventListener('wheel', handleTrackpadZoom, { capture: true })
  }, [pdfData, sourceDocuments.length])

  useLayoutEffect(() => {
    if (!activeSourceId) return
    documentTabRefs.current.get(activeSourceId)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [activeSourceId, sourceDocuments.length])

  useEffect(() => {
    if (!pdfData) return
    const reloadTarget = pdfReloadTargetRef.current
    searchTextCacheRef.current.clear()

    let cancelled = false
    loadPdf(pdfData)
      .then((doc) => {
        if (cancelled) {
          void doc.destroy()
          return
        }
        setPdfDoc((previous) => {
          if (previous && previous !== doc) void previous.destroy()
          return doc
        })
        setCurrentPage((page) => Math.min(Math.max(page, 1), doc.numPages))
        if (reloadTarget === 'all') {
          setPageRenderVersions({})
          setDocumentRenderVersion((version) => version + 1)
        } else {
          const reloadPages = normalizeReloadPages(reloadTarget, doc.numPages)
          setPageRenderVersions((versions) => ({
            ...Object.fromEntries(
              Object.entries(versions).filter(([page]) => Number(page) <= doc.numPages),
            ),
            ...Object.fromEntries(
              reloadPages.map((page) => [page, (versions[page] ?? 0) + 1]),
            ),
          }))
        }
      })
      .catch((error: unknown) => {
        setPdfDoc((previous) => {
          if (previous) void previous.destroy()
          return null
        })
        setStatus(error instanceof Error ? error.message : 'PDF를 열 수 없습니다.')
      })

    return () => {
      cancelled = true
    }
  }, [pdfData])

  useEffect(() => {
    if (!pdfDoc || !searchText.trim()) {
      const timer = window.setTimeout(() => {
        setSearchResults([])
        setSearchState(searchText.trim() ? '검색할 PDF가 없습니다.' : '검색어를 입력하세요.')
      }, 0)
      return () => window.clearTimeout(timer)
    }

    let cancelled = false
    const query = searchText.trim().toLocaleLowerCase('ko-KR')
    const timer = window.setTimeout(() => {
      setSearchState('검색 중')
      void (async () => {
        const results: SearchResult[] = []
        let failedPages = 0
        for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
          let pageText = searchTextCacheRef.current.get(pageNumber)
          if (pageText === undefined) {
            try {
              const page = await pdfDoc.getPage(pageNumber)
              const textContent = await page.getTextContent()
              pageText = textContent.items
                .filter((item) => 'str' in item && typeof item.str === 'string')
                .map((item) => (item as { str: string }).str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
              searchTextCacheRef.current.set(pageNumber, pageText)
            } catch {
              failedPages += 1
              continue
            }
          }
          const lowerText = pageText.toLocaleLowerCase('ko-KR')
          const matchStart = lowerText.indexOf(query)
          if (matchStart === -1) continue
          results.push({
            id: `search-${pageNumber}-${matchStart}`,
            pageNumber,
            snippet: snippetForSearch(pageText, matchStart, searchText.trim().length),
          })
          if (results.length >= 80) break
        }
        if (cancelled) return
        setSearchResults(results)
        setSearchState(results.length > 0
          ? failedPages > 0 ? `${results.length}개 결과 · ${failedPages}쪽 제외` : `${results.length}개 결과`
          : failedPages > 0 ? `검색 결과 없음 · ${failedPages}쪽 제외` : '검색 결과가 없습니다.')
      })().catch(() => {
        if (!cancelled) {
          setSearchResults([])
          setSearchState('검색 중 오류가 발생했습니다.')
        }
      })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pdfDoc, searchText])

  const selectedPageSummary = useMemo(() => {
    if (!pdfDoc) return '페이지 없음'
    return `${currentPage} / ${pdfDoc.numPages}`
  }, [currentPage, pdfDoc])

  const mergePageCount = useMemo(
    () => estimateRecipePageCount(sourceDocuments),
    [sourceDocuments],
  )

  const activeSource = useMemo(
    () => sourceDocuments.find((source) => source.id === activeSourceId) ?? null,
    [activeSourceId, sourceDocuments],
  )

  const manualOccurrence = useMemo(
    () => manualOverlayRect ? createManualOccurrence(currentPage, manualOverlayRect) : null,
    [currentPage, manualOverlayRect],
  )

  const visibleOccurrences = useMemo(
    () => manualOccurrence ? [...textOccurrences, manualOccurrence] : textOccurrences,
    [manualOccurrence, textOccurrences],
  )

  const selectedOccurrence = useMemo(
    () => visibleOccurrences.find((occurrence) => occurrence.id === selectedOccurrenceId),
    [selectedOccurrenceId, visibleOccurrences],
  )

  const resetTransientSelection = useCallback(() => {
    setTextOccurrences([])
    setSelectedOccurrenceId(undefined)
    setManualOverlayEnabled(false)
    setTextSelectionEnabled(false)
    setManualOverlayRect(null)
    setOverlayStyle(DEFAULT_OVERLAY_STYLE)
  }, [])

  const activatePage = useCallback((page: number, scrollIntoView: boolean) => {
    setCurrentPage((current) => {
      if (current !== page) resetTransientSelection()
      return page
    })
    if (scrollIntoView) {
      setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page }))
    }
  }, [resetTransientSelection])

  const handleOverlayStyleSample = useCallback((style: OverlayTextStyle) => {
    setOverlayStyle((current) => ({
      backgroundColor: style.backgroundColor || current.backgroundColor,
      fontSize: style.fontSize ?? current.fontSize,
      textColor: style.textColor || current.textColor,
    }))
  }, [])

  function setActiveSource(sourceId: string | null): void {
    activeSourceIdRef.current = sourceId
    setActiveSourceId(sourceId)
  }

  function currentDocumentSessionKey(): string {
    return activeSourceIdRef.current ?? '__current-document__'
  }

  function syncCurrentPdfDataIntoSources(sources: SourceDocument[]): SourceDocument[] {
    const sourceId = activeSourceIdRef.current
    if (!sourceId || !pdfData) return sources
    const pageCount = pdfDoc?.numPages
    let didSync = false
    const nextSources = sources.map((source) => {
      if (source.id !== sourceId) return source
      didSync = true
      return {
        ...source,
        data: pdfData.slice(0),
        pageCount: pageCount ?? source.pageCount,
        rangeText: source.rangeText || `1-${pageCount ?? source.pageCount}`,
      }
    })
    return didSync ? nextSources : sources
  }

  function captureDocumentSession(): DocumentSessionState {
    return {
      editOperations: editOperations.map((operation) => ({ ...operation })),
      editSnapshots: copyEditSnapshots(editSnapshots),
      pageOperations: pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
      undoStack: trimUndoSnapshots(undoStack.map((snapshot) => ({
        ...snapshot,
        manifest: snapshot.manifest ? { ...snapshot.manifest } : null,
        pdfData: snapshot.pdfData ? snapshot.pdfData.slice(0) : null,
        sourceDocuments: copySourceDocuments(snapshot.sourceDocuments),
        editOperations: snapshot.editOperations.map((operation) => ({ ...operation })),
        editSnapshots: copyEditSnapshots(snapshot.editSnapshots),
        pageOperations: snapshot.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
      }))),
      currentPage,
      extractRange,
    }
  }

  function captureProjectDocumentSessions(): Record<string, ProjectDocumentSession> {
    const currentSession: ProjectDocumentSession = {
      editOperations: editOperations.map((operation) => ({ ...operation })),
      editSnapshots: copyEditSnapshots(editSnapshots),
      pageOperations: pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
      currentPage,
      extractRange,
    }
    return {
      ...Object.fromEntries(
        Object.entries(documentSessionsRef.current).map(([sourceId, session]) => [
          sourceId,
          toProjectDocumentSession(session),
        ]),
      ),
      [currentDocumentSessionKey()]: currentSession,
    }
  }

  function createProjectBundle(updatedManifest: ProjectManifest, autoSave = false): ProjectBundle {
    const sessions = captureProjectDocumentSessions()
    const sessionPayload = autoSave ? trimProjectSessionsForAutoSave(sessions) : sessions
    return {
      manifest: updatedManifest,
      pdfData: pdfData ? pdfData.slice(0) : new ArrayBuffer(0),
      sourceDocuments: syncCurrentPdfDataIntoSources(sourceDocuments),
      activeSourceId: activeSourceIdRef.current,
      documentSessions: sessionPayload,
      editOperations: editOperations.map((operation) => ({ ...operation })),
      editSnapshots: autoSave ? trimEditSnapshotsForAutoSave(editOperations, editSnapshots) : copyEditSnapshots(editSnapshots),
      pageOperations: pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
    }
  }

  useEffect(() => {
    if (!manifest || !pdfData) return
    const updatedManifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      pageCount: pdfDoc?.numPages ?? manifest.pageCount,
    }
    const timer = window.setTimeout(() => {
      const bundle = createProjectBundle(updatedManifest, true)
      saveProject(bundle)
        .then(() => listRecentProjects())
        .then(setRecentProjects)
        .catch(() => setStatus('자동저장에 실패했습니다.'))
    }, 1500)

    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createProjectBundle only reads the state values listed below.
  }, [activeSourceId, currentPage, editOperations, editSnapshots, extractRange, manifest, pageOperations, pdfData, pdfDoc?.numPages, sourceDocuments])

  function stashCurrentDocumentSession(): SourceDocument[] {
    documentSessionsRef.current[currentDocumentSessionKey()] = captureDocumentSession()
    const nextSources = syncCurrentPdfDataIntoSources(sourceDocuments)
    if (nextSources !== sourceDocuments) setSourceDocuments(nextSources)
    return nextSources
  }

  function applyDocumentSession(session: DocumentSessionState | undefined, pageCount: number): void {
    setEditOperations(session?.editOperations.map((operation) => ({ ...operation })) ?? [])
    setEditSnapshots(session ? copyEditSnapshots(session.editSnapshots) : {})
    setPageOperations(session?.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })) ?? [])
    setUndoStack(session ? trimUndoSnapshots(session.undoStack.map((snapshot) => ({
      ...snapshot,
      manifest: snapshot.manifest ? { ...snapshot.manifest } : null,
      pdfData: snapshot.pdfData ? snapshot.pdfData.slice(0) : null,
      sourceDocuments: copySourceDocuments(snapshot.sourceDocuments),
      editOperations: snapshot.editOperations.map((operation) => ({ ...operation })),
      editSnapshots: copyEditSnapshots(snapshot.editSnapshots),
      pageOperations: snapshot.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
    }))) : [])
    setCurrentPage(clamp(session?.currentPage ?? 1, 1, Math.max(1, pageCount)))
    setExtractRange(session?.extractRange ?? `1-${pageCount}`)
  }

  function replacePdfData(
    data: ArrayBuffer,
    reloadTarget: PdfReloadTarget,
    options: { syncActiveSource?: boolean } = {},
  ): void {
    pdfReloadTargetRef.current = reloadTarget
    setPdfData(data)
    if (options.syncActiveSource === false) return
    const sourceId = activeSourceIdRef.current
    if (!sourceId) return
    setSourceDocuments((sources) => sources.map((source) => (
      source.id === sourceId ? { ...source, data: data.slice(0) } : source
    )))
  }

  function startInspectorResize(event: PointerEvent<HTMLDivElement>): void {
    const workspace = event.currentTarget.closest<HTMLElement>('.workspace')
    if (!workspace) return
    const bounds = workspace.getBoundingClientRect()
    inspectorResizeRef.current = {
      right: bounds.right,
      max: Math.max(320, Math.min(820, bounds.width - 560)),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setInspectorWidth(clamp(bounds.right - event.clientX, 320, inspectorResizeRef.current.max))
  }

  function moveInspectorResize(event: PointerEvent<HTMLDivElement>): void {
    const bounds = inspectorResizeRef.current
    if (!bounds) return
    setInspectorWidth(clamp(bounds.right - event.clientX, 320, bounds.max))
  }

  function stopInspectorResize(event: PointerEvent<HTMLDivElement>): void {
    inspectorResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const createUndoSnapshot = useCallback((label: string): UndoSnapshot | null => {
    if (!pdfData && sourceDocuments.length === 0) return null
    return {
      id: crypto.randomUUID(),
      label,
      activeSourceId: activeSourceIdRef.current,
      mode,
      manifest: manifest ? { ...manifest } : null,
      pdfData: pdfData ? pdfData.slice(0) : null,
      sourceDocuments: copySourceDocuments(sourceDocuments),
      editOperations: editOperations.map((operation) => ({ ...operation })),
      editSnapshots: copyEditSnapshots(editSnapshots),
      pageOperations: pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })),
      currentPage,
      extractRange,
      mergeTitle,
      mergeAuthor,
      createdAt: new Date().toISOString(),
    }
  }, [
    currentPage,
    editOperations,
    editSnapshots,
    extractRange,
    manifest,
    mergeAuthor,
    mergeTitle,
    mode,
    pageOperations,
    pdfData,
    sourceDocuments,
  ])

  const pushUndoSnapshot = useCallback((snapshot: UndoSnapshot | null): void => {
    if (!snapshot) return
    setUndoStack((stack) => trimUndoSnapshots([snapshot, ...stack]))
  }, [])

  const restoreUndoSnapshot = useCallback((snapshot: UndoSnapshot): void => {
    setMode(snapshot.mode)
    setManifest(snapshot.manifest ? { ...snapshot.manifest } : null)
    pdfReloadTargetRef.current = 'all'
    setPdfData(snapshot.pdfData ? snapshot.pdfData.slice(0) : null)
    if (!snapshot.pdfData) {
      setPdfDoc((previous) => {
        if (previous) void previous.destroy()
        return null
      })
      setDocumentRenderVersion((version) => version + 1)
    }
    const restoredSources = copySourceDocuments(snapshot.sourceDocuments)
    setSourceDocuments(restoredSources)
    const restoredActiveSourceId = snapshot.activeSourceId && restoredSources.some((source) => source.id === snapshot.activeSourceId)
      ? snapshot.activeSourceId
      : restoredSources[0]?.id ?? null
    setActiveSource(restoredActiveSourceId)
    setEditOperations(snapshot.editOperations.map((operation) => ({ ...operation })))
    setEditSnapshots(copyEditSnapshots(snapshot.editSnapshots))
    setPageOperations(snapshot.pageOperations.map((operation) => ({ ...operation, pages: [...operation.pages] })))
    setCurrentPage(snapshot.currentPage)
    setExtractRange(snapshot.extractRange)
    setMergeTitle(snapshot.mergeTitle)
    setMergeAuthor(snapshot.mergeAuthor)
    resetTransientSelection()
    setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page: snapshot.currentPage }))
    setStatus(`${snapshot.label} 전 상태로 되돌렸습니다.`)
  }, [resetTransientSelection])

  const undoLastAction = useCallback((): void => {
    const snapshot = undoStack[0]
    if (!snapshot) {
      setStatus('되돌릴 작업이 없습니다.')
      return
    }
    setUndoStack((stack) => stack.slice(1))
    restoreUndoSnapshot(snapshot)
  }, [restoreUndoSnapshot, undoStack])

  const deleteBrowserSelectedText = useCallback(async (): Promise<void> => {
    if (!pdfData) return
    const selectedText = browserTextSelectionToOccurrence()
    if (!selectedText) return
    setInspectorTab('text')
    const undoSnapshot = createUndoSnapshot('선택 텍스트 삭제')
    const { attemptSelectedRectDelete } = await import('./lib/textEdit')
    const result = await attemptSelectedRectDelete(pdfData, selectedText.pageNumber, selectedText.occurrence)
    window.getSelection()?.removeAllRanges()

    if (result.operation.status === 'applied') {
      pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
      setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
      setEditOperations((operations) => [result.operation, ...operations])
      replacePdfData(result.data, selectedText.pageNumber)
      setCurrentPage(selectedText.pageNumber)
      setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page: selectedText.pageNumber }))
      resetTransientSelection()
    } else {
      setEditOperations((operations) => [result.operation, ...operations])
    }
    setStatus(result.operation.reason ?? '선택 텍스트 삭제 검사를 완료했습니다.')
  }, [createUndoSnapshot, pdfData, pushUndoSnapshot, resetTransientSelection])

  useEffect(() => {
    function handleUndoShortcut(event: KeyboardEvent): void {
      const key = event.key.toLocaleLowerCase('en-US')
      const isDeleteKey = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (key === 'delete' || key === 'backspace')
      if (isDeleteKey) {
        const hasBrowserTextSelection = Boolean(browserTextSelectionToOccurrence())
        const hasEditorTextSelection = !isEditableShortcutTarget(event.target) && textSelectionEnabled && Boolean(selectedOccurrence)
        const hasEditorElementSelection = !isEditableShortcutTarget(event.target) && manualOverlayEnabled && selectedOccurrence?.source === 'manual'
        if (!hasBrowserTextSelection && !hasEditorTextSelection && !hasEditorElementSelection) return
        event.preventDefault()
        if (hasBrowserTextSelection) void deleteBrowserSelectedText()
        else if (hasEditorElementSelection) elementDeleteActionRef.current?.()
        else textDeleteActionRef.current?.()
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        setRailTab('recent')
        return
      }

      if (isEditableShortcutTarget(event.target)) return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === 'z') {
        event.preventDefault()
        undoLastAction()
      }
    }

    window.addEventListener('keydown', handleUndoShortcut)
    return () => window.removeEventListener('keydown', handleUndoShortcut)
  }, [deleteBrowserSelectedText, manualOverlayEnabled, selectedOccurrence, textSelectionEnabled, undoLastAction])

  useEffect(() => {
    if (!textSelectionEnabled) return undefined

    function syncBrowserTextSelection(): void {
      window.setTimeout(() => {
        const selectedText = browserTextSelectionToOccurrence()
        if (!selectedText) return
        setInspectorTab('text')
        activatePage(selectedText.pageNumber, false)
        setTextOccurrences([selectedText.occurrence])
        setSelectedOccurrenceId(selectedText.occurrence.id)
        setManualOverlayEnabled(false)
        setManualOverlayRect(null)
        setEditOriginal(selectedText.occurrence.snippet)
        setStatus(`드래그로 선택한 텍스트를 인식했습니다: ${selectedText.occurrence.snippet}`)
      }, 0)
    }

    window.addEventListener('pointerup', syncBrowserTextSelection)
    window.addEventListener('keyup', syncBrowserTextSelection)
    return () => {
      window.removeEventListener('pointerup', syncBrowserTextSelection)
      window.removeEventListener('keyup', syncBrowserTextSelection)
    }
  }, [activatePage, textSelectionEnabled])

  async function openPdfFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return
    try {
      const loaded = await Promise.all(Array.from(files).map(readPdfFile))
      const source = loaded[0]
      const undoSnapshot = createUndoSnapshot('PDF 열기')
      const nextManifest: ProjectManifest = {
        id: crypto.randomUUID(),
        name: source.fileName.replace(/\.pdf$/i, ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        originalFileName: source.fileName,
        pageCount: source.pageCount,
        appVersion: APP_VERSION,
      }
      if (pdfData || sourceDocuments.length > 0) stashCurrentDocumentSession()
      else documentSessionsRef.current = {}
      setActiveSource(source.id)
      setManifest(nextManifest)
      replacePdfData(source.data.slice(0), 'all', { syncActiveSource: false })
      setSourceDocuments((documents) => (
        documents.length > 0 || pdfData ? [...documents, ...loaded] : loaded
      ))
      setEditOperations([])
      setEditSnapshots({})
      setTextOccurrences([])
      setSelectedOccurrenceId(undefined)
      setManualOverlayEnabled(false)
      setTextSelectionEnabled(false)
      setManualOverlayRect(null)
      setOverlayStyle(DEFAULT_OVERLAY_STYLE)
      setPageOperations([])
      if (undoSnapshot) pushUndoSnapshot(undoSnapshot)
      else setUndoStack([])
      setCurrentPage(1)
      setShowHome(false)
      setExtractRange(`1-${source.pageCount}`)
      setMode('editor')
      setInspectorTab('pages')
      setStatus(
        loaded.length === 1
          ? `${source.fileName}을 열었습니다. 모든 처리는 브라우저 내부에서만 진행됩니다.`
          : `${loaded.length}개 PDF를 탭으로 열었습니다. 모든 처리는 브라우저 내부에서만 진행됩니다.`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'PDF 열기에 실패했습니다.')
    } finally {
      if (pdfInputRef.current) pdfInputRef.current.value = ''
    }
  }

  async function addMergeFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return
    try {
      const loaded = await Promise.all(Array.from(files).map(readPdfFile))
      setSourceDocuments((sources) => [...sources, ...loaded])
      if (!pdfData && loaded[0]) {
        const source = loaded[0]
        setActiveSource(source.id)
        replacePdfData(source.data.slice(0), 'all', { syncActiveSource: false })
        setManifest({
          id: crypto.randomUUID(),
          name: source.fileName.replace(/\.pdf$/i, ''),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalFileName: source.fileName,
          pageCount: source.pageCount,
          appVersion: APP_VERSION,
        })
        applyDocumentSession(undefined, source.pageCount)
      }
      setShowHome(false)
      setMode('merge')
      setStatus(`${loaded.length}개 PDF를 병합 목록에 추가했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'PDF 추가에 실패했습니다.')
    } finally {
      if (mergeInputRef.current) mergeInputRef.current.value = ''
    }
  }

  function updateSource(id: string, patch: Partial<SourceDocument>): void {
    setSourceDocuments((sources) =>
      sources.map((source) => (source.id === id ? { ...source, ...patch } : source)),
    )
  }

  function moveSource(id: string, direction: -1 | 1): void {
    setSourceDocuments((sources) => {
      const index = sources.findIndex((source) => source.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= sources.length) return sources
      const next = [...sources]
      const [source] = next.splice(index, 1)
      next.splice(target, 0, source)
      return next
    })
  }

  function removeSource(id: string): void {
    const sources = stashCurrentDocumentSession()
    const index = sources.findIndex((source) => source.id === id)
    if (index === -1) return
    const remaining = sources.filter((source) => source.id !== id)
    setSourceDocuments(remaining)

    // 닫는 탭이 현재 활성 탭인 경우 다른 탭으로 전환
    if (id === activeSourceIdRef.current) {
      const next = remaining[index] ?? remaining[index - 1] ?? null
      if (next) {
        setActiveSource(next.id)
        replacePdfData(next.data.slice(0), 'all', { syncActiveSource: false })
        applyDocumentSession(documentSessionsRef.current[next.id], next.pageCount)
        setManifest((current) => ({
          id: current?.id ?? crypto.randomUUID(),
          name: current?.name ?? next.fileName.replace(/\.pdf$/i, ''),
          createdAt: current?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalFileName: next.fileName,
          pageCount: next.pageCount,
          appVersion: APP_VERSION,
        }))
        resetTransientSelection()
        setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page: 1 }))
        setStatus(`${next.fileName} 탭으로 이동했습니다.`)
      } else {
        // 마지막 탭까지 닫은 경우
        setActiveSource(null)
        setPdfData(null)
        setPdfDoc((previous) => {
          if (previous) void previous.destroy()
          return null
        })
        setManifest(null)
        setEditOperations([])
        setEditSnapshots({})
        setPageOperations([])
        setUndoStack([])
        setCurrentPage(1)
        setStatus('PDF를 열거나 여러 PDF 병합을 시작하세요.')
      }
    }
  }

  function updateCurrentPdfData(
    nextData: ArrayBuffer,
    pageCount: number,
    reloadTarget: PdfReloadTarget,
    resetRange: boolean,
  ): void {
    replacePdfData(nextData, reloadTarget, { syncActiveSource: false })
    const sourceId = activeSourceIdRef.current
    if (sourceId) setSourceDocuments((sources) => sources.map((source) => (
      source.id === sourceId
        ? { ...source, data: nextData.slice(0), pageCount, rangeText: `1-${pageCount}` }
        : source
    )))
    if (resetRange) setExtractRange(`1-${pageCount}`)
  }

  function switchSourceDocument(sourceId: string): void {
    const source = sourceDocuments.find((document) => document.id === sourceId)
    if (!source || source.id === activeSourceIdRef.current) return
    stashCurrentDocumentSession()
    setActiveSource(source.id)
    replacePdfData(source.data.slice(0), 'all', { syncActiveSource: false })
    applyDocumentSession(documentSessionsRef.current[source.id], source.pageCount)
    setManifest((current) => ({
      id: current?.id ?? crypto.randomUUID(),
      name: current?.name ?? source.fileName.replace(/\.pdf$/i, ''),
      createdAt: current?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      originalFileName: source.fileName,
      pageCount: source.pageCount,
      appVersion: APP_VERSION,
    }))
    resetTransientSelection()
    setMode('editor')
    if (mode === 'merge') setInspectorTab('pages')
    setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page: 1 }))
    setStatus(`${source.fileName} 탭으로 이동했습니다.`)
  }

  function handleDocumentTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, sourceId: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    switchSourceDocument(sourceId)
  }

  async function runMerge(): Promise<void> {
    if (sourceDocuments.length === 0) {
      setStatus('병합할 PDF를 추가하세요.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      for (const source of sourceDocuments) parsePageRange(source.rangeText, source.pageCount)
      const recipe: MergeRecipe = {
        title: mergeTitle,
        author: mergeAuthor,
        sources: sourceDocuments,
        addSeparatorPages: mergeAddSeparatorPages,
      }
      const merged = await mergeDocuments(recipe)
      const mergedPageCount = mergePageCount + (mergeAddSeparatorPages ? Math.max(0, sourceDocuments.length - 1) : 0)
      const undoSnapshot = createUndoSnapshot('PDF 병합')
      const nextManifest: ProjectManifest = {
        id: crypto.randomUUID(),
        name: mergeTitle,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        originalFileName: `${mergeTitle}.pdf`,
        pageCount: mergedPageCount,
        appVersion: APP_VERSION,
      }
      const operation: PageOperation = {
        id: crypto.randomUUID(),
        type: 'merge',
        sourceId: 'merge-recipe',
        pages: Array.from({ length: mergedPageCount }, (_, index) => index + 1),
        createdAt: new Date().toISOString(),
      }
      stashCurrentDocumentSession()
      setActiveSource(null)
      setManifest(nextManifest)
      replacePdfData(merged, 'all', { syncActiveSource: false })
      setPageOperations((operations) => [operation, ...operations])
      pushUndoSnapshot(undoSnapshot)
      setCurrentPage(1)
      setShowHome(false)
      setMode('editor')
      setInspectorTab('pages')
      setStatus(`병합 완료: ${mergedPageCount}쪽 PDF를 만들었습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '병합에 실패했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function reorderCurrentPages(fromPage: number, toPage: number): Promise<void> {
    if (!pdfData || !pdfDoc || fromPage === toPage) return
    const pageOrder = Array.from({ length: pdfDoc.numPages }, (_, index) => index + 1)
    const fromIndex = pageOrder.indexOf(fromPage)
    const toIndex = pageOrder.indexOf(toPage)
    if (fromIndex === -1 || toIndex === -1) return

    const nextOrder = [...pageOrder]
    const [moved] = nextOrder.splice(fromIndex, 1)
    nextOrder.splice(toIndex, 0, moved)
    const undoSnapshot = createUndoSnapshot('페이지 순서 변경')

    try {
      const reordered = await reorderPdfPages(pdfData, nextOrder)
      const nextCurrentPage = nextOrder.indexOf(currentPage) + 1 || 1
      const operation: PageOperation = {
        id: crypto.randomUUID(),
        type: 'reorder',
        sourceId: 'current-document',
        pages: nextOrder,
        createdAt: new Date().toISOString(),
      }
      const affectedStart = Math.min(fromIndex, toIndex) + 1
      const affectedEnd = Math.max(fromIndex, toIndex) + 1
      updateCurrentPdfData(reordered, nextOrder.length, pageSequence(affectedStart, affectedEnd), false)
      setPageOperations((operations) => [operation, ...operations])
      pushUndoSnapshot(undoSnapshot)
      resetTransientSelection()
      setCurrentPage(nextCurrentPage)
      setScrollRequest((request) => ({ id: (request?.id ?? 0) + 1, page: nextCurrentPage }))
      setStatus(`${fromPage}쪽을 ${toPage}쪽 위치로 이동했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '페이지 순서 변경에 실패했습니다.')
    }
  }

  function handlePageDrop(targetPage: number): void {
    const fromPage = draggedPage
    setDraggedPage(null)
    if (fromPage) void reorderCurrentPages(fromPage, targetPage)
  }

  async function runPageRotate(delta: -90 | 90): Promise<void> {
    if (!pdfData || !pdfDoc) {
      setStatus('페이지 작업을 할 PDF가 없습니다.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const pages = parsePageRange(extractRange, pdfDoc.numPages)
      const undoSnapshot = createUndoSnapshot(delta < 0 ? '왼쪽 회전' : '오른쪽 회전')
      const rotated = await rotatePdfPages(pdfData, pages, delta)
      const operation: PageOperation = {
        id: crypto.randomUUID(),
        type: 'rotate',
        sourceId: 'current-document',
        pages,
        rotation: delta < 0 ? 270 : 90,
        createdAt: new Date().toISOString(),
      }
      updateCurrentPdfData(rotated, pdfDoc.numPages, pages, false)
      setPageOperations((operations) => [operation, ...operations])
      pushUndoSnapshot(undoSnapshot)
      resetTransientSelection()
      setStatus(`${describePages(pages)} 페이지를 ${delta < 0 ? '왼쪽' : '오른쪽'}으로 회전했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '페이지 회전에 실패했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runPageDelete(): Promise<void> {
    if (!pdfData || !pdfDoc) {
      setStatus('페이지 작업을 할 PDF가 없습니다.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const pages = parsePageRange(extractRange, pdfDoc.numPages)
      const undoSnapshot = createUndoSnapshot('페이지 삭제')
      const deleted = await deletePdfPages(pdfData, pages)
      const nextPageCount = pdfDoc.numPages - new Set(pages).size
      const operation: PageOperation = {
        id: crypto.randomUUID(),
        type: 'delete',
        sourceId: 'current-document',
        pages,
        createdAt: new Date().toISOString(),
      }
      updateCurrentPdfData(deleted, nextPageCount, pageSequence(Math.min(...pages), nextPageCount), true)
      setPageOperations((operations) => [operation, ...operations])
      pushUndoSnapshot(undoSnapshot)
      resetTransientSelection()
      setCurrentPage((page) => Math.min(page, nextPageCount))
      setStatus(`${describePages(pages)} 페이지를 삭제했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '페이지 삭제에 실패했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runPageDuplicate(): Promise<void> {
    if (!pdfData || !pdfDoc) {
      setStatus('페이지 작업을 할 PDF가 없습니다.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const pages = parsePageRange(extractRange, pdfDoc.numPages)
      const undoSnapshot = createUndoSnapshot('페이지 복제')
      const duplicated = await duplicatePdfPages(pdfData, pages)
      const nextPageCount = pdfDoc.numPages + new Set(pages).size
      const operation: PageOperation = {
        id: crypto.randomUUID(),
        type: 'duplicate',
        sourceId: 'current-document',
        pages,
        createdAt: new Date().toISOString(),
      }
      updateCurrentPdfData(duplicated, nextPageCount, pageSequence(Math.min(...pages), nextPageCount), true)
      setPageOperations((operations) => [operation, ...operations])
      pushUndoSnapshot(undoSnapshot)
      resetTransientSelection()
      setStatus(`${describePages(pages)} 페이지를 복제했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '페이지 복제에 실패했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runExtract(): Promise<void> {
    const source = sourceDocuments[0]
    if (!pdfData || !pdfDoc) {
      setStatus('추출할 현재 작업 PDF가 없습니다.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const pages = parsePageRange(extractRange, pdfDoc.numPages)
      const data = await extractPagesFromData(pdfData, manifest?.originalFileName ?? 'document.pdf', extractRange)
      downloadBytes(data, `${manifest?.name ?? 'document'}-${describePages(pages)}.pdf`)
      setPageOperations((operations) => [
        {
          id: crypto.randomUUID(),
          type: 'extract',
          sourceId: source?.id ?? 'current-document',
          pages,
          createdAt: new Date().toISOString(),
        },
        ...operations,
      ])
      setStatus(`${describePages(pages)} 페이지를 새 PDF로 추출했습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '범위 추출에 실패했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runTextEdit(): Promise<void> {
    if (!pdfData) {
      setStatus('수정할 PDF를 먼저 여세요.')
      return
    }
    if (!editReplacement.trim()) {
      setStatus('바꿀 문구를 입력하세요.')
      return
    }
    if (!editOriginal.trim() && !selectedOccurrence) {
      setManualOverlayEnabled(true)
      setStatus('원문을 모르면 문서에서 덮어쓸 영역을 드래그로 지정하세요.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const undoSnapshot = createUndoSnapshot('본문 수정')
      const { attemptExperimentalTextEdit, listTextOccurrences } = await import('./lib/textEdit')
      if (selectedOccurrence?.source === 'manual') {
        const result = await attemptExperimentalTextEdit(
          pdfData,
          currentPage,
          editOriginal || '수동 지정 영역',
          editReplacement,
          selectedOccurrence.index,
          selectedOccurrence,
          {
            ...overlayStyle,
            fontSize: overlayStyle.fontSize ?? clamp(selectedOccurrence.rect.height * 0.78, 5, 96),
          },
        )
        if (result.operation.status === 'applied') {
          pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
          setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
          setEditOperations((operations) => [result.operation, ...operations])
          replacePdfData(result.data, currentPage)
          setEditOriginal('')
          setEditReplacement('')
          setTextOccurrences([])
          setSelectedOccurrenceId(undefined)
          setManualOverlayEnabled(false)
          setTextSelectionEnabled(false)
          setManualOverlayRect(null)
          setOverlayStyle(DEFAULT_OVERLAY_STYLE)
        } else {
          setEditOperations((operations) => [result.operation, ...operations])
        }
        setStatus(result.operation.reason ?? '수동 덮어쓰기 검사를 완료했습니다.')
        return
      }

      const occurrences = await listTextOccurrences(pdfData, currentPage, editOriginal)
      setTextOccurrences(occurrences)
      if (occurrences.length === 0) {
        setSelectedOccurrenceId(undefined)
        setManualOverlayEnabled(true)
        setStatus('현재 페이지에서 원문 위치를 찾지 못했습니다. 문서 위에서 덮어쓸 영역을 직접 지정하세요.')
        return
      }
      const nextSelectedOccurrence = selectedOccurrence
        ? occurrences.find((occurrence) => occurrence.id === selectedOccurrence.id)
        : occurrences.length === 1 ? occurrences[0] : undefined
      if (occurrences.length > 1 && !nextSelectedOccurrence) {
        setStatus(`같은 문구가 ${occurrences.length}개 있습니다. 문서의 강조 영역이나 오른쪽 후보 목록에서 수정할 항목을 선택하세요.`)
        return
      }

      const result = await attemptExperimentalTextEdit(
        pdfData,
        currentPage,
        editOriginal,
        editReplacement,
        nextSelectedOccurrence?.index,
        nextSelectedOccurrence,
        nextSelectedOccurrence
          ? {
              ...overlayStyle,
              fontSize: overlayStyle.fontSize ?? clamp(nextSelectedOccurrence.rect.height * 0.78, 5, 96),
            }
          : overlayStyle,
      )
      if (result.operation.status === 'applied') {
        pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
        setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
        setEditOperations((operations) => [result.operation, ...operations])
        replacePdfData(result.data, currentPage)
        setEditOriginal('')
        setEditReplacement('')
        setTextOccurrences([])
        setSelectedOccurrenceId(undefined)
        setManualOverlayEnabled(false)
        setTextSelectionEnabled(false)
        setManualOverlayRect(null)
        setOverlayStyle(DEFAULT_OVERLAY_STYLE)
      } else {
        setEditOperations((operations) => [result.operation, ...operations])
      }
      setStatus(result.operation.reason ?? '본문 수정 검사를 완료했습니다.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '본문 수정 중 오류가 발생했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runTextDelete(): Promise<void> {
    if (!pdfData) {
      setStatus('삭제할 PDF를 먼저 여세요.')
      return
    }
    if (!editOriginal.trim() && !selectedOccurrence) {
      setStatus('삭제할 원문을 입력하거나 문서에서 글자를 드래그로 선택하세요.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const undoSnapshot = createUndoSnapshot('텍스트 삭제')
      const { attemptDirectTextDelete, attemptSelectedRectDelete, listTextOccurrences } = await import('./lib/textEdit')
      if (selectedOccurrence && (selectedOccurrence.source === 'manual' || selectedOccurrence.id.startsWith('selection-') || !editOriginal.trim())) {
        const result = await attemptSelectedRectDelete(pdfData, currentPage, selectedOccurrence)
        if (result.operation.status === 'applied') {
          pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
          setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
          setEditOperations((operations) => [result.operation, ...operations])
          replacePdfData(result.data, currentPage)
          setEditOriginal('')
          setEditReplacement('')
          setTextOccurrences([])
          setSelectedOccurrenceId(undefined)
          setManualOverlayEnabled(false)
          setTextSelectionEnabled(false)
          setManualOverlayRect(null)
          setOverlayStyle(DEFAULT_OVERLAY_STYLE)
        } else {
          setEditOperations((operations) => [result.operation, ...operations])
        }
        setStatus(result.operation.reason ?? '선택 영역 삭제 검사를 완료했습니다.')
        return
      }

      const occurrences = textOccurrences.length > 0
        ? textOccurrences
        : await listTextOccurrences(pdfData, currentPage, editOriginal)
      setTextOccurrences(occurrences)
      if (occurrences.length === 0) {
        setSelectedOccurrenceId(undefined)
        setStatus('현재 페이지에서 삭제할 원문을 찾지 못했습니다.')
        return
      }

      const nextSelectedOccurrence = selectedOccurrence && selectedOccurrence.source !== 'manual'
        ? occurrences.find((occurrence) => occurrence.id === selectedOccurrence.id)
        : undefined
      if (occurrences.length > 1 && !nextSelectedOccurrence) {
        setStatus(`같은 문구가 ${occurrences.length}개 있습니다. 문서의 강조 영역이나 오른쪽 후보 목록에서 삭제할 항목을 선택하세요.`)
        return
      }

      const result = await attemptDirectTextDelete(
        pdfData,
        currentPage,
        editOriginal,
        nextSelectedOccurrence ?? occurrences[0],
      )
      if (result.operation.status === 'applied') {
        pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
        setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
        setEditOperations((operations) => [result.operation, ...operations])
        replacePdfData(result.data, currentPage)
        setEditOriginal('')
        setEditReplacement('')
        setTextOccurrences([])
        setSelectedOccurrenceId(undefined)
        setManualOverlayEnabled(false)
        setTextSelectionEnabled(false)
        setManualOverlayRect(null)
        setOverlayStyle(DEFAULT_OVERLAY_STYLE)
      } else {
        setEditOperations((operations) => [result.operation, ...operations])
      }
      setStatus(result.operation.reason ?? '실제 텍스트 삭제 검사를 완료했습니다.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '실제 텍스트 삭제 중 오류가 발생했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  async function runElementDelete(): Promise<void> {
    if (!pdfData) {
      setStatus('삭제할 PDF를 먼저 여세요.')
      return
    }
    const targetOccurrence = selectedOccurrence?.source === 'manual' ? selectedOccurrence : manualOccurrence
    if (!targetOccurrence) {
      setInspectorTab('text')
      setManualOverlayEnabled(true)
      setTextSelectionEnabled(false)
      setStatus('삭제할 도형이나 요소 영역을 문서 위에서 드래그하세요.')
      return
    }
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const undoSnapshot = createUndoSnapshot('도형/요소 삭제')
      const { attemptSelectedRectDelete } = await import('./lib/textEdit')
      const result = await attemptSelectedRectDelete(pdfData, targetOccurrence.pageNumber, targetOccurrence, {
        originalText: '도형/이미지/요소 영역',
        redactionOptions: {
          deleteAnnotations: true,
          deleteLinks: true,
          imageMethod: 1,
          lineArtMethod: 2,
          padding: 1.5,
        },
        successReason: '선택한 도형/이미지/요소 영역을 PDF 내부 redaction으로 삭제했습니다.',
      })
      if (result.operation.status === 'applied') {
        pushUndoSnapshot(undoSnapshot ? { ...undoSnapshot, operationId: result.operation.id } : null)
        setEditSnapshots((snapshots) => ({ ...snapshots, [result.operation.id]: pdfData.slice(0) }))
        setEditOperations((operations) => [result.operation, ...operations])
        replacePdfData(result.data, targetOccurrence.pageNumber)
        setCurrentPage(targetOccurrence.pageNumber)
        setTextOccurrences([])
        setSelectedOccurrenceId(undefined)
        setManualOverlayEnabled(false)
        setTextSelectionEnabled(false)
        setManualOverlayRect(null)
        setOverlayStyle(DEFAULT_OVERLAY_STYLE)
      } else {
        setEditOperations((operations) => [result.operation, ...operations])
      }
      setStatus(result.operation.reason ?? '도형/이미지/요소 삭제 검사를 완료했습니다.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '도형/이미지/요소 삭제 중 오류가 발생했습니다.')
    } finally {
      setIsProcessing(false)
    }
  }

  useEffect(() => {
    textDeleteActionRef.current = () => {
      void runTextDelete()
    }
    elementDeleteActionRef.current = () => {
      void runElementDelete()
    }
  })

  async function handleTextRectSelect(pageNumber: number, rect: TextOccurrenceRect): Promise<void> {
    if (!pdfData) return
    try {
      const { listTextOccurrencesInRect } = await import('./lib/textEdit')
      const occurrences = await listTextOccurrencesInRect(pdfData, pageNumber, rect)
      if (occurrences.length > 0) {
        const selected = occurrences[0]
        activatePage(pageNumber, false)
        setTextOccurrences(occurrences)
        setSelectedOccurrenceId(selected.id)
        setManualOverlayRect(null)
        setEditOriginal(selected.snippet)
        setStatus(`드래그로 선택한 텍스트를 인식했습니다: ${selected.snippet}`)
        return
      }

      const manual = createManualOccurrence(pageNumber, rect)
      activatePage(pageNumber, false)
      setTextOccurrences([])
      setManualOverlayRect(manual.rect)
      setSelectedOccurrenceId(manual.id)
      setEditOriginal('')
      setStatus('선택 영역에서 텍스트를 인식하지 못했습니다. 영역 삭제는 가능합니다.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '드래그 선택 처리 중 오류가 발생했습니다.')
    }
  }

  function undoEditOperation(operationId: string): void {
    const operationIndex = editOperations.findIndex((operation) => operation.id === operationId)
    if (operationIndex === -1) {
      setStatus('되돌릴 작업 이력을 찾지 못했습니다.')
      return
    }

    const operation = editOperations[operationIndex]
    const snapshot = editSnapshots[operationId]
    if (!snapshot) {
      setStatus('이 작업은 이전 PDF 스냅샷이 없어 되돌릴 수 없습니다.')
      return
    }

    const removedOperations = editOperations.slice(0, operationIndex + 1)
    const remainingOperations = editOperations.slice(operationIndex + 1)
    const removedIds = new Set(removedOperations.map((operation) => operation.id))
    replacePdfData(snapshot.slice(0), operation.pageNumber)
    setEditOperations(remainingOperations)
    setEditSnapshots((snapshots) => {
      const next = { ...snapshots }
      for (const id of removedIds) delete next[id]
      return next
    })
    setUndoStack((stack) => stack.filter((snapshot) => !removedIds.has(snapshot.operationId ?? '')))
    setTextOccurrences([])
    setSelectedOccurrenceId(undefined)
    setManualOverlayEnabled(false)
    setTextSelectionEnabled(false)
    setManualOverlayRect(null)
    setOverlayStyle(DEFAULT_OVERLAY_STYLE)
    setStatus(`${removedOperations.length}개 본문 작업을 되돌렸습니다.`)
  }

  async function exportProject(): Promise<void> {
    if (!manifest || !pdfData) {
      setStatus('저장할 프로젝트가 없습니다.')
      return
    }
    const bundle = createProjectBundle({ ...manifest, updatedAt: new Date().toISOString() })
    const blob = await exportProjectPackage(bundle)
    downloadBytes(await blob.arrayBuffer(), `${manifest.name}.pdfproj`, 'application/x-pdfproj')
    setStatus('.pdfproj 프로젝트 파일을 내보냈습니다.')
  }

  function restoreProjectBundle(bundle: ProjectBundle, statusMessage: string): void {
    const activeSourceId = bundle.activeSourceId && bundle.sourceDocuments.some((source) => source.id === bundle.activeSourceId)
      ? bundle.activeSourceId
      : bundle.sourceDocuments[0]?.id ?? null
    const sourceDocumentsWithCurrentPdf = activeSourceId
      ? bundle.sourceDocuments.map((source) => (
          source.id === activeSourceId
            ? {
                ...source,
                data: bundle.pdfData.slice(0),
                pageCount: bundle.manifest.pageCount || source.pageCount,
                rangeText: source.rangeText || `1-${bundle.manifest.pageCount || source.pageCount}`,
              }
            : source
        ))
      : bundle.sourceDocuments
    const sessions = Object.fromEntries(
      Object.entries(bundle.documentSessions ?? {}).map(([sourceId, session]) => [
        sourceId,
        toDocumentSessionState(session),
      ]),
    )
    const activeSession = activeSourceId ? sessions[activeSourceId] : undefined

    documentSessionsRef.current = sessions
    setActiveSource(activeSourceId)
    setManifest(bundle.manifest)
    replacePdfData(bundle.pdfData, 'all', { syncActiveSource: false })
    setSourceDocuments(sourceDocumentsWithCurrentPdf)
    setEditOperations(activeSession?.editOperations ?? bundle.editOperations)
    setEditSnapshots(activeSession?.editSnapshots ?? bundle.editSnapshots ?? {})
    setPageOperations(activeSession?.pageOperations ?? bundle.pageOperations)
    setCurrentPage(activeSession?.currentPage ?? 1)
    setExtractRange(activeSession?.extractRange ?? `1-${bundle.manifest.pageCount}`)
    setUndoStack([])
    setTextOccurrences([])
    setSelectedOccurrenceId(undefined)
    setManualOverlayEnabled(false)
    setTextSelectionEnabled(false)
    setManualOverlayRect(null)
    setOverlayStyle(DEFAULT_OVERLAY_STYLE)
    setShowHome(false)
    setMode('editor')
    setInspectorTab('pages')
    setStatus(statusMessage)
  }

  async function importProject(files: FileList | null): Promise<void> {
    const file = files?.[0]
    if (!file) return
    try {
      const bundle = await importProjectPackage(file)
      restoreProjectBundle(bundle, `${bundle.manifest.name} 프로젝트를 불러왔습니다.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '프로젝트 불러오기에 실패했습니다.')
    } finally {
      if (projectInputRef.current) projectInputRef.current.value = ''
    }
  }

  async function openRecent(id: string): Promise<void> {
    const bundle = await loadProject(id)
    if (!bundle) {
      setStatus('최근 프로젝트를 찾을 수 없습니다.')
      return
    }
    restoreProjectBundle(bundle, `${bundle.manifest.name} 작업을 이어갑니다.`)
  }

  async function deleteRecent(id: string): Promise<void> {
    await removeProject(id)
    setRecentProjects(await listRecentProjects())
    setStatus('최근 작업을 삭제했습니다.')
  }

  function jumpToTypedPage(): void {
    if (!pdfDoc) return
    const page = Number(pageJumpInputRef.current?.value ?? currentPage)
    if (!Number.isInteger(page) || page < 1 || page > pdfDoc.numPages) {
      setStatus(`1-${pdfDoc.numPages} 사이의 페이지 번호를 입력하세요.`)
      if (pageJumpInputRef.current) pageJumpInputRef.current.value = String(currentPage)
      return
    }
    activatePage(page, true)
    setStatus(`${page}쪽으로 이동했습니다.`)
  }

  return (
    <div className="app-shell">
      <input
        ref={pdfInputRef}
        hidden
        multiple
        type="file"
        accept="application/pdf"
        onChange={(event) => void openPdfFiles(event.target.files)}
      />
      <input
        ref={mergeInputRef}
        hidden
        multiple
        type="file"
        accept="application/pdf"
        onChange={(event) => void addMergeFiles(event.target.files)}
      />
      <input
        ref={projectInputRef}
        hidden
        type="file"
        accept=".pdfproj,application/x-pdfproj"
        onChange={(event) => void importProject(event.target.files)}
      />

      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => {
            setShowHome(true)
            setPageListFullscreen(false)
            resetTransientSelection()
            setStatus('홈 화면으로 이동했습니다.')
          }}
          aria-label="홈 화면으로 이동"
        >
          <FileText aria-hidden="true" />
          <div>
            <strong>로컬 PDF 편집기</strong>
            <span>내부용</span>
          </div>
        </button>
        <nav className="toolbar" aria-label="주요 도구">
          <button type="button" onClick={() => pdfInputRef.current?.click()}>
            <FolderOpen aria-hidden="true" />
            PDF 열기
          </button>
          <button type="button" onClick={() => projectInputRef.current?.click()}>
            <FileArchive aria-hidden="true" />
            프로젝트
          </button>
          <button type="button" onClick={() => void exportProject()} disabled={!manifest || !pdfData}>
            <Save aria-hidden="true" />
            저장
          </button>
          <button
            type="button"
            onClick={() => pdfData && downloadBytes(pdfData, activeSource?.fileName ?? `${manifest?.name ?? 'document'}.pdf`)}
            disabled={!pdfData}
          >
            <Download aria-hidden="true" />
            내보내기
          </button>
          <div className="search-box">
            <Search aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={searchText}
              placeholder="문서 내 검색"
              disabled={!pdfDoc}
              onFocus={() => setRailTab('recent')}
              onChange={(event) => {
                setSearchText(event.target.value)
                setRailTab('recent')
              }}
            />
            <kbd>Ctrl+F</kbd>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={!pdfDoc}
            onClick={() => {
              const currentZoom = zoomRef.current
              const next = clamp(Number((currentZoom / ZOOM_STEP_FACTOR).toFixed(3)), MIN_ZOOM, MAX_ZOOM)
              if (Math.abs(next - currentZoom) < 0.001) return
              const stage = documentScrollRef.current
              if (stage) {
                const offsetX = stage.clientWidth / 2
                const offsetY = stage.clientHeight / 2
                pendingZoomAnchorRef.current = {
                  contentX: stage.scrollLeft + offsetX,
                  contentY: stage.scrollTop + offsetY,
                  offsetX,
                  offsetY,
                  ratio: next / currentZoom,
                }
              }
              zoomRef.current = next
              setZoom(next)
            }}
            aria-label="축소"
          >
            <ZoomOut aria-hidden="true" />
          </button>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="icon-button"
            disabled={!pdfDoc}
            onClick={() => {
              const currentZoom = zoomRef.current
              const next = clamp(Number((currentZoom * ZOOM_STEP_FACTOR).toFixed(3)), MIN_ZOOM, MAX_ZOOM)
              if (Math.abs(next - currentZoom) < 0.001) return
              const stage = documentScrollRef.current
              if (stage) {
                const offsetX = stage.clientWidth / 2
                const offsetY = stage.clientHeight / 2
                pendingZoomAnchorRef.current = {
                  contentX: stage.scrollLeft + offsetX,
                  contentY: stage.scrollTop + offsetY,
                  offsetX,
                  offsetY,
                  ratio: next / currentZoom,
                }
              }
              zoomRef.current = next
              setZoom(next)
            }}
            aria-label="확대"
          >
            <ZoomIn aria-hidden="true" />
          </button>
          <button
            type="button"
            className={textSelectionEnabled ? 'icon-button active-tool' : 'icon-button'}
            disabled={!pdfDoc}
            onClick={() => {
              setTextSelectionEnabled((enabled) => !enabled)
              setManualOverlayEnabled(false)
            }}
            aria-label="영역 선택"
          >
            <SquareDashedMousePointer aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={undoLastAction} disabled={undoStack.length === 0} aria-label="뒤로가기">
            <Undo2 aria-hidden="true" />
          </button>
        </nav>
      </header>

      {showHome || (!pdfData && sourceDocuments.length === 0) ? (
        <HomeScreen
          recentProjects={recentProjects}
          onOpenPdf={() => pdfInputRef.current?.click()}
          onOpenProject={() => projectInputRef.current?.click()}
          onStartMerge={() => {
            setMode('merge')
            mergeInputRef.current?.click()
          }}
          onOpenRecent={(id) => void openRecent(id)}
          onDeleteRecent={(id) => void deleteRecent(id)}
        />
      ) : (
        <main
          className={pageListFullscreen ? 'workspace page-list-fullscreen' : 'workspace'}
          style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
        >
          <aside className="left-rail">
            <div className="rail-tabs">
              <button type="button" className={railTab === 'pages' ? 'active' : ''} onClick={() => setRailTab('pages')}>페이지</button>
              <button type="button" className={railTab === 'recent' ? 'active' : ''} onClick={() => setRailTab('recent')}>최근 문서</button>
            </div>
            <div className="rail-tools">
              <button
                type="button"
                className={!pageListFullscreen && thumbView === 'grid' ? 'icon-button active-tool' : 'icon-button'}
                onClick={() => {
                  setThumbView('grid')
                  setPageListFullscreen(false)
                }}
                aria-label="격자 보기"
              >
                <LayoutGrid aria-hidden="true" />
              </button>
              <button
                type="button"
                className={pageListFullscreen ? 'icon-button active-tool' : 'icon-button'}
                onClick={() => {
                  setThumbView('list')
                  setPageListFullscreen((expanded) => !expanded)
                }}
                aria-label="페이지 목록 전체화면"
              >
                <List aria-hidden="true" />
              </button>
            </div>
            {railTab === 'pages' ? (
              <>
              <div className={`page-list ${thumbView}`}>
                {pdfDoc ? (
                  Array.from({ length: pdfDoc.numPages }, (_, index) => index + 1).map((page) => (
                    <PageThumb
                      doc={pdfDoc}
                      dragging={draggedPage === page}
                      key={page}
                      pageNumber={page}
                      renderVersion={documentRenderVersion + (pageRenderVersions[page] ?? 0)}
                      selected={page === currentPage}
                      onClick={() => activatePage(page, true)}
                      onDragEnd={() => setDraggedPage(null)}
                      onDragStart={() => setDraggedPage(page)}
                      onDropOnPage={handlePageDrop}
                    />
                  ))
                ) : (
                  <p className="empty-text">PDF를 불러오는 중입니다.</p>
                )}
              </div>
              <div className="rail-footer">
                <span>{pdfDoc ? `총 ${pdfDoc.numPages} 페이지` : 'PDF 없음'}</span>
              </div>
              </>
            ) : (
              <div className="search-results">
                <div className="search-results-header">
                  <strong>{searchText.trim() ? '검색' : '최근 문서'}</strong>
                  <span>{searchText.trim() ? searchState : `${recentProjects.length}개`}</span>
                </div>
                {!searchText.trim() ? (
                  recentProjects.length === 0 ? (
                    <p className="empty-text">아직 저장된 최근 문서가 없습니다.</p>
                  ) : recentProjects.map((project) => (
                    <button type="button" className="search-result" key={project.id} onClick={() => void openRecent(project.id)}>
                      <span>{project.pageCount}쪽</span>
                      <em>{project.name}</em>
                    </button>
                  ))
                ) : searchResults.length === 0 ? (
                  <p className="empty-text">{searchState}</p>
                ) : (
                  searchResults.map((result) => (
                    <button
                      type="button"
                      className={result.pageNumber === currentPage ? 'search-result active' : 'search-result'}
                      key={result.id}
                      onClick={() => activatePage(result.pageNumber, true)}
                    >
                      <span>{result.pageNumber}쪽</span>
                      <em>{result.snippet}</em>
                    </button>
                  ))
                )}
              </div>
            )}
          </aside>
          <section className="document-stage" aria-label="PDF 문서">
            {pdfData ? (
              <div className="document-tabs" aria-label="열린 PDF">
                {sourceDocuments.map((source) => (
                  <div
                    className={source.id === activeSourceId ? 'document-tab active' : 'document-tab'}
                    key={source.id}
                    ref={(node) => {
                      if (node) documentTabRefs.current.set(source.id, node)
                      else documentTabRefs.current.delete(source.id)
                    }}
                    title={`${source.fileName} · ${source.pageCount}쪽`}
                    role="tab"
                    aria-selected={source.id === activeSourceId}
                    tabIndex={0}
                    onClick={() => switchSourceDocument(source.id)}
                    onKeyDown={(event) => handleDocumentTabKeyDown(event, source.id)}
                  >
                    <span className="document-tab-name">{source.fileName}</span>
                    <span className="document-tab-meta" aria-hidden="true">{source.pageCount}쪽</span>
                    {sourceDocuments.length > 1 && (
                      <button
                        type="button"
                        className="document-tab-close"
                        aria-label={`${source.fileName} 탭 닫기`}
                        onClick={(e) => { e.stopPropagation(); removeSource(source.id) }}
                      >×</button>
                    )}
                  </div>
                ))}
                {!activeSourceId ? (
                  <div className="document-tab active" role="tab" aria-selected>
                    <span className="document-tab-name">{manifest?.originalFileName ?? `${manifest?.name ?? 'document'}.pdf`}</span>
                    <span className="document-tab-meta" aria-hidden="true">{pdfDoc?.numPages ?? 0}쪽</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div ref={documentScrollRef} className="document-scroll">
              {mode === 'merge' ? (
                <MergePanel
                  author={mergeAuthor}
                  pageCount={mergePageCount}
                  sources={sourceDocuments}
                  title={mergeTitle}
                  onAddFiles={() => mergeInputRef.current?.click()}
                  onAuthorChange={setMergeAuthor}
                  onMoveSource={moveSource}
                  onRemoveSource={removeSource}
                  onRunMerge={() => void runMerge()}
                  onTitleChange={setMergeTitle}
                  onUpdateSource={updateSource}
                />
              ) : (
                <PdfCanvas
                  doc={pdfDoc}
                  documentRenderVersion={documentRenderVersion}
                  manualOverlayEnabled={manualOverlayEnabled}
                  occurrences={visibleOccurrences}
                  pageRenderVersions={pageRenderVersions}
                  currentPage={currentPage}
                  searchText={searchText}
                  selectedOccurrenceId={selectedOccurrenceId}
                  scrollRequest={scrollRequest}
                  scrollRootRef={documentScrollRef}
                  textSelectionEnabled={textSelectionEnabled}
                  zoom={zoom}
                  onStyleSample={handleOverlayStyleSample}
                  onManualRectChange={(pageNumber, rect) => {
                    activatePage(pageNumber, false)
                    setManualOverlayRect(rect)
                    setSelectedOccurrenceId('manual-' + pageNumber)
                  }}
                  onSelectOccurrence={setSelectedOccurrenceId}
                  onTextRectSelect={(pageNumber, rect) => void handleTextRectSelect(pageNumber, rect)}
                  onVisiblePageChange={(page) => activatePage(page, false)}
                />
              )}
            </div>
          </section>

          <div
            className="inspector-resizer"
            role="separator"
            aria-label="오른쪽 패널 크기 조절"
            aria-orientation="vertical"
            onPointerDown={startInspectorResize}
            onPointerMove={moveInspectorResize}
            onPointerCancel={stopInspectorResize}
            onPointerUp={stopInspectorResize}
          />

          <aside className="inspector">
            <div className="mode-switch">
              <button type="button" className={inspectorTab === 'text' ? 'active' : ''} onClick={() => {
                setInspectorTab('text')
                setMode('editor')
              }}>
                텍스트 수정
              </button>
              <button type="button" className={inspectorTab === 'pages' ? 'active' : ''} onClick={() => {
                setInspectorTab('pages')
                setMode('editor')
              }}>
                페이지 관리
              </button>
              <button type="button" className={inspectorTab === 'merge' ? 'active' : ''} onClick={() => {
                setInspectorTab('merge')
                setMode('merge')
              }}>
                병합
              </button>
            </div>

            {inspectorTab === 'text' ? (
              <EditorInspector
                currentPage={currentPage}
                editOperations={editOperations}
                editSnapshots={editSnapshots}
                extractRange={extractRange}
                isProcessing={isProcessing}
                occurrences={textOccurrences}
                original={editOriginal}
                pageSummary={selectedPageSummary}
                replacement={editReplacement}
                manualOverlayEnabled={manualOverlayEnabled}
                manualOccurrence={manualOccurrence}
                overlayStyle={overlayStyle}
                selectedOccurrenceId={selectedOccurrenceId}
                textSelectionEnabled={textSelectionEnabled}
                onExtract={() => void runExtract()}
                onManualModeChange={(enabled) => {
                  setManualOverlayEnabled(enabled)
                  if (enabled) setTextSelectionEnabled(false)
                  if (!enabled) {
                    setManualOverlayRect(null)
                    if (selectedOccurrence?.source === 'manual') setSelectedOccurrenceId(undefined)
                  }
                }}
                onOriginalChange={(value) => {
                  setEditOriginal(value)
                  setTextOccurrences([])
                  setSelectedOccurrenceId(undefined)
                }}
                onReplacementChange={setEditReplacement}
                onRunElementDelete={() => void runElementDelete()}
                onRunTextDelete={() => void runTextDelete()}
                onRunTextEdit={() => void runTextEdit()}
                onRangeChange={setExtractRange}
                onStyleChange={setOverlayStyle}
                onSelectOccurrence={setSelectedOccurrenceId}
                onTextSelectionModeChange={(enabled) => {
                  setTextSelectionEnabled(enabled)
                  if (enabled) setManualOverlayEnabled(false)
                }}
                onUndoOperation={undoEditOperation}
              />
            ) : inspectorTab === 'pages' ? (
              <PageManageInspector
                activeSourceId={activeSourceId}
                currentPage={currentPage}
                fileName={activeSource?.fileName ?? manifest?.originalFileName ?? sourceDocuments[0]?.fileName ?? 'document.pdf'}
                fileSize={activeSource?.data.byteLength ?? pdfData?.byteLength ?? 0}
                isProcessing={isProcessing}
                pageCount={pdfDoc?.numPages ?? 0}
                rangeText={extractRange}
                sources={sourceDocuments}
                onAddFiles={() => {
                  setInspectorTab('merge')
                  setMode('merge')
                  mergeInputRef.current?.click()
                }}
                onDuplicate={() => void runPageDuplicate()}
                onExtract={() => void runExtract()}
                onMoveSource={moveSource}
                onQuickRange={(value) => setExtractRange(value)}
                onRangeChange={setExtractRange}
                onRemoveSource={removeSource}
                onRotateLeft={() => void runPageRotate(-90)}
                onRotateRight={() => void runPageRotate(90)}
                onDelete={() => void runPageDelete()}
                onSwitchSource={switchSourceDocument}
                onUndo={undoLastAction}
              />
            ) : (
              <MergeInspector
                addSeparatorPages={mergeAddSeparatorPages}
                isProcessing={isProcessing}
                pageCount={mergePageCount}
                sources={sourceDocuments}
                onAddFiles={() => mergeInputRef.current?.click()}
                onAddSeparatorPagesChange={setMergeAddSeparatorPages}
                onRunMerge={() => void runMerge()}
              />
            )}
          </aside>
        </main>
      )}

      <footer className="statusbar">
        <span><ShieldCheck aria-hidden="true" /> {status}</span>
        {pdfDoc ? (
          <form
            className="page-jump"
            onSubmit={(event) => {
              event.preventDefault()
              jumpToTypedPage()
            }}
          >
            <span className="status-page-summary">페이지 {selectedPageSummary}</span>
            <label>
              <span>이동</span>
              <input
                aria-label="이동할 페이지"
                key={currentPage}
                ref={pageJumpInputRef}
                defaultValue={String(currentPage)}
                inputMode="numeric"
                onBlur={(event) => {
                  if (!event.currentTarget.value) event.currentTarget.value = String(currentPage)
                }}
                onChange={(event) => {
                  event.currentTarget.value = event.currentTarget.value.replace(/[^\d]/g, '')
                }}
              />
            </label>
            <span>/ {pdfDoc.numPages}</span>
            <button type="submit">이동</button>
            <span>{Math.round(zoom * 100)}% · 로컬 처리 중</span>
          </form>
        ) : (
          <span>PDF 없음</span>
        )}
      </footer>
    </div>
  )
}

interface HomeScreenProps {
  recentProjects: RecentProject[]
  onDeleteRecent: (id: string) => void
  onOpenPdf: () => void
  onOpenProject: () => void
  onOpenRecent: (id: string) => void
  onStartMerge: () => void
}

function HomeScreen({
  recentProjects,
  onDeleteRecent,
  onOpenPdf,
  onOpenProject,
  onOpenRecent,
  onStartMerge,
}: HomeScreenProps) {
  return (
    <main className="home">
      <section className="start-panel">
        <div>
          <h1>PDF 작업을 이어가거나 새로 시작하세요</h1>
          <p>파일은 서버로 업로드하지 않고 이 브라우저 안에서만 열고 저장합니다.</p>
        </div>
        <div className="start-actions">
          <button type="button" className="primary-action" onClick={onOpenPdf}>
            <Upload aria-hidden="true" />
            PDF 열기
          </button>
          <button type="button" onClick={onStartMerge}>
            <Merge aria-hidden="true" />
            여러 PDF 합치기
          </button>
          <button type="button" onClick={onOpenProject}>
            <FileArchive aria-hidden="true" />
            프로젝트 불러오기
          </button>
        </div>
      </section>
      <section className="recent-panel">
        <header>
          <h2>최근 작업</h2>
          <span>{recentProjects.length}개</span>
        </header>
        {recentProjects.length === 0 ? (
          <p className="empty-text">아직 저장된 작업이 없습니다.</p>
        ) : (
          <div className="recent-list">
            {recentProjects.map((project) => (
              <article className="recent-item" key={project.id}>
                <button type="button" onClick={() => onOpenRecent(project.id)}>
                  <strong>{project.name}</strong>
                  <span>{project.fileName} · {project.pageCount}쪽</span>
                  <time>{new Date(project.updatedAt).toLocaleString('ko-KR')}</time>
                </button>
                <button type="button" className="icon-button danger" onClick={() => onDeleteRecent(project.id)} aria-label="최근 작업 삭제">
                  <Trash2 aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

interface PdfCanvasProps {
  currentPage: number
  doc: PDFDocumentProxy | null
  documentRenderVersion: number
  manualOverlayEnabled: boolean
  occurrences: TextOccurrence[]
  pageRenderVersions: Record<number, number>
  scrollRequest: PageScrollRequest | null
  scrollRootRef: RefObject<HTMLDivElement | null>
  searchText: string
  selectedOccurrenceId: string | undefined
  textSelectionEnabled: boolean
  zoom: number
  onManualRectChange: (pageNumber: number, rect: TextOccurrenceRect) => void
  onSelectOccurrence: (id: string) => void
  onStyleSample: (style: OverlayTextStyle) => void
  onTextRectSelect: (pageNumber: number, rect: TextOccurrenceRect) => void
  onVisiblePageChange: (pageNumber: number) => void
}

interface PageThumbProps {
  doc: PDFDocumentProxy
  dragging: boolean
  pageNumber: number
  renderVersion: number
  selected: boolean
  onClick: () => void
  onDragEnd: () => void
  onDragStart: () => void
  onDropOnPage: (pageNumber: number) => void
}

function PageThumb({
  doc,
  dragging,
  pageNumber,
  renderVersion,
  selected,
  onClick,
  onDragEnd,
  onDragStart,
  onDropOnPage,
}: PageThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef(doc)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    docRef.current = doc
  }, [doc])

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return undefined

    setRenderState('loading')
    docRef.current.getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(0.18, 120 / baseViewport.width)
        const viewport = page.getViewport({ scale })
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0)
        context.clearRect(0, 0, viewport.width, viewport.height)
        renderTask = page.render({ canvas, canvasContext: context, viewport })
        await renderTask.promise
        if (!cancelled) setRenderState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) return
        setRenderState('failed')
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pageNumber, renderVersion])

  return (
    <button
      type="button"
      className={[
        'page-thumb',
        selected ? 'active' : '',
        dragging ? 'dragging' : '',
        renderState === 'failed' ? 'render-failed' : '',
      ].filter(Boolean).join(' ')}
      draggable
      onClick={onClick}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(pageNumber))
        onDragStart()
      }}
      onDrop={(event) => {
        event.preventDefault()
        const sourcePage = Number(event.dataTransfer.getData('text/plain'))
        if (Number.isFinite(sourcePage)) onDropOnPage(pageNumber)
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span>{pageNumber}</span>
    </button>
  )
}

function toHexColor(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`
}

function colorDistance(a: number[], b: number[]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2,
  )
}

function averageColor(samples: number[][], fallback: number[]): number[] {
  if (samples.length === 0) return fallback
  const total = samples.reduce(
    (sum, sample) => [sum[0] + sample[0], sum[1] + sample[1], sum[2] + sample[2]],
    [0, 0, 0],
  )
  return total.map((value) => value / samples.length)
}

function sampleOverlayStyle(
  canvas: HTMLCanvasElement,
  occurrence: TextOccurrence,
  viewportScale: number,
): OverlayTextStyle {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const cssWidth = canvas.clientWidth || Number.parseFloat(canvas.style.width) || canvas.width
  const cssHeight = canvas.clientHeight || Number.parseFloat(canvas.style.height) || canvas.height
  const scaleX = canvas.width / cssWidth
  const scaleY = canvas.height / cssHeight
  const x = clamp(Math.floor(occurrence.rect.x * viewportScale * scaleX), 0, canvas.width - 1)
  const y = clamp(Math.floor(occurrence.rect.y * viewportScale * scaleY), 0, canvas.height - 1)
  const width = clamp(Math.ceil(occurrence.rect.width * viewportScale * scaleX), 1, canvas.width - x)
  const height = clamp(Math.ceil(occurrence.rect.height * viewportScale * scaleY), 1, canvas.height - y)
  const fontSize = clamp(occurrence.rect.height * 0.78, 5, 96)
  if (!context) return { ...DEFAULT_OVERLAY_STYLE, fontSize }

  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.18))
  const bgSamples: number[][] = []
  const textSamples: number[][] = []
  const image = context.getImageData(
    clamp(x - padding, 0, canvas.width - 1),
    clamp(y - padding, 0, canvas.height - 1),
    clamp(width + padding * 2, 1, canvas.width - clamp(x - padding, 0, canvas.width - 1)),
    clamp(height + padding * 2, 1, canvas.height - clamp(y - padding, 0, canvas.height - 1)),
  )
  const localX = x - clamp(x - padding, 0, canvas.width - 1)
  const localY = y - clamp(y - padding, 0, canvas.height - 1)

  for (let py = 0; py < image.height; py += 1) {
    for (let px = 0; px < image.width; px += 1) {
      const offset = (py * image.width + px) * 4
      if (image.data[offset + 3] < 12) continue
      const sample = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      const inside = px >= localX && px <= localX + width && py >= localY && py <= localY + height
      if (!inside) bgSamples.push(sample)
    }
  }

  const background = averageColor(bgSamples, [255, 255, 255])
  for (let py = localY; py < Math.min(image.height, localY + height); py += 1) {
    for (let px = localX; px < Math.min(image.width, localX + width); px += 1) {
      const offset = (py * image.width + px) * 4
      if (image.data[offset + 3] < 12) continue
      const sample = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      if (colorDistance(sample, background) > 36) textSamples.push(sample)
    }
  }

  const fallbackText = (background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114) > 145
    ? [17, 17, 17]
    : [245, 245, 245]
  const text = averageColor(textSamples, fallbackText)
  return {
    backgroundColor: toHexColor(background[0], background[1], background[2]),
    fontSize,
    textColor: toHexColor(text[0], text[1], text[2]),
  }
}

function PdfCanvas({
  currentPage,
  doc,
  documentRenderVersion,
  manualOverlayEnabled,
  occurrences,
  pageRenderVersions,
  scrollRequest,
  scrollRootRef,
  searchText,
  selectedOccurrenceId,
  textSelectionEnabled,
  zoom,
  onManualRectChange,
  onSelectOccurrence,
  onStyleSample,
  onTextRectSelect,
  onVisiblePageChange,
}: PdfCanvasProps) {
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const [pageMetrics, setPageMetrics] = useState<Record<number, PageRenderMetrics>>({})

  const defaultMetrics = pageMetrics[currentPage] ?? pageMetrics[1] ?? DEFAULT_PAGE_METRICS

  const handlePageMetricsChange = useCallback((pageNumber: number, metrics: PageRenderMetrics) => {
    setPageMetrics((current) => {
      const previous = current[pageNumber]
      if (previous && previous.width === metrics.width && previous.height === metrics.height) return current
      return { ...current, [pageNumber]: metrics }
    })
  }, [])

  useEffect(() => {
    if (!scrollRequest) return
    const pageNode = pageRefs.current.get(scrollRequest.page)
    pageNode?.scrollIntoView({ block: 'start' })
  }, [scrollRequest])

  useEffect(() => {
    if (!doc || !scrollRootRef.current) return
    const root = scrollRootRef.current
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => ({
          page: Number((entry.target as HTMLElement).dataset.pageNumber),
          ratio: entry.intersectionRatio,
          top: Math.abs(entry.boundingClientRect.top - root.getBoundingClientRect().top),
        }))
        .filter((entry) => Number.isFinite(entry.page))
        .sort((a, b) => b.ratio - a.ratio || a.top - b.top)

      const first = visible[0]
      if (first && first.page !== currentPage) onVisiblePageChange(first.page)
    }, {
      root,
      rootMargin: '-12% 0px -62% 0px',
      threshold: [0.1, 0.25, 0.5, 0.75, 1],
    })

    for (const node of pageRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [currentPage, doc, onVisiblePageChange, scrollRootRef])

  if (!doc) {
    return <div className="document-empty">PDF를 열면 여기에 문서가 표시됩니다.</div>
  }

  return (
    <div className="canvas-stack">
      {Array.from({ length: doc.numPages }, (_, index) => index + 1).map((pageNumber) => (
        <div
          className={pageNumber === currentPage ? 'canvas-page active' : 'canvas-page'}
          data-page-number={pageNumber}
          key={pageNumber}
          ref={(node) => {
            if (node) pageRefs.current.set(pageNumber, node)
            else pageRefs.current.delete(pageNumber)
          }}
        >
          {shouldRenderPage(pageNumber, currentPage) ? (
            <PageCanvas
              active={pageNumber === currentPage}
              doc={doc}
              manualOverlayEnabled={manualOverlayEnabled && pageNumber === currentPage}
              occurrences={pageNumber === currentPage ? occurrences : []}
              pageNumber={pageNumber}
              renderVersion={documentRenderVersion + (pageRenderVersions[pageNumber] ?? 0)}
              searchText={searchText}
              selectedOccurrenceId={selectedOccurrenceId}
              textSelectionEnabled={textSelectionEnabled && pageNumber === currentPage}
              zoom={zoom}
              onManualRectChange={onManualRectChange}
              onMetricsChange={handlePageMetricsChange}
              onSelectOccurrence={onSelectOccurrence}
              onStyleSample={onStyleSample}
              onTextRectSelect={onTextRectSelect}
            />
          ) : (
            <PagePlaceholder
              active={pageNumber === currentPage}
              metrics={pageMetrics[pageNumber] ?? defaultMetrics}
              pageNumber={pageNumber}
              zoom={zoom}
            />
          )}
        </div>
      ))}
    </div>
  )
}

interface PageCanvasProps {
  active: boolean
  doc: PDFDocumentProxy
  manualOverlayEnabled: boolean
  occurrences: TextOccurrence[]
  pageNumber: number
  renderVersion: number
  searchText: string
  selectedOccurrenceId: string | undefined
  textSelectionEnabled: boolean
  zoom: number
  onManualRectChange: (pageNumber: number, rect: TextOccurrenceRect) => void
  onMetricsChange: (pageNumber: number, metrics: PageRenderMetrics) => void
  onSelectOccurrence: (id: string) => void
  onStyleSample: (style: OverlayTextStyle) => void
  onTextRectSelect: (pageNumber: number, rect: TextOccurrenceRect) => void
}

function PagePlaceholder({
  active,
  metrics,
  pageNumber,
  zoom,
}: {
  active: boolean
  metrics: PageRenderMetrics
  pageNumber: number
  zoom: number
}) {
  const instantScale = zoom / DEFAULT_RENDER_ZOOM
  return (
    <div className="canvas-wrap">
      <div className="page-number-badge">{pageNumber}</div>
      <div
        className="page-frame-shell page-placeholder"
        style={{
          width: Math.max(1, metrics.width * instantScale),
          height: Math.max(1, metrics.height * instantScale),
        }}
      />
      {active ? <div className="floating-note">페이지 준비 중</div> : null}
    </div>
  )
}

function PageCanvas({
  active,
  doc,
  manualOverlayEnabled,
  occurrences,
  pageNumber,
  renderVersion,
  searchText,
  selectedOccurrenceId,
  textSelectionEnabled,
  zoom,
  onManualRectChange,
  onMetricsChange,
  onSelectOccurrence,
  onStyleSample,
  onTextRectSelect,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef(doc)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const sampleKeyRef = useRef('')
  const [renderState, setRenderState] = useState('페이지 준비 중')
  const [renderMetrics, setRenderMetrics] = useState({ width: 1, height: 1 })
  const [draftSelectionRect, setDraftSelectionRect] = useState<TextOccurrenceRect | null>(null)
  const displayViewportScale = 1.35 * zoom
  const renderViewportScale = 1.35 * DEFAULT_RENDER_ZOOM
  const instantScale = zoom / DEFAULT_RENDER_ZOOM
  const dragModeEnabled = manualOverlayEnabled || textSelectionEnabled

  useEffect(() => {
    docRef.current = doc
  }, [doc])

  const selectedOccurrence = useMemo(
    () => occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId),
    [occurrences, selectedOccurrenceId],
  )

  function pointerToPdfRect(event: PointerEvent<HTMLDivElement>): TextOccurrenceRect | null {
    const overlay = overlayRef.current
    const start = dragStartRef.current
    if (!overlay || !start) return null
    const bounds = overlay.getBoundingClientRect()
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)) / displayViewportScale
    const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) / displayViewportScale
    return {
      x: start.x,
      y: start.y,
      width: x - start.x,
      height: y - start.y,
    }
  }

  useEffect(() => {
    if (!docRef.current || !canvasRef.current) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null
    const canvas = canvasRef.current
    const textLayerElement = textLayerRef.current
    const context = canvas.getContext('2d')
    if (!context) {
      setRenderState('캔버스를 준비할 수 없습니다.')
      return
    }

    setRenderState('렌더링 중')

    docRef.current.getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return
        const devicePixelRatio = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: 1.35 * DEFAULT_RENDER_ZOOM })
        const outputScale = Math.min(devicePixelRatio, 2)
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const metrics = {
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height),
        }
        setRenderMetrics(metrics)
        onMetricsChange(pageNumber, metrics)
        if (textLayerElement) {
          textLayerElement.replaceChildren()
          textLayerElement.style.width = `${Math.floor(viewport.width)}px`
          textLayerElement.style.height = `${Math.floor(viewport.height)}px`
          textLayerElement.style.setProperty('--total-scale-factor', `${viewport.scale}`)
        }
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0)
        context.clearRect(0, 0, viewport.width, viewport.height)

        renderTask = page.render({ canvas, canvasContext: context, viewport })
        await renderTask.promise
        let selectableTextCount = 0
        let textExtractionFailed = false
        if (textLayerElement && !cancelled) {
          try {
            const textContent = await page.getTextContent()
            selectableTextCount = textContent.items.filter((item) => (
              'str' in item && typeof item.str === 'string' && item.str.length > 0
            )).length
            textLayer = new TextLayer({
              container: textLayerElement,
              textContentSource: textContent,
              viewport,
            })
            await textLayer.render()
          } catch (error) {
            textExtractionFailed = true
            if (!cancelled) {
              textLayerElement.replaceChildren()
              console.warn('PDF text layer render failed', error)
            }
          }
        }
        if (!cancelled) {
          setRenderState(textExtractionFailed
            ? '텍스트 추출 실패: 브라우저 자산 로딩 문제일 수 있음'
            : selectableTextCount === 0
              ? '선택 가능한 텍스트 없음: 이미지형/스캔 PDF일 수 있음'
              : searchText ? `"${searchText}" 검색어 표시 준비` : '렌더링 완료')
        }
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === 'RenderingCancelledException')) return
        setRenderState(error instanceof Error ? `렌더링 실패: ${error.message}` : '페이지를 렌더링할 수 없습니다.')
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      textLayerElement?.replaceChildren()
    }
  }, [onMetricsChange, pageNumber, renderVersion, searchText])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selectedOccurrence || renderState === '렌더링 중') return
    const key = `${selectedOccurrence.id}-${canvas.width}-${canvas.height}-${renderViewportScale}`
    if (sampleKeyRef.current === key) return
    sampleKeyRef.current = key
    onStyleSample(sampleOverlayStyle(canvas, selectedOccurrence, renderViewportScale))
  }, [onStyleSample, renderState, selectedOccurrence, renderViewportScale])

  return (
    <div className="canvas-wrap">
      <div className="page-number-badge">{pageNumber}</div>
      <div
        className="page-frame-shell"
        style={{
          width: Math.max(1, renderMetrics.width * instantScale),
          height: Math.max(1, renderMetrics.height * instantScale),
        }}
      >
        <div
          className="page-frame"
          style={{ transform: `scale(${instantScale})` }}
        >
          <canvas ref={canvasRef} aria-label={`${pageNumber}페이지`} />
          <div
            ref={textLayerRef}
            className="textLayer selectable-text-layer"
            style={{ '--display-scale-factor': displayViewportScale } as CSSProperties}
            onPointerDown={() => {
              if (!dragModeEnabled && document.activeElement instanceof HTMLElement) {
                document.activeElement.blur()
              }
            }}
          />
          <div
            ref={overlayRef}
            className={dragModeEnabled ? 'page-overlay manual' : 'page-overlay'}
            onPointerDown={(event) => {
              if (!dragModeEnabled) return
              const bounds = event.currentTarget.getBoundingClientRect()
              dragStartRef.current = {
                x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)) / displayViewportScale,
                y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) / displayViewportScale,
              }
              setDraftSelectionRect(null)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (!dragModeEnabled || !dragStartRef.current) return
              const rect = pointerToPdfRect(event)
              if (!rect) return
              if (manualOverlayEnabled) onManualRectChange(pageNumber, rect)
              else setDraftSelectionRect(normalizeRect(rect))
            }}
            onPointerUp={(event) => {
              if (!dragModeEnabled || !dragStartRef.current) return
              const rect = pointerToPdfRect(event)
              dragStartRef.current = null
              setDraftSelectionRect(null)
              if (rect && Math.abs(rect.width) > 3 && Math.abs(rect.height) > 3) {
                if (manualOverlayEnabled) onManualRectChange(pageNumber, rect)
                else onTextRectSelect(pageNumber, normalizeRect(rect))
              }
            }}
          >
            {draftSelectionRect ? (
              <div
                className="selection-draft"
                style={{
                  left: draftSelectionRect.x * renderViewportScale,
                  top: draftSelectionRect.y * renderViewportScale,
                  width: Math.max(8, draftSelectionRect.width * renderViewportScale),
                  height: Math.max(8, draftSelectionRect.height * renderViewportScale),
                }}
              />
            ) : null}
            {occurrences.map((occurrence) => (
              <button
                type="button"
                key={occurrence.id}
                className={selectedOccurrenceId === occurrence.id ? 'occurrence-marker active' : 'occurrence-marker'}
                style={{
                  left: occurrence.rect.x * renderViewportScale,
                  top: occurrence.rect.y * renderViewportScale,
                  width: Math.max(8, occurrence.rect.width * renderViewportScale),
                  height: Math.max(8, occurrence.rect.height * renderViewportScale),
                }}
                title={`${occurrence.index + 1}번째 후보: ${occurrence.snippet}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectOccurrence(occurrence.id)
                }}
              >
                <span>{occurrence.source === 'manual' ? '수동' : occurrence.index + 1}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {active ? <div className="floating-note">{renderState}</div> : null}
    </div>
  )
}

interface EditorInspectorProps {
  currentPage: number
  editOperations: EditOperation[]
  editSnapshots: Record<string, ArrayBuffer>
  extractRange: string
  isProcessing: boolean
  manualOverlayEnabled: boolean
  manualOccurrence: TextOccurrence | null
  overlayStyle: OverlayTextStyle
  occurrences: TextOccurrence[]
  original: string
  pageSummary: string
  replacement: string
  selectedOccurrenceId: string | undefined
  textSelectionEnabled: boolean
  onExtract: () => void
  onManualModeChange: (enabled: boolean) => void
  onOriginalChange: (value: string) => void
  onRangeChange: (value: string) => void
  onReplacementChange: (value: string) => void
  onRunElementDelete: () => void
  onRunTextDelete: () => void
  onRunTextEdit: () => void
  onStyleChange: (style: OverlayTextStyle) => void
  onSelectOccurrence: (value: string | undefined) => void
  onTextSelectionModeChange: (enabled: boolean) => void
  onUndoOperation: (operationId: string) => void
}

function EditorInspector({
  currentPage,
  editOperations,
  editSnapshots,
  extractRange,
  isProcessing,
  manualOverlayEnabled,
  manualOccurrence,
  overlayStyle,
  occurrences,
  original,
  pageSummary,
  replacement,
  selectedOccurrenceId,
  textSelectionEnabled,
  onExtract,
  onManualModeChange,
  onOriginalChange,
  onRangeChange,
  onReplacementChange,
  onRunElementDelete,
  onRunTextDelete,
  onRunTextEdit,
  onStyleChange,
  onSelectOccurrence,
  onTextSelectionModeChange,
  onUndoOperation,
}: EditorInspectorProps) {
  return (
    <div className="inspector-body">
      <section className="field-group">
        <header>
          <h2>실험적 본문 수정</h2>
          <span>{pageSummary}</span>
        </header>
        <label>
          원문
          <textarea value={original} onChange={(event) => onOriginalChange(event.target.value)} placeholder="현재 페이지에서 찾을 문구" />
        </label>
        <label>
          바꿀 문구
          <textarea value={replacement} onChange={(event) => onReplacementChange(event.target.value)} placeholder="새로 넣을 문구" />
        </label>
        <button type="button" className="primary-action" onClick={onRunTextEdit} disabled={isProcessing}>
          <FileText aria-hidden="true" />
          {isProcessing ? '처리 중…' : manualOccurrence && selectedOccurrenceId === manualOccurrence.id
            ? '수동 영역 덮어쓰기'
            : selectedOccurrenceId
              ? '선택 후보 수정'
              : '현재 페이지에서 수정 시도'}
        </button>
        <button type="button" onClick={onRunTextDelete} disabled={isProcessing}>
          <Trash2 aria-hidden="true" />
          {isProcessing ? '처리 중…' : selectedOccurrenceId ? '선택 텍스트 실제 삭제' : '원문 실제 삭제'}
        </button>
        <p className="hint">직접 수정이 어려우면 검색된 위치를 흰색으로 가리고 새 텍스트를 얹습니다. 한글은 Noto Sans KR 폰트를 임베드합니다.</p>
        <p className="hint">실제 삭제는 흰색 박스를 쓰지 않고 PDF 내부 텍스트 객체를 제거합니다. 스캔 PDF나 복잡한 인코딩 문서는 삭제가 불가능할 수 있습니다.</p>
        <button
          type="button"
          className={textSelectionEnabled ? 'toggle-button active' : 'toggle-button'}
          onClick={() => onTextSelectionModeChange(!textSelectionEnabled)}
        >
          {textSelectionEnabled ? '글자 드래그 선택 중' : '글자 드래그 선택'}
        </button>
        <button
          type="button"
          className={manualOverlayEnabled ? 'toggle-button active' : 'toggle-button'}
          onClick={() => onManualModeChange(!manualOverlayEnabled)}
        >
          {manualOverlayEnabled ? '수동 영역 지정 중' : '수동 영역 지정'}
        </button>
        <button
          type="button"
          className={manualOverlayEnabled ? 'toggle-button active' : 'toggle-button'}
          onClick={() => onManualModeChange(!manualOverlayEnabled)}
        >
          {manualOverlayEnabled ? '요소 영역 선택 중' : '도형/이미지 영역 선택'}
        </button>
        <button type="button" onClick={onRunElementDelete} disabled={isProcessing}>
          <Trash2 aria-hidden="true" />
          {isProcessing ? '처리 중…' : '선택 요소 삭제'}
        </button>
        {manualOccurrence ? (
          <p className="hint">문서 위에 지정된 수동 영역이 있습니다. 필요하면 다시 드래그해서 영역을 바꾸거나 선택 요소 삭제를 실행하세요.</p>
        ) : null}
        <div className="overlay-style-grid">
          <label>
            글씨 크기
            <input
              min={5}
              max={96}
              step={0.5}
              type="number"
              value={overlayStyle.fontSize ? Number(overlayStyle.fontSize.toFixed(1)) : ''}
              placeholder="자동"
              onChange={(event) => onStyleChange({
                ...overlayStyle,
                fontSize: event.target.value ? Number(event.target.value) : undefined,
              })}
            />
          </label>
          <label>
            배경 색
            <input
              type="color"
              value={overlayStyle.backgroundColor}
              onChange={(event) => onStyleChange({ ...overlayStyle, backgroundColor: event.target.value })}
            />
          </label>
        </div>
        <p className="hint">후보를 선택하면 렌더된 PDF에서 배경색과 크기를 자동 추정합니다. 어긋나면 여기서 직접 조정하세요.</p>
        {occurrences.length > 0 ? (
          <div className="occurrence-list">
            <strong>수정 후보 {occurrences.length}개</strong>
            {occurrences.map((occurrence) => (
              <button
                type="button"
                key={occurrence.id}
                className={selectedOccurrenceId === occurrence.id ? 'active' : ''}
                onClick={() => onSelectOccurrence(occurrence.id)}
              >
                {occurrence.index + 1}번째 · {occurrence.source.toUpperCase()} · x {Math.round(occurrence.rect.x)}, y {Math.round(occurrence.rect.y)}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="field-group">
        <header>
          <h2>페이지 추출</h2>
          <span>{currentPage}쪽 기준</span>
        </header>
        <label>
          범위
          <input value={extractRange} onChange={(event) => onRangeChange(event.target.value)} placeholder="예: 1-3, 8, 12" />
        </label>
        <button type="button" onClick={onExtract}>
          <Scissors aria-hidden="true" />
          범위 추출
        </button>
      </section>

      <section className="field-group history">
        <h2>작업 이력</h2>
        {editOperations.length === 0 ? (
          <p className="empty-text">아직 본문 수정 이력이 없습니다.</p>
        ) : (
          editOperations.slice(0, 8).map((operation) => (
            <article key={operation.id} className={`history-item ${operation.status}`}>
              <strong>{operation.status === 'applied' ? '적용됨' : '불가'}</strong>
              <span>{operation.originalText} → {operation.replacementText || '삭제'}</span>
              <small>{operation.reason}</small>
              {operation.status === 'applied' ? (
                <button
                  type="button"
                  className="history-undo"
                  disabled={!editSnapshots[operation.id]}
                  onClick={() => onUndoOperation(operation.id)}
                >
                  이 시점으로 되돌리기
                </button>
              ) : null}
            </article>
          ))
        )}
      </section>
    </div>
  )
}

interface MergePanelProps {
  author: string
  pageCount: number
  sources: SourceDocument[]
  title: string
  onAddFiles: () => void
  onAuthorChange: (value: string) => void
  onMoveSource: (id: string, direction: -1 | 1) => void
  onRemoveSource: (id: string) => void
  onRunMerge: () => void
  onTitleChange: (value: string) => void
  onUpdateSource: (id: string, patch: Partial<SourceDocument>) => void
}

function MergePanel({
  author,
  pageCount,
  sources,
  title,
  onAddFiles,
  onAuthorChange,
  onMoveSource,
  onRemoveSource,
  onRunMerge,
  onTitleChange,
  onUpdateSource,
}: MergePanelProps) {
  return (
    <div className="merge-stage">
      <header className="merge-header">
        <div>
          <h1>여러 PDF 합치기</h1>
          <p>파일 순서, 페이지 범위, 회전 값을 정한 뒤 새 PDF로 조립합니다.</p>
        </div>
        <button type="button" className="primary-action" onClick={onAddFiles}>
          <FilePlus2 aria-hidden="true" />
          PDF 추가
        </button>
      </header>

      <div className="metadata-row">
        <label>
          제목
          <input value={title} onChange={(event) => onTitleChange(event.target.value)} />
        </label>
        <label>
          작성자
          <input value={author} onChange={(event) => onAuthorChange(event.target.value)} />
        </label>
        <output>{pageCount}쪽 출력 예정</output>
      </div>

      <div className="source-table">
        {sources.length === 0 ? (
          <div className="document-empty">병합할 PDF를 추가하세요.</div>
        ) : (
          sources.map((source, index) => (
            <article className="source-row" key={source.id}>
              <div className="source-order">
                <strong>{index + 1}</strong>
                <div>
                  <button type="button" className="icon-button" onClick={() => onMoveSource(source.id, -1)} aria-label="위로 이동">
                    <ChevronUp aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" onClick={() => onMoveSource(source.id, 1)} aria-label="아래로 이동">
                    <ChevronDown aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="source-info">
                <strong>{source.fileName}</strong>
                <span>{source.pageCount}쪽 · {(source.size / 1024 / 1024).toFixed(1)}MB</span>
              </div>
              <label>
                페이지 범위
                <input value={source.rangeText} onChange={(event) => onUpdateSource(source.id, { rangeText: event.target.value })} />
              </label>
              <label>
                회전
                <select
                  value={source.rotation}
                  onChange={(event) => onUpdateSource(source.id, { rotation: Number(event.target.value) as SourceDocument['rotation'] })}
                >
                  <option value={0}>0도</option>
                  <option value={90}>90도</option>
                  <option value={180}>180도</option>
                  <option value={270}>270도</option>
                </select>
              </label>
              <button type="button" className="icon-button danger" onClick={() => onRemoveSource(source.id)} aria-label="파일 제거">
                <Trash2 aria-hidden="true" />
              </button>
            </article>
          ))
        )}
      </div>

      <div className="merge-actions">
        <button type="button" className="primary-action" onClick={onRunMerge}>
          <Merge aria-hidden="true" />
          새 PDF로 병합
        </button>
      </div>
    </div>
  )
}

interface MergeInspectorProps {
  addSeparatorPages: boolean
  isProcessing: boolean
  pageCount: number
  sources: SourceDocument[]
  onAddFiles: () => void
  onAddSeparatorPagesChange: (value: boolean) => void
  onRunMerge: () => void
}

interface PageManageInspectorProps {
  activeSourceId: string | null
  currentPage: number
  fileName: string
  fileSize: number
  isProcessing: boolean
  pageCount: number
  rangeText: string
  sources: SourceDocument[]
  onAddFiles: () => void
  onDelete: () => void
  onDuplicate: () => void
  onExtract: () => void
  onMoveSource: (id: string, direction: -1 | 1) => void
  onQuickRange: (value: string) => void
  onRangeChange: (value: string) => void
  onRemoveSource: (id: string) => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onSwitchSource: (id: string) => void
  onUndo: () => void
}

function PageManageInspector({
  activeSourceId,
  currentPage,
  fileName,
  fileSize,
  isProcessing,
  pageCount,
  rangeText,
  sources,
  onAddFiles,
  onDelete,
  onDuplicate,
  onExtract,
  onMoveSource,
  onQuickRange,
  onRangeChange,
  onRemoveSource,
  onRotateLeft,
  onRotateRight,
  onSwitchSource,
  onUndo,
}: PageManageInspectorProps) {
  const allRange = pageCount > 0 ? `1-${pageCount}` : '1'
  const oddRange = Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => page % 2 === 1).join(', ')
  const evenRange = Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => page % 2 === 0).join(', ')

  return (
    <div className="inspector-body page-manager">
      <section className="field-group">
        <h2>페이지 범위</h2>
        <label>
          <span className="sr-only">페이지 범위</span>
          <input value={rangeText} onChange={(event) => onRangeChange(event.target.value)} placeholder="예: 1-5, 8, 10-12" />
        </label>
        <p className="hint">예: 1-5, 8, 10-12</p>
      </section>

      <section className="field-group">
        <h2>페이지 작업</h2>
        <div className="action-grid">
          <button type="button" onClick={onRotateLeft} disabled={isProcessing}>
            <RotateCcw aria-hidden="true" />
            {isProcessing ? '처리 중…' : '왼쪽 회전'}
          </button>
          <button type="button" onClick={onRotateRight} disabled={isProcessing}>
            <RotateCw aria-hidden="true" />
            {isProcessing ? '처리 중…' : '오른쪽 회전'}
          </button>
          <button type="button" onClick={onDelete} disabled={isProcessing}>
            <Trash2 aria-hidden="true" />
            {isProcessing ? '처리 중…' : '페이지 삭제'}
          </button>
          <button type="button" onClick={onExtract} disabled={isProcessing}>
            <FilePlus2 aria-hidden="true" />
            {isProcessing ? '처리 중…' : '페이지 추출'}
          </button>
          <button type="button" onClick={onDuplicate} disabled={isProcessing}>
            <Copy aria-hidden="true" />
            {isProcessing ? '처리 중…' : '페이지 복제'}
          </button>
          <button type="button" onClick={onUndo}>
            <Undo2 aria-hidden="true" />
            되돌리기
          </button>
        </div>
      </section>

      <section className="field-group">
        <h2>빠른 선택</h2>
        <div className="quick-grid">
          <button type="button" onClick={() => onQuickRange(allRange)}>모두 선택</button>
          <button type="button" onClick={() => onQuickRange(oddRange || '1')}>홀수 페이지</button>
          <button type="button" onClick={() => onQuickRange(evenRange || '2')}>짝수 페이지</button>
          <button type="button" onClick={() => onQuickRange('1')}>첫 페이지</button>
          <button type="button" onClick={() => onQuickRange(String(pageCount || 1))}>마지막 페이지</button>
        </div>
      </section>

      <section className="field-group doc-info-card">
        <h2>문서 정보</h2>
        <dl className="summary-list">
          <div>
            <dt>파일명</dt>
            <dd>{fileName}</dd>
          </div>
          <div>
            <dt>페이지</dt>
            <dd>{pageCount}</dd>
          </div>
          <div>
            <dt>현재 페이지</dt>
            <dd>{currentPage}</dd>
          </div>
          <div>
            <dt>파일 크기</dt>
            <dd>{(fileSize / 1024 / 1024).toFixed(2)} MB</dd>
          </div>
        </dl>
      </section>

      {sources.length > 0 && (
        <section className="field-group">
          <header>
            <h2>열린 파일</h2>
            <span>{sources.length}개</span>
          </header>
          <div className="source-manage-list">
            {sources.map((source, index) => (
              <div
                key={source.id}
                className={source.id === activeSourceId ? 'source-manage-item active' : 'source-manage-item'}
                onClick={() => onSwitchSource(source.id)}
              >
                <span className="source-manage-index">{index + 1}</span>
                <span className="source-manage-name" title={source.fileName}>{source.fileName}</span>
                <span className="source-manage-pages">{source.pageCount}쪽</span>
                <div className="source-manage-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    aria-label="위로 이동"
                    disabled={index === 0}
                    onClick={() => onMoveSource(source.id, -1)}
                  >▲</button>
                  <button
                    type="button"
                    aria-label="아래로 이동"
                    disabled={index === sources.length - 1}
                    onClick={() => onMoveSource(source.id, 1)}
                  >▼</button>
                  <button
                    type="button"
                    aria-label="파일 닫기"
                    className="source-manage-remove"
                    onClick={() => onRemoveSource(source.id)}
                  >×</button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={onAddFiles}>
            <Plus aria-hidden="true" />
            파일 추가
          </button>
        </section>
      )}
    </div>
  )
}

function MergeInspector({
  addSeparatorPages,
  isProcessing,
  pageCount,
  sources,
  onAddFiles,
  onAddSeparatorPagesChange,
  onRunMerge,
}: MergeInspectorProps) {
  return (
    <div className="inspector-body">
      <section className="field-group">
        <header>
          <h2>병합 요약</h2>
          <span>{sources.length}개 파일</span>
        </header>
        <dl className="summary-list">
          <div>
            <dt>예상 페이지</dt>
            <dd>{pageCount}쪽</dd>
          </div>
          <div>
            <dt>처리 위치</dt>
            <dd>브라우저 내부</dd>
          </div>
          <div>
            <dt>북마크</dt>
            <dd>v1 제외</dd>
          </div>
        </dl>
        <div className="option-list">
          <label>
            <input
              type="checkbox"
              checked={addSeparatorPages}
              onChange={(event) => onAddSeparatorPagesChange(event.target.checked)}
            />
            파일 사이 구분 페이지 추가
          </label>
        </div>
        <button type="button" onClick={onAddFiles}>
          <FilePlus2 aria-hidden="true" />
          PDF 더 추가
        </button>
        <button type="button" className="primary-action" onClick={onRunMerge} disabled={isProcessing}>
          <Merge aria-hidden="true" />
          {isProcessing ? '병합 처리 중…' : '병합 실행'}
        </button>
      </section>
      <section className="field-group">
        <h2>범위 입력 예시</h2>
        <p className="hint">전체는 1-끝쪽, 일부는 1-3, 8, 12처럼 입력합니다. 빈 범위나 범위 초과는 실행 전에 막습니다.</p>
      </section>
    </div>
  )
}

export default App
