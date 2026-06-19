import { openDB } from 'idb'
import type { ProjectBundle, ProjectDocumentSession, RecentProject, SourceDocument } from '../types'

const DB_NAME = 'local-pdf-editor'
const DB_VERSION = 2

type SourceDocumentMeta = Omit<SourceDocument, 'data'>

interface StoredProject {
  id: string
  activeSourceId?: string | null
  manifest: ProjectBundle['manifest']
  sourceDocuments: SourceDocumentMeta[]
  editOperations: ProjectBundle['editOperations']
  editSnapshotIds: string[]
  pageOperations: ProjectBundle['pageOperations']
  documentSessions?: Record<string, Omit<ProjectDocumentSession, 'editSnapshots'> & { editSnapshotIds: string[] }>
}

interface ProjectBinary {
  key: string
  projectId: string
  data: ArrayBuffer
}

const binaryRefCache = new Map<string, ArrayBuffer>()
const binaryHashCache = new Map<string, string>()

async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    const bytes = new Uint8Array(data)
    let hash = 2166136261
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index]
      hash = Math.imul(hash, 16777619)
    }
    return `${data.byteLength}:${hash >>> 0}`
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function database() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'manifest.id' })
      if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('binaries')) {
        const binaries = db.createObjectStore('binaries', { keyPath: 'key' })
        binaries.createIndex('projectId', 'projectId')
      }
    },
  })
}

export async function saveProject(bundle: ProjectBundle): Promise<void> {
  const db = await database()
  const projectId = bundle.manifest.id
  const expectedBinaryKeys = new Set<string>()
  const putBinary = async (key: string, data: ArrayBuffer): Promise<void> => {
    expectedBinaryKeys.add(key)
    if (binaryRefCache.get(key) === data) return
    const dataHash = await hashArrayBuffer(data)
    if (binaryHashCache.get(key) === dataHash) {
      binaryRefCache.set(key, data)
      return
    }
    await db.put('binaries', { key, projectId, data } satisfies ProjectBinary)
    binaryRefCache.set(key, data)
    binaryHashCache.set(key, dataHash)
  }

  await putBinary(binaryKey(projectId, 'current'), bundle.pdfData)
  await Promise.all(bundle.sourceDocuments.map((source) => (
    putBinary(binaryKey(projectId, `source-${source.id}`), source.data)
  )))
  await Promise.all(Object.entries(bundle.editSnapshots).map(([operationId, snapshot]) => (
    putBinary(binaryKey(projectId, `snapshot-${operationId}`), snapshot)
  )))

  const sessionBinaryWrites: Array<Promise<void>> = []
  const documentSessions = Object.fromEntries(
    Object.entries(bundle.documentSessions ?? {}).map(([sourceId, session]) => {
      for (const [operationId, snapshot] of Object.entries(session.editSnapshots)) {
        sessionBinaryWrites.push(putBinary(binaryKey(projectId, `session-${sourceId}-snapshot-${operationId}`), snapshot))
      }
      return [
        sourceId,
        {
          editOperations: session.editOperations,
          editSnapshotIds: Object.keys(session.editSnapshots),
          pageOperations: session.pageOperations,
          currentPage: session.currentPage,
          extractRange: session.extractRange,
        },
      ]
    }),
  )
  await Promise.all(sessionBinaryWrites)

  const stored: StoredProject = {
    id: projectId,
    activeSourceId: bundle.activeSourceId ?? null,
    manifest: bundle.manifest,
    sourceDocuments: bundle.sourceDocuments.map((source) => ({
      id: source.id,
      fileName: source.fileName,
      pageCount: source.pageCount,
      size: source.size,
      rangeText: source.rangeText,
      rotation: source.rotation,
    })),
    editOperations: bundle.editOperations,
    editSnapshotIds: Object.keys(bundle.editSnapshots),
    pageOperations: bundle.pageOperations,
    documentSessions,
  }
  await db.put('projects', stored)
  const existingBinaryKeys = await db.getAllKeysFromIndex('binaries', 'projectId', projectId)
  await Promise.all(
    existingBinaryKeys.flatMap((key) => {
      if (typeof key !== 'string' || expectedBinaryKeys.has(key)) return []
      binaryRefCache.delete(key)
      binaryHashCache.delete(key)
      return [db.delete('binaries', key)]
    }),
  )
  await db.put('recent', {
    id: bundle.manifest.id,
    name: bundle.manifest.name,
    updatedAt: bundle.manifest.updatedAt,
    pageCount: bundle.manifest.pageCount,
    fileName: bundle.manifest.originalFileName,
  } satisfies RecentProject)
}

