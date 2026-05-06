import { openDB } from 'idb'
import type { ProjectBundle, RecentProject } from '../types'

const DB_NAME = 'local-pdf-editor'
const DB_VERSION = 1

async function database() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('projects', { keyPath: 'manifest.id' })
      db.createObjectStore('recent', { keyPath: 'id' })
    },
  })
}

export async function saveProject(bundle: ProjectBundle): Promise<void> {
  const db = await database()
  await db.put('projects', bundle)
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
  return db.get('projects', id)
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const db = await database()
  const recent = await db.getAll('recent')
  return recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function removeProject(id: string): Promise<void> {
  const db = await database()
  await db.delete('projects', id)
  await db.delete('recent', id)
}
