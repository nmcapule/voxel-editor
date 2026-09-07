import type { ModelSummary } from '../scripts/model-server'
import { parseProjectSnapshot, type ProjectSnapshot, type RemoteCommand } from './protocol'
import type { LibraryLink } from './storage'
import { StudioCommandError } from './studio'

type LibraryHost = {
  current(): { name: string; revision: number; generation: number; changes: number; library?: LibraryLink; hasTextureMaps: boolean }
  snapshot(): ProjectSnapshot
  execute(command: RemoteCommand, revision: number): Promise<{ revision: number }>
  link(library: LibraryLink): void
  notify(message: string): void
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/models${path}`, { ...options, signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]) }) }
  catch (error) {
    if (options.signal?.aborted) throw error
    throw new Error('Cannot reach the model library. Check your connection and that the server is running, then retry.')
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error ?? 'The model library is unavailable. Check that the server is running, then retry.')
  return result as T
}

export function mountModelLibrary(host: LibraryHost) {
  const dialog = document.createElement('dialog')
  dialog.className = 'model-library model-browser instrument'
  dialog.setAttribute('aria-labelledby', 'library-title')
  dialog.innerHTML = `
    <header class="library-header"><div><h2 id="library-title">Model library</h2><p>Isometric previews of models saved on this server</p></div><button type="button" class="library-close" aria-label="Close model library"><svg aria-hidden="true"><use href="#icon-close"></use></svg></button></header>
    <div class="library-toolbar">
      <div class="library-filters"><label>Search models<input type="search" maxlength="120" placeholder="Search names or tags" autocomplete="off"></label><label>Filter by tag<select><option value="">All tags</option></select></label></div>
      <p class="library-message" role="status" hidden></p>
      <div class="library-count-row"><p class="library-count" role="status"></p><button type="button" class="library-refresh">Refresh</button></div>
    </div>
    <div class="library-body">
      <ul class="library-results" aria-label="Saved models"></ul>
      <div class="library-pages" hidden><button type="button" class="secondary" data-page="previous">Previous</button><span></span><button type="button" class="secondary" data-page="next">Next</button></div>
    </div>`
  const saveDialog = document.createElement('dialog')
  saveDialog.className = 'model-library model-save-dialog instrument'
  saveDialog.setAttribute('aria-labelledby', 'library-save-title')
  saveDialog.innerHTML = `
    <header class="library-header"><div><h2 id="library-save-title">Save model</h2><p class="library-save-state"></p></div><button type="button" class="library-close" aria-label="Close save model"><svg aria-hidden="true"><use href="#icon-close"></use></svg></button></header>
    <div class="library-body">
      <form><fieldset>
        <label>Model name<input name="name" type="text" maxlength="60" required autocomplete="off"></label>
        <label>Tags<input name="tags" type="text" maxlength="838" aria-describedby="library-tags-help" autocomplete="off" placeholder="e.g. architecture, furniture"></label>
        <p id="library-tags-help" class="panel-note">Separate tags with commas. Up to 20 tags, 40 characters each.</p>
        <div class="library-save-actions"><button type="submit" class="primary">Save to server</button><button type="submit" name="copy" class="secondary">Save a copy</button></div>
        <p class="panel-note">Saves voxels, layers, palette, material properties and lighting. Texture image files are not included.</p>
      </fieldset></form>
      <p class="library-message" role="status" hidden></p>
    </div>`
  document.body.append(dialog, saveDialog)
  const closes = [dialog, saveDialog].map(panel => panel.querySelector<HTMLButtonElement>('.library-close')!)
  const form = saveDialog.querySelector<HTMLFormElement>('form')!
  const fields = saveDialog.querySelector<HTMLFieldSetElement>('fieldset')!
  const name = form.elements.namedItem('name') as HTMLInputElement
  const tags = form.elements.namedItem('tags') as HTMLInputElement
  const save = form.querySelector<HTMLButtonElement>('.primary')!
  const copy = form.querySelector<HTMLButtonElement>('[name="copy"]')!
  const saveState = saveDialog.querySelector<HTMLElement>('.library-save-state')!
  const search = dialog.querySelector<HTMLInputElement>('[type="search"]')!
  const filter = dialog.querySelector<HTMLSelectElement>('select')!
  const count = dialog.querySelector<HTMLElement>('.library-count')!
  const results = dialog.querySelector<HTMLUListElement>('.library-results')!
  const pages = dialog.querySelector<HTMLElement>('.library-pages')!
  const refresh = dialog.querySelector<HTMLButtonElement>('.library-refresh')!
  let busy = false
  let formGeneration = 0
  let offset = 0
  let total = 0
  let browsing: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let returnFocus: HTMLElement | null = null

  function showMessage(text: string, error = false) {
    const message = (dialog.open ? dialog : saveDialog).querySelector<HTMLElement>('.library-message')!
    message.textContent = text
    message.dataset.error = String(error)
    message.hidden = !text
  }

  function syncForm() {
    const current = host.current()
    formGeneration = current.generation
    name.value = current.name
    name.setCustomValidity('')
    tags.value = current.library?.tags.join(', ') ?? ''
    copy.hidden = !current.library
    save.textContent = current.library ? 'Save changes' : 'Save to server'
    saveState.textContent = !current.library ? 'Not saved to server' : current.library.dirty ? 'Unsaved server changes' : 'Saved to server'
  }

  function setBusy(value: boolean) {
    busy = value
    fields.disabled = value
    for (const close of closes) close.disabled = value
    results.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => { button.disabled = value })
  }

  async function browse() {
    clearTimeout(searchTimer)
    browsing?.abort()
    const controller = browsing = new AbortController()
    count.textContent = 'Loading models...'
    results.setAttribute('aria-busy', 'true')
    results.replaceChildren()
    dialog.querySelector('.library-body')!.scrollTop = 0
    pages.hidden = true
    try {
      const data = await request<{ models: ModelSummary[]; tags: string[]; total: number }>(`?${new URLSearchParams({ q: search.value.trim(), tag: filter.value, offset: String(offset) })}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      total = data.total
      if (offset && offset >= total) { offset = 0; void browse(); return }
      const selectedTag = filter.value
      filter.replaceChildren(new Option('All tags', ''), ...data.tags.map(tag => new Option(tag, tag)))
      if (selectedTag && !data.tags.includes(selectedTag)) filter.add(new Option(selectedTag, selectedTag))
      filter.value = selectedTag
      count.textContent = total ? `${total.toLocaleString()} ${total === 1 ? 'model' : 'models'}`
        : search.value || selectedTag ? 'No matching models. Try another search or choose All tags.' : 'No saved models yet. Save your current model to start the library.'
      for (const model of data.models) {
        const row = document.createElement('li')
        row.className = 'library-model'
        const info = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = model.name || 'Untitled'
        const facts = document.createElement('p')
        facts.className = 'library-model-facts'
        const { x, y, z } = model.dimensions
        facts.textContent = `${x} x ${y} x ${z} / ${model.voxelCount.toLocaleString()} ${model.voxelCount === 1 ? 'voxel' : 'voxels'}`
        const time = document.createElement('time')
        time.dateTime = model.updatedAt
        time.textContent = `Saved ${new Date(model.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
        info.append(title, facts, time)
        if (model.tags.length) {
          const tagList = document.createElement('div')
          tagList.className = 'library-model-tags'
          for (const tag of model.tags) {
            const button = document.createElement('button')
            button.type = 'button'
            button.textContent = tag
            button.dataset.tag = tag
            button.setAttribute('aria-label', `Filter by tag ${tag}`)
            tagList.append(button)
          }
          info.append(tagList)
        }
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'library-preview'
        open.dataset.open = model.id
        open.setAttribute('aria-label', `Open ${model.name || 'Untitled'}`)
        open.disabled = busy
        const previewState = document.createElement('span')
        previewState.className = 'library-preview-state'
        previewState.textContent = model.voxelCount ? 'Loading preview...' : 'Empty model'
        open.append(previewState)
        if (model.voxelCount) {
          const image = document.createElement('img')
          image.alt = ''
          image.width = image.height = 256
          image.loading = 'lazy'
          image.decoding = 'async'
          image.addEventListener('load', () => { previewState.hidden = true })
          image.addEventListener('error', () => { image.hidden = true; previewState.textContent = 'Preview unavailable' })
          image.src = `/api/models/${model.id}/thumbnail.png?v=${model.version}`
          open.append(image)
        }
        const openLabel = document.createElement('span')
        openLabel.className = 'library-open-label'
        openLabel.textContent = 'Open'
        open.append(openLabel)
        row.append(open, info)
        results.append(row)
      }
      pages.hidden = total <= 50
      pages.querySelector('span')!.textContent = `${offset + 1}-${Math.min(offset + 50, total)} of ${total}`
      pages.querySelector<HTMLButtonElement>('[data-page="previous"]')!.disabled = offset === 0
      pages.querySelector<HTMLButtonElement>('[data-page="next"]')!.disabled = offset + 50 >= total
    } catch (error) {
      if (!controller.signal.aborted) count.textContent = `${error instanceof Error ? error.message : 'Could not load models.'} Use Refresh to try again.`
    } finally { if (!controller.signal.aborted) results.removeAttribute('aria-busy') }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (busy) return
    const current = host.current()
    if (current.generation !== formGeneration) { syncForm(); showMessage('The canvas was replaced. Review the current model before saving.', true); return }
    const normalizedTags = [...new Set(tags.value.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean))]
    if (normalizedTags.length > 20 || normalizedTags.some(tag => tag.length > 40 || /\p{Cc}/u.test(tag))) { showMessage('Use up to 20 tags, each at most 40 characters with no control characters.', true); tags.focus(); return }
    if (!name.value.trim()) { name.setCustomValidity('Enter a model name.'); name.reportValidity(); return }
    if (current.hasTextureMaps && !confirm('Texture image files are not included in server saves. Save the model without these images?')) return
    const asCopy = (event.submitter as HTMLButtonElement | null)?.name === 'copy'
    setBusy(true)
    showMessage('Saving model to server...')
    try {
      await host.execute({ type: 'document.rename', name: name.value.trim() }, current.revision)
      const captured = host.current()
      if (captured.generation !== formGeneration) throw new Error('The canvas was replaced. Reopen the library before saving.')
      const library = asCopy ? undefined : captured.library
      const model = await request<ModelSummary>(library ? `/${library.id}` : '', {
        method: library ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: host.snapshot(), tags: normalizedTags, version: library?.version }),
      })
      const now = host.current()
      if (now.generation === captured.generation) {
        host.link({ id: model.id, version: model.version, tags: model.tags, dirty: now.changes !== captured.changes })
        syncForm()
      }
      showMessage(`Saved "${model.name}" to the server.${host.current().library?.dirty ? ' Newer canvas changes still need saving.' : ''}`)
      offset = 0
    } catch (error) { showMessage(error instanceof Error ? error.message : 'The model could not be saved. Retry or save a copy.', true) }
    finally { setBusy(false) }
  })
  name.addEventListener('input', () => name.setCustomValidity(''))

  results.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.tag !== undefined) { filter.value = button.dataset.tag; offset = 0; void browse(); return }
    if (!button.dataset.open || busy) return
    const current = host.current()
    if (!confirm('Open this saved model? This replaces the current canvas, undo history and local autosave. Save any changes you want to keep first.')) return
    setBusy(true)
    showMessage('Opening model...')
    try {
      const model = await request<ModelSummary & { snapshot: ProjectSnapshot }>(`/${button.dataset.open}`)
      const snapshot = parseProjectSnapshot(model.snapshot)
      const result = await host.execute({ type: 'project.snapshot.replace', snapshot, allowReplace: true }, current.revision)
      const now = host.current()
      if (now.generation !== current.generation + 1) throw new Error('The canvas was replaced again before opening finished. Reopen the library to continue.')
      host.link({ id: model.id, version: model.version, tags: model.tags, dirty: now.revision !== result.revision })
      setBusy(false)
      dialog.close()
      host.notify(`Opened "${model.name}" from the server.`)
    } catch (error) {
      showMessage(error instanceof StudioCommandError && error.code === 'revision_conflict'
        ? 'The canvas changed while the model was opening. Nothing was replaced. Save your changes, then try opening again.'
        : error instanceof Error ? error.message : 'The model could not be opened. Your canvas has not been replaced.', true)
    }
    finally { setBusy(false) }
  })

  search.addEventListener('input', () => {
    offset = 0
    browsing?.abort()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void browse() }, 200)
  })
  filter.addEventListener('change', () => { offset = 0; void browse() })
  refresh.addEventListener('click', () => { void browse() })
  pages.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-page]')
    if (!button) return
    offset = button.dataset.page === 'next' ? offset + 50 : Math.max(0, offset - 50)
    void browse()
  })
  for (const panel of [dialog, saveDialog]) {
    panel.querySelector('.library-close')!.addEventListener('click', () => panel.close())
    panel.addEventListener('keydown', event => { event.stopPropagation() })
    panel.addEventListener('keyup', event => { event.stopPropagation() })
    panel.addEventListener('cancel', event => { if (busy) event.preventDefault() })
    panel.addEventListener('close', () => {
      if (panel.open) return
      if (panel === dialog) { browsing?.abort(); clearTimeout(searchTimer) }
      if (!dialog.open && !saveDialog.open) returnFocus?.focus({ preventScroll: true })
    })
  }

  return {
    open(saving = false) {
      if (dialog.open || saveDialog.open) return
      returnFocus = document.querySelector<HTMLElement>('#project-menu summary')
      const panel = saving ? saveDialog : dialog
      if (saving) syncForm()
      panel.showModal()
      showMessage('')
      ;(saving ? name : search).focus()
      if (!saving) void browse()
    },
    dispose() { browsing?.abort(); clearTimeout(searchTimer); dialog.remove(); saveDialog.remove() },
  }
}
