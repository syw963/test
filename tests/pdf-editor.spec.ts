import { expect, test } from '@playwright/test'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { writeFile } from 'node:fs/promises'

async function makePdf(path: string, lines: string[]): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: 48,
      y: 240 - index * 34,
      size: 18,
      font,
      color: rgb(0, 0, 0),
    })
  })
  await writeFile(path, await doc.save())
}

async function makeShapePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 300])
  page.drawRectangle({
    x: 90,
    y: 150,
    width: 120,
    height: 56,
    color: rgb(0.08, 0.45, 0.42),
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
  })
  await writeFile(path, await doc.save())
}

async function makeImagePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 300])
  const png = await doc.embedPng(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGOSHzRgAAAAABJRU5ErkJggg==',
    'base64',
  ))
  page.drawImage(png, {
    x: 90,
    y: 145,
    width: 120,
    height: 70,
  })
  await writeFile(path, await doc.save())
}

async function makePagedPdf(path: string, labels: string[]): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  labels.forEach((label) => {
    const page = doc.addPage([420, 300])
    page.drawText(label, {
      x: 48,
      y: 240,
      size: 22,
      font,
      color: rgb(0, 0, 0),
    })
  })
  await writeFile(path, await doc.save())
}

async function uploadPdf(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.goto('/')
  await page.locator('input[type="file"][accept="application/pdf"]').first().setInputFiles(path)
  await expect(page.getByRole('contentinfo').getByText(/열었습니다/)).toBeVisible()
  await expect(page.getByLabel('1페이지')).toBeVisible()
  await page.getByRole('button', { name: '텍스트 수정' }).click()
}

test('같은 텍스트 후보 중 선택한 항목만 덮어쓰기 수정한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('duplicates.pdf')
  await makePdf(pdfPath, ['First ReplaceMe', 'Second ReplaceMe'])
  await uploadPdf(page, pdfPath)

  await page.getByLabel('원문').fill('ReplaceMe')
  await page.getByLabel('바꿀 문구').fill('수정완료')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByText(/같은 문구가 2개/)).toBeVisible()

  await page.getByRole('button', { name: /2번째/ }).click()
  await page.getByRole('button', { name: '선택 후보 수정' }).click()
  await expect(page.getByRole('contentinfo').getByText(/덮어쓰기 방식으로 수정했습니다|content stream에서 교체했습니다/)).toBeVisible()
})

test('중앙 PDF 화면에서 일반 PDF처럼 텍스트를 드래그 선택한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('selectable.pdf')
  await makePdf(pdfPath, ['Selectable Text'])
  await uploadPdf(page, pdfPath)

  const textLayer = page.locator('.textLayer').first()
  await expect(textLayer.locator('span').filter({ hasText: 'Selectable Text' })).toBeVisible()
  const box = await textLayer.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 58, box.y + 42)
  await page.mouse.down()
  await page.mouse.move(box.x + 230, box.y + 74)
  await page.mouse.up()

  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selectedText).toContain('Selectable Text')
})

test('왼쪽 위 로고를 누르면 홈 화면으로 이동한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('logo-home.pdf')
  await makePdf(pdfPath, ['Logo Home'])
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '홈 화면으로 이동' }).click()
  await expect(page.getByRole('heading', { name: 'PDF 작업을 이어가거나 새로 시작하세요' })).toBeVisible()
  await expect(page.getByRole('contentinfo').getByText(/홈 화면으로 이동했습니다/)).toBeVisible()
})

test('원문 검색 실패 시 수동 영역 덮어쓰기로 진행할 수 있다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('manual.pdf')
  await makePdf(pdfPath, ['Area to cover'])
  await uploadPdf(page, pdfPath)

  await page.getByLabel('바꿀 문구').fill('수동수정')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByText(/덮어쓸 영역을 드래그|영역을 직접 지정/)).toBeVisible()

  const overlay = page.locator('.page-overlay').first()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 58, box.y + 42)
  await page.mouse.down()
  await page.mouse.move(box.x + 180, box.y + 74)
  await page.mouse.up()
  await expect(page.getByText(/수동 영역이 있습니다/)).toBeVisible()

  await page.getByRole('button', { name: '수동 영역 덮어쓰기' }).click()
  await expect(page.getByRole('contentinfo').getByText(/수동 지정 영역을 덮어쓰기 방식으로 수정했습니다/)).toBeVisible()
})

