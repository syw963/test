export function parsePageRange(input: string, pageCount: number): number[] {
  const normalized = input.trim()
  if (!normalized || normalized === '*') {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages = new Set<number>()
  for (const chunk of normalized.split(',')) {
    const part = chunk.trim()
    if (!part) continue

    const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end > pageCount || start > end) {
        throw new Error(`페이지 범위가 올바르지 않습니다: ${part}`)
      }
      for (let page = start; page <= end; page += 1) pages.add(page)
      continue
    }

    const page = Number(part)
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`페이지 번호가 올바르지 않습니다: ${part}`)
    }
    pages.add(page)
  }

  if (pages.size === 0) {
    throw new Error('선택된 페이지가 없습니다.')
  }

  return Array.from(pages).sort((a, b) => a - b)
}

// Like parsePageRange but preserves the order the user typed, keeps duplicates, and
// allows descending ranges (e.g. "5-1"). Use this for split/merge where page order
// matters; parsePageRange stays the set-based parser for delete/rotate/reorder.
export function parsePageSequence(input: string, pageCount: number): number[] {
  const normalized = input.trim()
  if (!normalized || normalized === '*') {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages: number[] = []
  for (const chunk of normalized.split(',')) {
    const part = chunk.trim()
    if (!part) continue

    const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
        throw new Error(`페이지 범위가 올바르지 않습니다: ${part}`)
      }
      const step = start <= end ? 1 : -1
      for (let page = start; page !== end + step; page += step) pages.push(page)
      continue
    }

    const page = Number(part)
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`페이지 번호가 올바르지 않습니다: ${part}`)
    }
    pages.push(page)
  }

  if (pages.length === 0) {
    throw new Error('선택된 페이지가 없습니다.')
  }

  return pages
}

export function describePages(pages: number[]): string {
  if (pages.length === 0) return '0쪽'
  const sorted = [...pages].sort((a, b) => a - b)
  const ranges: string[] = []
  let start = sorted[0]
  let previous = sorted[0]

  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index]
    if (current === previous + 1) {
      previous = current
      continue
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`)
    start = current
    previous = current
  }

  return ranges.join(', ')
}

export function estimateRecipePageCount(
  sources: Array<{ rangeText: string; pageCount: number }>,
): number {
  return sources.reduce((total, source) => {
    try {
      return total + parsePageSequence(source.rangeText, source.pageCount).length
    } catch {
      return total
    }
  }, 0)
}
