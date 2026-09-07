// Disposable browser session and VOXEL_DATA_DIR only. Start with:
// VOXEL_DATA_DIR=/tmp/voxel-library-test bun run dev --config tests/vite.config.ts
// Open the app, then run:
// import('/tests/model-library.ts').then(m => m.runLibraryChecks())
// Poll window.libraryChecks; this exercises the real editor and API, not a UI mock.
import { bytesToBase64 } from '../src/shared/voxel/snapshot'
import { loadProject } from '../src/editors/model/storage'
import type { ModelSummary } from '../src/shared/library/types'

export async function runLibraryChecks() {
  const report = { running: true, passed: [] as string[], error: '' }
  Object.assign(window, { libraryChecks: report })
  const originalConfirm = window.confirm
  const originalFetch = window.fetch
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const node = document.querySelector<T>(selector)
    if (!node) throw new Error(`Missing ${selector}`)
    return node
  }
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${document.querySelector<HTMLElement>('.model-library[open]')?.innerText}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const input = (selector: string, value: string) => {
    const node = element<HTMLInputElement>(selector)
    node.value = value
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const allModels = async (): Promise<ModelSummary[]> => (await (await originalFetch('/api/models')).json()).models
  const close = () => document.querySelectorAll<HTMLDialogElement>('.model-library').forEach(dialog => dialog.close())
  const open = (save = true) => element(`[data-action="${save ? 'save-model' : 'browse-models'}"]`).click()
  const save = async (copy = false) => {
    element<HTMLFormElement>('.model-library form').requestSubmit(element<HTMLButtonElement>(copy ? '.model-library [name="copy"]' : '.model-library .primary'))
    await until(() => !element<HTMLFieldSetElement>('.model-library fieldset').disabled)
  }
  const name = `Library QA ${Date.now()}`
  try {
    window.confirm = () => true
    close()
    element('[data-action="new"]').click()
    open()
    input('.model-save-dialog [name="name"]', '   ')
    await save()
    check(!element<HTMLInputElement>('.model-save-dialog [name="name"]').validity.valid, 'Reject whitespace-only names')
    close()
    open()
    check(element<HTMLInputElement>('.model-save-dialog [name="name"]').validity.valid, 'Reopened form clears stale validation errors')
    await save()
    check(element('.model-save-dialog .library-message').textContent!.startsWith('Saved "'), 'Reopened form saves without editing the restored name')
    report.passed.push('Reopening the save dialog clears validation errors')
    close()
    element('[data-action="new"]').click()
    open()
    check(element<HTMLDialogElement>('.model-save-dialog').open && !element<HTMLDialogElement>('.model-browser').open, 'Saving opens only its own dialog')
    check(!document.querySelector('.model-save-dialog .library-results'), 'Save dialog must not contain browsing')
    input('.model-library [name="name"]', name)
    input('.model-library [name="tags"]', 'Architecture, timber, ARCHITECTURE')
    await save()
    let saved = (await allModels()).find(model => model.name === name)!
    check(saved?.version === 1 && saved.tags.join(',') === 'architecture,timber', 'Create and normalized tags')
    await until(async () => (await loadProject())?.library?.id === saved.id)
    report.passed.push('Create model and persist matching local server identity')

    input('.model-library [name="tags"]', 'interior, wood')
    await save()
    saved = (await allModels()).find(model => model.id === saved.id)!
    check(saved.version === 2 && saved.tags.join(',') === 'interior,wood', 'Update tags on the same model')
    input('.model-library [name="name"]', `${name} copy`)
    await save(true)
    const copy = (await allModels()).find(model => model.name === `${name} copy`)!
    check(copy && copy.id !== saved.id && copy.version === 1, 'Save a distinct copy')
    report.passed.push('Update tags and save a separate copy')

    close()
    open(false)
    check(element<HTMLDialogElement>('.model-browser').open && !element<HTMLDialogElement>('.model-save-dialog').open, 'Browsing opens only its own gallery')
    check(!document.querySelector('.model-browser form'), 'Gallery must not contain a save form')
    input('.model-library [type="search"]', 'definitely-no-library-match')
    await until(() => element('.library-count').textContent!.includes('No matching'))
    check(!document.querySelector('.library-results li'), 'Empty filtered list')
    input('.model-library [type="search"]', name.toUpperCase())
    await until(() => document.querySelectorAll('.library-results li').length === 2)
    element<HTMLSelectElement>('.library-filters select').value = 'wood'
    element('.library-filters select').dispatchEvent(new Event('change'))
    await until(() => !element('.library-results').hasAttribute('aria-busy'))
    check(document.querySelectorAll('.library-results li').length === 2, 'Name search combined with tag filter')
    report.passed.push('Case-insensitive search, tag filtering, and no-results state')

    const remote = await (await originalFetch(`/api/models/${saved.id}`)).json()
    const chunk = new Uint8Array(4096)
    chunk[0] = 5
    remote.snapshot.chunks = [{ id: 0, layerId: remote.snapshot.activeLayerId, dataBase64: bytesToBase64(chunk) }]
    const update = await originalFetch(`/api/models/${saved.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(remote) })
    check(update.ok, 'Prepare voxel fixture')
    const updated = await update.json()
    element('.library-refresh').click()
    await until(() => Boolean(document.querySelector(`[data-open="${saved.id}"] img`)))
    const thumbnail = element<HTMLImageElement>(`[data-open="${saved.id}"] img`)
    thumbnail.scrollIntoView()
    await until(() => thumbnail.complete && thumbnail.naturalWidth === 256)
    check(thumbnail.src.endsWith(`/thumbnail.png?v=${updated.version}`), 'Thumbnail URL follows model version')
    const image = document.createElement('canvas')
    image.width = image.height = 256
    const context = image.getContext('2d')!
    context.drawImage(thumbnail, 0, 0)
    const pixels = context.getImageData(0, 0, 256, 256).data
    check(pixels.some((value, index) => index % 4 === 3 && value > 0), 'Preview must contain actual rendered geometry')
    check(pixels[3] === 0, 'Preview has transparent padding')
    const editorName = element<HTMLInputElement>('#project-name').value
    thumbnail.dispatchEvent(new Event('error'))
    check(element(`[data-open="${saved.id}"] .library-preview-state`).textContent === 'Preview unavailable', 'Failed image has a useful fallback')
    check(element<HTMLInputElement>('#project-name').value === editorName, 'Loading a thumbnail must not load the model')
    report.passed.push('Independent gallery with versioned isometric previews and safe image fallback')
    window.confirm = () => false
    element(`[data-open="${saved.id}"]`).click()
    check(element<HTMLInputElement>('#project-name').value === `${name} copy`, 'Canceled open must preserve current canvas')
    window.confirm = () => true
    element(`[data-open="${saved.id}"]`).click()
    await until(() => !element<HTMLDialogElement>('.model-library').open)
    await until(async () => {
      const restored = await loadProject()
      return restored?.library?.id === saved.id && restored.document.voxelCount === 1
    })
    check(element<HTMLInputElement>('#project-name').value === name, 'Opened name')
    report.passed.push('Canceled open is safe; confirmed open restores voxels and local identity')

    const latest = await (await originalFetch(`/api/models/${saved.id}`)).json()
    await originalFetch(`/api/models/${saved.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...latest, tags: ['other-writer'] }) })
    open()
    input('.model-library [name="tags"]', 'my-edits')
    await save()
    check(element('.model-save-dialog .library-message').textContent!.includes('newer version'), 'Stale save displays conflict')
    check(element<HTMLInputElement>('.model-library [name="tags"]').value === 'my-edits', 'Conflict preserves metadata draft')
    check((await (await originalFetch(`/api/models/${saved.id}`)).json()).tags[0] === 'other-writer', 'Stale save does not overwrite server')
    report.passed.push('Conflicting save preserves both server data and the local draft')

    close()
    open(false)
    input('.model-library [type="search"]', '')
    const filter = element<HTMLSelectElement>('.library-filters select')
    filter.value = ''
    filter.dispatchEvent(new Event('change'))
    await until(() => Boolean(document.querySelector(`[data-open="${copy.id}"]`)))
    window.fetch = ((url, options) => String(url) === `/api/models/${copy.id}`
      ? Promise.resolve(Response.json({ error: 'Test: server unavailable' }, { status: 503 })) : originalFetch(url, options)) as typeof fetch
    element(`[data-open="${copy.id}"]`).click()
    await until(() => element('.library-message').textContent!.includes('server unavailable'))
    check(element<HTMLInputElement>('#project-name').value === name, 'Failed load keeps current model')
    report.passed.push('Failed load leaves the current canvas untouched')

    let release!: (response: Response) => void
    window.fetch = ((url, options) => String(url) === `/api/models/${copy.id}`
      ? new Promise<Response>(resolve => { release = resolve }) : originalFetch(url, options)) as typeof fetch
    element(`[data-open="${copy.id}"]`).click()
    await until(() => Boolean(release))
    input('#project-name', `${name} newer edit`)
    release(await originalFetch(`/api/models/${copy.id}`))
    await until(() => element('.library-message').textContent!.includes('canvas changed'))
    check(element<HTMLInputElement>('#project-name').value === `${name} newer edit`, 'Delayed load cannot overwrite newer edits')
    report.passed.push('Revision guard rejects a delayed load after a canvas mutation')
  } catch (error) { report.error = error instanceof Error ? error.message : String(error) }
  finally { window.confirm = originalConfirm; window.fetch = originalFetch; report.running = false }
  return report
}