test('수정 후 범위 추출과 프로젝트 내보내기가 앱을 멈추지 않는다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('exportable.pdf')
  await makePdf(pdfPath, ['Export ReplaceMe', 'Second page marker'])
  await uploadPdf(page, pdfPath)

  await page.getByLabel('원문').fill('ReplaceMe')
  await page.getByLabel('바꿀 문구').fill('Updated')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByRole('contentinfo').getByText(/수정했습니다|교체했습니다/)).toBeVisible()

  await page.getByLabel('범위').fill('1')
  const extract = page.waitForEvent('download')
  await page.getByRole('button', { name: '범위 추출' }).click()
  await extract
  await expect(page.getByText(/페이지를 새 PDF로 추출했습니다/)).toBeVisible()

  const project = page.waitForEvent('download')
  await page.getByRole('button', { name: '저장' }).click()
  await project
  await expect(page.getByText(/프로젝트 파일을 내보냈습니다/)).toBeVisible()
})

test('흰색 박스 없이 검색된 텍스트를 실제 삭제한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('delete.pdf')
  await makePdf(pdfPath, ['Keep DeleteMe'])
  await uploadPdf(page, pdfPath)

  await page.getByLabel('원문').fill('DeleteMe')
  await page.getByRole('button', { name: '원문 실제 삭제' }).click()
  await expect(page.getByRole('contentinfo').getByText(/content stream에서 실제 삭제했습니다/)).toBeVisible()
})

test('PDF 위에서 드래그로 선택한 텍스트를 삭제한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('drag-delete.pdf')
  await makePdf(pdfPath, ['Drag DeleteMe'])
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '글자 드래그 선택' }).click()
  const overlay = page.locator('.page-overlay').first()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 55, box.y + 42)
  await page.mouse.down()
  await page.mouse.move(box.x + 210, box.y + 80)
  await page.mouse.up()

  await expect(page.getByRole('contentinfo').getByText(/드래그로 선택한 텍스트를 인식했습니다/)).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('contentinfo').getByText(/드래그로 선택한 텍스트를 PDF 내부 redaction으로 실제 삭제했습니다/)).toBeVisible()
})

test('PDF 위에서 드래그로 선택한 도형 영역을 삭제한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('shape-delete.pdf')
  await makeShapePdf(pdfPath)
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '도형/이미지 영역 선택' }).click()
  const overlay = page.locator('.page-overlay').first()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 84, box.y + 92)
  await page.mouse.down()
  await page.mouse.move(box.x + 218, box.y + 156)
  await page.mouse.up()

  await expect(page.getByText(/수동 영역이 있습니다/)).toBeVisible()
  await page.getByRole('button', { name: '선택 요소 삭제' }).click()
  await expect(page.getByRole('contentinfo').getByText(/도형\/이미지\/요소 영역을 PDF 내부 redaction으로 삭제했습니다/)).toBeVisible()
  await expect(page.locator('.history-item').filter({ hasText: '도형/이미지/요소 영역' })).toContainText('삭제')
})

test('PDF 위에서 드래그로 선택한 이미지 영역을 삭제한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('image-delete.pdf')
  await makeImagePdf(pdfPath)
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '도형/이미지 영역 선택' }).click()
  const overlay = page.locator('.page-overlay').first()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 84, box.y + 84)
  await page.mouse.down()
  await page.mouse.move(box.x + 218, box.y + 164)
  await page.mouse.up()

  await expect(page.getByText(/수동 영역이 있습니다/)).toBeVisible()
  await page.getByRole('button', { name: '선택 요소 삭제' }).click()
  await expect(page.getByRole('contentinfo').getByText(/도형\/이미지\/요소 영역을 PDF 내부 redaction으로 삭제했습니다/)).toBeVisible()
})

test('일반 텍스트 선택 후 Delete 키로 선택 텍스트를 삭제한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('native-select-delete.pdf')
  await makePdf(pdfPath, ['Native DeleteMe'])
  await uploadPdf(page, pdfPath)
  await page.getByPlaceholder('검색').fill('Native')

  const textSpan = page.locator('.textLayer span').filter({ hasText: 'Native DeleteMe' })
  await expect(textSpan).toBeVisible()
  const box = await textSpan.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Native Delete')

  await page.keyboard.press('Delete')
  await expect(page.getByRole('contentinfo').getByText(/PDF 내부 redaction으로 실제 삭제했습니다/)).toBeVisible()
  await expect(page.getByRole('heading', { name: '작업 이력' })).toBeVisible()
  await expect(page.locator('.history-item').filter({ hasText: 'Native DeleteMe' })).toContainText('삭제')
  await expect(page.getByRole('button', { name: '뒤로가기' })).toBeEnabled()
})

