export type ToolMode = 'editor' | 'merge'

export type EditStatus = 'pending' | 'applied' | 'unsupported' | 'failed'

export type TextOccurrenceSource = 'mupdf' | 'pdfjs' | 'manual'

export type EditMethod = 'direct' | 'direct-delete' | 'redaction-delete' | 'overlay-auto' | 'overlay-manual'

export interface ProjectManifest {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  originalFileName: string
  pageCount: number
  appVersion: string
}

export interface EditOperation {
  id: string
  pageNumber: number
  originalText: string
  replacementText: string
  status: EditStatus
  reason?: string
  occurrenceIndex?: number
  method?: EditMethod
  occurrenceId?: string
  appliedRect?: TextOccurrenceRect
  createdAt?: string
  verified?: boolean
}

export interface TextOccurrenceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayTextStyle {
  backgroundColor: string
  fontSize?: number
  textColor: string
}

export interface TextOccurrence {
  index: number
  pageNumber: number
  id: string
  source: TextOccurrenceSource
  snippet: string
  confidence: number
  rect: TextOccurrenceRect
  rects: TextOccurrenceRect[]
}

export interface PageOperation {
  id: string
  type: 'delete' | 'rotate' | 'extract' | 'merge' | 'reorder' | 'duplicate'
  sourceId: string
  pages: number[]
  rotation?: 0 | 90 | 180 | 270
  createdAt: string
}

export interface SourceDocument {
  id: string
  fileName: string
  pageCount: number
  size: number
  data: ArrayBuffer
  rangeText: string
  rotation: 0 | 90 | 180 | 270
}

export interface MergeRecipe {
  title: string
  author: string
  sources: SourceDocument[]
  addSeparatorPages?: boolean
}

export interface ProjectBundle {
  manifest: ProjectManifest
  pdfData: ArrayBuffer
  sourceDocuments: SourceDocument[]
  activeSourceId?: string | null
  documentSessions?: Record<string, ProjectDocumentSession>
  editOperations: EditOperation[]
  editSnapshots: Record<string, ArrayBuffer>
  pageOperations: PageOperation[]
}

export interface ProjectDocumentSession {
  editOperations: EditOperation[]
  editSnapshots: Record<string, ArrayBuffer>
  pageOperations: PageOperation[]
  currentPage: number
  extractRange: string
}

export interface RecentProject {
  id: string
  name: string
  updatedAt: string
  pageCount: number
  fileName: string
}
