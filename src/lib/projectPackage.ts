import JSZip from 'jszip'
import type {
  EditOperation,
  PageOperation,
  ProjectBundle,
  ProjectDocumentSession,
  ProjectManifest,
  SourceDocument,
} from '../types'

interface ProjectJson {
  activeSourceId?: string | null
  documentSessions?: Record<string, ProjectJsonSession>
  manifest: ProjectManifest
  editOperations: EditOperation[]
  editSnapshots?: Record<string, string>
  pageOperations: PageOperation[]
  sourceDocuments: Array<Omit<SourceDocument, 'data'> & { dataPath: string }>
  pdfPath: string
}

interface ProjectJsonSession {
  editOperations: EditOperation[]
  editSnapshots?: Record<string, string>
  pageOperations: PageOperation[]
  currentPage?: number
  extractRange?: string
}

const CURRENT_APP_VERSION = '0.1.0'

export async function exportProjectPackage(bundle: ProjectBundle): Promise<Blob> {
  const zip = new JSZip()
  const editSnapshots: Record<string, string> = {}
  const documentSessions: Record<string, ProjectJsonSession> = {}
  const projectJson: ProjectJson = {
    activeSourceId: bundle.activeSourceId ?? null,
    manifest: bundle.manifest,
    editOperations: bundle.editOperations,
    editSnapshots,
    pageOperations: bundle.pageOperations,
    documentSessions,
    sourceDocuments: bundle.sourceDocuments.map((source, index) => {
      const dataPath = `sources/${index + 1}-${safeName(source.fileName)}`
      zip.file(dataPath, source.data)
      return { ...source, data: undefined as never, dataPath }
    }),
    pdfPath: 'current.pdf',
  }

  for (const [operationId, snapshot] of Object.entries(bundle.editSnapshots ?? {})) {
    const dataPath = `snapshots/${safeName(operationId)}.pdf`
    zip.file(dataPath, snapshot)
    editSnapshots[operationId] = dataPath
  }

  for (const [sourceId, session] of Object.entries(bundle.documentSessions ?? {})) {
    const sessionSnapshots: Record<string, string> = {}
    documentSessions[sourceId] = {
      editOperations: session.editOperations,
      editSnapshots: sessionSnapshots,
      pageOperations: session.pageOperations,
      currentPage: session.currentPage,
      extractRange: session.extractRange,
    }
    for (const [operationId, snapshot] of Object.entries(session.editSnapshots ?? {})) {
      const dataPath = `sessions/${safeName(sourceId)}/snapshots/${safeName(operationId)}.pdf`
      zip.file(dataPath, snapshot)
      sessionSnapshots[operationId] = dataPath
    }
  }

  zip.file(projectJson.pdfPath, bundle.pdfData)
  zip.file('project.json', JSON.stringify(projectJson, null, 2))
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType: 'application/x-pdfproj',
  })
}

export async function importProjectPackage(file: File): Promise<ProjectBundle> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const jsonFile = zip.file('project.json')
  if (!jsonFile) throw new Error('project.json을 찾을 수 없습니다.')

  const projectJson = JSON.parse(await jsonFile.async('string')) as ProjectJson
  if (!projectJson.manifest || !projectJson.pdfPath) {
    throw new Error('프로젝트 정보가 올바르지 않습니다.')
  }

  const pdfFile = zip.file(projectJson.pdfPath)
  if (!pdfFile) throw new Error('현재 PDF 파일을 찾을 수 없습니다.')

  const sourceDocuments: SourceDocument[] = []
  for (const source of projectJson.sourceDocuments ?? []) {
    const sourceFile = zip.file(source.dataPath)
    if (!sourceFile) throw new Error(`${source.fileName} 원본을 찾을 수 없습니다.`)
    const data = await sourceFile.async('arraybuffer')
    sourceDocuments.push({
      ...source,
      rangeText: source.rangeText || `1-${source.pageCount}`,
      rotation: source.rotation ?? 0,
      data,
    })
  }

  const pdfData = await pdfFile.async('arraybuffer')
  const manifest = normalizeManifest(projectJson.manifest)
  const editSnapshots: Record<string, ArrayBuffer> = {}
  for (const [operationId, dataPath] of Object.entries(projectJson.editSnapshots ?? {})) {
    const snapshotFile = zip.file(dataPath)
    if (snapshotFile) editSnapshots[operationId] = await snapshotFile.async('arraybuffer')
  }
  const documentSessions: Record<string, ProjectDocumentSession> = {}
  for (const [sourceId, session] of Object.entries(projectJson.documentSessions ?? {})) {
    const sessionSnapshots: Record<string, ArrayBuffer> = {}
    for (const [operationId, dataPath] of Object.entries(session.editSnapshots ?? {})) {
      const snapshotFile = zip.file(dataPath)
      if (snapshotFile) sessionSnapshots[operationId] = await snapshotFile.async('arraybuffer')
    }
    documentSessions[sourceId] = {
      editOperations: normalizeEditOperations(session.editOperations ?? []),
      editSnapshots: sessionSnapshots,
      pageOperations: session.pageOperations ?? [],
      currentPage: session.currentPage ?? 1,
      extractRange: session.extractRange || `1-${manifest.pageCount}`,
    }
  }
  return {
    manifest,
    pdfData,
    sourceDocuments,
    activeSourceId: projectJson.activeSourceId ?? sourceDocuments[0]?.id ?? null,
    documentSessions,
    editOperations: normalizeEditOperations(projectJson.editOperations ?? []),
    editSnapshots,
    pageOperations: projectJson.pageOperations ?? [],
  }
}

function normalizeManifest(manifest: ProjectManifest): ProjectManifest {
  const now = new Date().toISOString()
  return {
    id: manifest.id || crypto.randomUUID(),
    name: manifest.name || '불러온 PDF 프로젝트',
    createdAt: manifest.createdAt || now,
    updatedAt: manifest.updatedAt || now,
    originalFileName: manifest.originalFileName || `${manifest.name || 'document'}.pdf`,
    pageCount: manifest.pageCount || 1,
    appVersion: manifest.appVersion || CURRENT_APP_VERSION,
  }
}

function normalizeEditOperations(operations: EditOperation[]): EditOperation[] {
  return operations.map((operation) => ({
    ...operation,
    createdAt: operation.createdAt || new Date().toISOString(),
  }))
}

function safeName(fileName: string): string {
  return fileName.replace(/[^\w.-]+/g, '_')
}