test('작업 이력에서 적용 전 상태로 되돌린다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('undo.pdf')
  await makePdf(pdfPath, ['Undo ReplaceMe'])
  await uploadPdf(page, pdfPath)

  await page.getByLabel('원문').fill('ReplaceMe')
  await page.getByLabel('바꿀 문구').fill('Updated')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByRole('contentinfo').getByText(/수정했습니다|교체했습니다/)).toBeVisible()

  await page.getByRole('button', { name: '이 시점으로 되돌리기' }).click()
  await expect(page.getByRole('contentinfo').getByText(/1개 본문 작업을 되돌렸습니다/)).toBeVisible()
  await expect(page.getByText('아직 본문 수정 이력이 없습니다.')).toBeVisible()
})

test('상단 뒤로가기로 마지막 PDF 변경 전 상태를 복원한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('toolbar-undo.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two'])
  await uploadPdf(page, pdfPath)

  await expect(page.getByRole('button', { name: '뒤로가기' })).toBeDisabled()
  await page.locator('.page-thumb').nth(1).dragTo(page.locator('.page-thumb').nth(0))
  await expect(page.getByRole('contentinfo').getByText(/2쪽을 1쪽 위치로 이동했습니다/)).toBeVisible()
  await expect(page.getByRole('button', { name: '뒤로가기' })).toBeEnabled()

  await page.getByRole('button', { name: '뒤로가기' }).click()
  await expect(page.getByRole('contentinfo').getByText(/페이지 순서 변경 전 상태로 되돌렸습니다/)).toBeVisible()
  await page.getByPlaceholder('검색').fill('Page One')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
})

test('커맨드/컨트롤 Z로 마지막 PDF 변경 전 상태를 복원한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('shortcut-undo.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two'])
  await uploadPdf(page, pdfPath)

  await page.locator('.page-thumb').nth(1).dragTo(page.locator('.page-thumb').nth(0))
  await expect(page.getByRole('contentinfo').getByText(/2쪽을 1쪽 위치로 이동했습니다/)).toBeVisible()

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
  await expect(page.getByRole('contentinfo').getByText(/페이지 순서 변경 전 상태로 되돌렸습니다/)).toBeVisible()
  await page.getByPlaceholder('검색').fill('Page One')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
})

test('왼쪽 미리보기와 중앙 스크롤로 페이지를 이동한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('paged.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two', 'Page Three'])
  await uploadPdf(page, pdfPath)

  await expect(page.locator('.page-thumb canvas')).toHaveCount(3)
  await page.getByRole('button', { name: /3/ }).click()
  await expect(page.getByRole('contentinfo').getByText(/페이지 3 \/ 3|3 \/ 3/)).toBeVisible()

  await page.locator('.document-stage').hover()
  await page.mouse.wheel(0, -900)
  await expect(page.getByRole('contentinfo').getByText(/1 \/ 3|2 \/ 3/)).toBeVisible()
})

test('페이지 번호 입력으로 이동하고 PDF가 없을 때 실행 불가 버튼을 비활성화한다', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '저장' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '내보내기' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '축소' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '확대' })).toBeDisabled()
  await expect(page.getByPlaceholder('문서 내 검색')).toBeDisabled()

  const pdfPath = testInfo.outputPath('jump.pdf')
  await makePagedPdf(pdfPath, ['Jump One', 'Jump Two', 'Jump Three'])
  await uploadPdf(page, pdfPath)

  await expect(page.getByRole('button', { name: '저장' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '내보내기' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '축소' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '확대' })).toBeEnabled()
  await expect(page.getByPlaceholder('문서 내 검색')).toBeEnabled()

  await page.getByLabel('이동할 페이지').fill('3')
  await page.getByRole('button', { name: '이동', exact: true }).click()
  await expect(page.getByRole('contentinfo').getByText(/페이지 3 \/ 3/)).toBeVisible()
  await expect(page.getByRole('contentinfo').getByText(/3쪽으로 이동했습니다/)).toBeVisible()
})