export async function loadProject(id: string): Promise<ProjectBundle | undefined> {
  const db = await database()
  const stored = await db.get('projects', id)
  if (!stored) return undefined
  if ('pdfData' in stored) return stored as ProjectBundle

  // Bound cache memory to the project being opened so prior projects' whole-PDF
  // ArrayBuffers are released instead of pinned for the page lifetime.
  binaryRefCache.clear()
  binaryHashCache.clear()

  const project = stored as StoredProject
  const readBinary = async (name: string): Promise<ArrayBuffer | undefined> => {
    const key = binaryKey(id, name)
    const binary = await db.get('binaries', key) as ProjectBinary | undefined
    if (!binary) return undefined
    binaryRefCache.set(key, binary.data)
    binaryHashCache.set(key, await hashArrayBuffer(binary.data))
    return binary.data
  }

  const current = await readBinary('current')
  if (!current) return undefined

  const sourceResults = await Promise.all(
    project.sourceDocuments.map(async (source) => {
      const data = await readBinary(`source-${source.id}`)
      return data ? { ...source, data } : null
    }),
  )
  const sourceDocuments: SourceDocument[] = sourceResults.filter(
    (source): source is SourceDocument => source !== null,
  )

  const editSnapshots: Record<string, ArrayBuffer> = {}
  await Promise.all(project.editSnapshotIds.map(async (operationId) => {
    const data = await readBinary(`snapshot-${operationId}`)
    if (data) editSnapshots[operationId] = data
  }))

  const documentSessions: Record<string, ProjectDocumentSession> = {}
  await Promise.all(Object.entries(project.documentSessions ?? {}).map(async ([sourceId, session]) => {
    const sessionSnapshots: Record<string, ArrayBuffer> = {}
    await Promise.all(session.editSnapshotIds.map(async (operationId) => {
      const data = await readBinary(`session-${sourceId}-snapshot-${operationId}`)
      if (data) sessionSnapshots[operationId] = data
    }))
    documentSessions[sourceId] = {
      editOperations: session.editOperations,
      editSnapshots: sessionSnapshots,
      pageOperations: session.pageOperations,
      currentPage: session.currentPage,
      extractRange: session.extractRange,
    }
  }))

  return {
    manifest: project.manifest,
    pdfData: current,
    sourceDocuments,
    activeSourceId: project.activeSourceId,
    documentSessions,
    editOperations: project.editOperations,
    editSnapshots,
    pageOperations: project.pageOperations,
  }
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const db = await database()
  const recent = await db.getAll('recent')
  return recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function removeProject(id: string): Promise<void> {
  const db = await database()
  const tx = db.transaction(['projects', 'recent', 'binaries'], 'readwrite')
  const binaryKeys = await tx.objectStore('binaries').index('projectId').getAllKeys(id)
  await Promise.all(binaryKeys.map((key) => {
    if (typeof key === 'string') {
      binaryRefCache.delete(key)
      binaryHashCache.delete(key)
    }
    return tx.objectStore('binaries').delete(key)
  }))
  await tx.objectStore('projects').delete(id)
  await tx.objectStore('recent').delete(id)
  await tx.done
}

function binaryKey(projectId: string, name: string): string {
  return `${projectId}:${name}`
}