test('이미지형 페이지 관리 패널에서 페이지 복제와 삭제를 실행한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('page-tools.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two', 'Page Three'])
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '페이지 관리' }).click()
  await page.getByLabel('페이지 범위').fill('2')
  await page.getByRole('button', { name: '페이지 복제' }).click()
  await expect(page.getByRole('contentinfo').getByText(/2 페이지를 복제했습니다/)).toBeVisible()
  await expect(page.getByRole('contentinfo').getByText(/페이지 1 \/ 4/)).toBeVisible()

  await page.getByLabel('페이지 범위').fill('4')
  await page.getByRole('button', { name: '페이지 삭제' }).click()
  await expect(page.getByRole('contentinfo').getByText(/4 페이지를 삭제했습니다/)).toBeVisible()
  await expect(page.getByRole('contentinfo').getByText(/페이지 1 \/ 3/)).toBeVisible()
})

test('왼쪽 세 줄 버튼으로 페이지 목록만 전체 화면으로 본다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('fullscreen-pages.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two', 'Page Three'])
  await uploadPdf(page, pdfPath)

  await page.getByRole('button', { name: '페이지 목록 전체화면' }).click()
  await expect(page.locator('.workspace.page-list-fullscreen')).toBeVisible()
  await expect(page.locator('.document-stage')).toBeHidden()
  await expect(page.locator('.page-thumb canvas')).toHaveCount(3)

  await page.getByRole('button', { name: '격자 보기' }).click()
  await expect(page.locator('.workspace.page-list-fullscreen')).toHaveCount(0)
})

test('메인 문서와 오른쪽 패널 비율을 드래그로 조절한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('resize-panels.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two'])
  await uploadPdf(page, pdfPath)

  const inspector = page.locator('.inspector')
  const resizer = page.locator('.inspector-resizer')
  const before = await inspector.boundingBox()
  const handle = await resizer.boundingBox()
  expect(before).not.toBeNull()
  expect(handle).not.toBeNull()
  if (!before || !handle) return

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - 120, handle.y + handle.height / 2)
  await page.mouse.up()

  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(before.width + 60)
})

test('문서 영역에서 트랙패드 핀치 방식으로 확대 축소한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('trackpad-zoom.pdf')
  await makePdf(pdfPath, ['Zoomable Text'])
  await uploadPdf(page, pdfPath)

  const browserScaleBefore = await page.evaluate(() => window.devicePixelRatio)
  await page.locator('.document-stage').hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -360)
  await page.keyboard.up('Control')

  await expect.poll(async () => {
    const value = await page.locator('.zoom-readout').innerText()
    return Number.parseInt(value, 10)
  }).toBeGreaterThan(100)
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(browserScaleBefore)
})

test('열려 있는 여러 PDF를 탭으로 전환해 작업 대상을 바꾼다', async ({ page }, testInfo) => {
  const firstPdf = testInfo.outputPath('tab-first.pdf')
  const secondPdf = testInfo.outputPath('tab-second.pdf')
  await makePdf(firstPdf, ['First Document Marker'])
  await makePdf(secondPdf, ['Second Document Marker'])

  await page.goto('/')
  await page.locator('input[type="file"][accept="application/pdf"]').first().setInputFiles([firstPdf, secondPdf])
  await expect(page.getByRole('contentinfo').getByText(/2개 PDF를 탭으로 열었습니다/)).toBeVisible()
  await expect(page.getByRole('tab', { name: /tab-first\.pdf/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /tab-second\.pdf/ })).toBeVisible()

  await page.getByRole('tab', { name: /tab-second\.pdf/ }).click()
  await expect(page.getByRole('contentinfo').getByText(/tab-second\.pdf 탭으로 이동했습니다/)).toBeVisible()
  await page.getByPlaceholder('검색').fill('Second Document')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
})

test('탭을 왕복해도 현재 PDF 수정본과 작업 상태를 유지한다', async ({ page }, testInfo) => {
  const firstPdf = testInfo.outputPath('tab-edit-first.pdf')
  const secondPdf = testInfo.outputPath('tab-edit-second.pdf')
  await makePdf(firstPdf, ['First ReplaceMe'])
  await makePdf(secondPdf, ['Second Document Marker'])

  await page.goto('/')
  await page.locator('input[type="file"][accept="application/pdf"]').first().setInputFiles([firstPdf, secondPdf])
  await expect(page.getByRole('contentinfo').getByText(/2개 PDF를 탭으로 열었습니다/)).toBeVisible()

  await page.getByRole('button', { name: '텍스트 수정' }).click()
  await page.getByLabel('원문').fill('ReplaceMe')
  await page.getByLabel('바꿀 문구').fill('Updated')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByRole('contentinfo').getByText(/수정했습니다|교체했습니다/)).toBeVisible()

  await page.getByRole('tab', { name: /tab-edit-second\.pdf/ }).click()
  await expect(page.getByRole('contentinfo').getByText(/tab-edit-second\.pdf 탭으로 이동했습니다/)).toBeVisible()
  await page.getByPlaceholder('검색').fill('Second Document')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()

  await page.getByRole('tab', { name: /tab-edit-first\.pdf/ }).click()
  await expect(page.getByRole('contentinfo').getByText(/tab-edit-first\.pdf 탭으로 이동했습니다/)).toBeVisible()
  await page.getByPlaceholder('검색').fill('Updated')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
  await expect(page.getByLabel('원문')).toHaveValue('')
})

test('.pdfproj 불러오기 후 저장 당시 활성 탭과 수정본을 복원한다', async ({ page }, testInfo) => {
  const firstPdf = testInfo.outputPath('project-first.pdf')
  const secondPdf = testInfo.outputPath('project-second.pdf')
  const projectPath = testInfo.outputPath('roundtrip.pdfproj')
  await makePdf(firstPdf, ['First Document Marker'])
  await makePdf(secondPdf, ['Second ReplaceMe'])

  await page.goto('/')
  await page.locator('input[type="file"][accept="application/pdf"]').first().setInputFiles([firstPdf, secondPdf])
  await expect(page.getByRole('contentinfo').getByText(/2개 PDF를 탭으로 열었습니다/)).toBeVisible()
  await page.getByRole('tab', { name: /project-second\.pdf/ }).click()
  await expect(page.getByRole('contentinfo').getByText(/project-second\.pdf 탭으로 이동했습니다/)).toBeVisible()

  await page.getByRole('button', { name: '텍스트 수정' }).click()
  await page.getByLabel('원문').fill('ReplaceMe')
  await page.getByLabel('바꿀 문구').fill('UpdatedSecond')
  await page.getByRole('button', { name: '현재 페이지에서 수정 시도' }).click()
  await expect(page.getByRole('contentinfo').getByText(/수정했습니다|교체했습니다/)).toBeVisible()

  const project = page.waitForEvent('download')
  await page.getByRole('button', { name: '저장' }).click()
  await (await project).saveAs(projectPath)

  await page.reload()
  await page.locator('input[accept=".pdfproj,application/x-pdfproj"]').setInputFiles(projectPath)
  await expect(page.getByRole('contentinfo').getByText(/프로젝트를 불러왔습니다/)).toBeVisible()
  await expect(page.getByRole('tab', { name: /project-second\.pdf/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByPlaceholder('검색').fill('UpdatedSecond')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()

  await page.getByRole('tab', { name: /project-first\.pdf/ }).click()
  await page.getByPlaceholder('검색').fill('First Document')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
})

test('왼쪽 페이지 목록에서 드래그로 순서를 바꾸고 검색 결과로 이동한다', async ({ page }, testInfo) => {
  const pdfPath = testInfo.outputPath('reorder-search.pdf')
  await makePagedPdf(pdfPath, ['Page One', 'Page Two', 'Page Three'])
  await uploadPdf(page, pdfPath)

  await page.locator('.page-thumb').nth(2).dragTo(page.locator('.page-thumb').nth(0))
  await expect(page.getByRole('contentinfo').getByText(/3쪽을 1쪽 위치로 이동했습니다/)).toBeVisible()

  await page.getByPlaceholder('검색').fill('Page Three')
  await expect(page.locator('.search-result').filter({ hasText: '1쪽' })).toBeVisible()
  await page.locator('.search-result').filter({ hasText: '1쪽' }).click()
  await expect(page.getByRole('contentinfo').getByText(/1 \/ 3/)).toBeVisible()
})
