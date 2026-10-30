const app = document.getElementById('app')

const msg = {
  addFailed: 'Failed to add target: server unreachable.',
  deleteFailed: 'Failed to delete target: server unreachable.',
  saveFailed: 'Failed to save target: server unreachable or invalid value.',
  serverDown: 'Failed to connect to server. Is it running?',
  loginFailed: 'Wrong password.',
  clearSearch: 'Clear your search bar before sorting!'
}

let networkId = null
let targets = []
let stock = {}
let networks = []
let registry = []
let itemStatus = {}
let maintainerSleep = 10
let pendingAdd = null
let addDefaults = { threshold: null, batch_size: 1, enabled: true }
let isDirty = false
let isDragging = false
let groupList = []
let searchQuery = ''
let username = localStorage.getItem('maintainer_username') || ''
let tableStale = false
let ws = null

const MAX_AMOUNT = 9000000000000000
const clampAmount = n => n === null ? null : Math.min(n, MAX_AMOUNT)

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function tokenize(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function matchesTokens(text, tokens) {
  const lower = text.toLowerCase()
  return tokens.every(t => lower.includes(t))
}

function send(method, path, body) {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(res => {
    if (!res.ok) throw new Error(res.status)
    return res
  })
}

function isEditing() {
  return !!document.activeElement?.matches?.('#table-container input')
}

function formatShort(n) {
  if (n === null || n === undefined || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return ''
  if (num >= 1e15) return (num / 1e15).toFixed(1).replace(/\.0$/, '') + 'q'
  if (num >= 1e12) return (num / 1e12).toFixed(1).replace(/\.0$/, '') + 't'
  if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'b'
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'm'
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(num)
}

function formatCount(n) {
  return formatShort(n)
}

function parseAmount(str) {
  if (!str || str.trim() === '') return null
  const multipliers = { k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12, q: 1e15 }
  const s = str.toLowerCase().trim().replace(/,/g, '').replace(/(\d+\.?\d*)([kmbtqg]+)/g, (_, num, suf) => {
    let val = parseFloat(num)
    for (const c of suf) val *= multipliers[c] || 1
    return String(val)
  })
  if (!/^[\d\s+\-*/.()e]+$/.test(s)) return null
  try {
    const result = Function('"use strict"; return (' + s + ')')()
    return Number.isFinite(result) ? Math.round(result) : null
  } catch { return null }
}

function iconStyle(x, y) {
  if (x === undefined || y === undefined) return ''
  return `background-position: -${x}px -${y}px`
}

function iconHtml(x, y) {
  if (x === undefined || y === undefined) return '<span class="gtnh-icon gtnh-icon-missing"></span>'
  return `<span class="gtnh-icon" style="${iconStyle(x, y)}"></span>`
}

function showToast(message, type = 'success', action = null) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.className = 'toast-container'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  
  const textNode = document.createElement('span')
  textNode.textContent = message
  toast.appendChild(textNode)

  if (action && action.text && action.callback) {
    const btn = document.createElement('button')
    btn.textContent = action.text
    btn.style.marginLeft = '8px'
    btn.style.background = 'none'
    btn.style.border = 'none'
    btn.style.color = type === 'error' ? '#ffaaaa' : '#55ff55'
    btn.style.textDecoration = 'underline'
    btn.style.cursor = 'pointer'
    btn.style.fontWeight = 'bold'
    btn.style.padding = '0'
    btn.onclick = (e) => {
      e.stopPropagation()
      action.callback()
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 200)
    }
    toast.appendChild(btn)
  }

  container.appendChild(toast)
  setTimeout(() => toast.classList.add('show'), 10)
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 200)
    }
  }, 5000)
}

async function fetchNetworks() {
  const res = await fetch('/api/networks')
  if (res.status === 401) return null
  return res.json()
}

async function fetchTargets() {
  const [t, g] = await Promise.all([
    fetch(`/api/targets/${networkId}`).then(r => r.json()),
    fetch(`/api/groups/${networkId}`).then(r => r.json())
  ])
  targets = t
  groupList = g
}

async function refreshTargets() {
  await fetchTargets()
  renderTable()
}

async function fetchStock() {
  const res = await fetch(`/api/stock/${networkId}`)
  const rows = await res.json()
  stock = Object.fromEntries(rows.map(r => [r.label, r.count]))
}

async function fetchRegistry() {
  const res = await fetch('/gtnh_registry.json')
  registry = await res.json()
}

async function fetchSettings() {
  const res = await fetch(`/api/settings/${networkId}`)
  const data = await res.json()
  maintainerSleep = data.maintainer_sleep ?? 10
}

async function login(name, password = '') {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password })
  })
  if (!res.ok) return false
  username = name
  localStorage.setItem('maintainer_username', name)
  localStorage.removeItem('maintainer_logged_out')
  return true
}

async function showLogin() {
  const { password } = await fetch('/api/auth').then(r => r.json()).catch(() => ({ password: true }))
  app.innerHTML = `
    <form id="login-form" class="login-form">
      <h1>OC Level Maintainer</h1>
      <p id="login-error" class="login-error"></p>
      <input id="login-username" type="text" placeholder="Username" maxlength="32" autocomplete="username" required value="${esc(username)}">
      ${password ? '<input id="login-password" type="password" placeholder="Password" autocomplete="current-password" required>' : ''}
      <button type="submit">Login</button>
    </form>
  `
  const nameInput = document.getElementById('login-username')
  const passwordInput = document.getElementById('login-password')
  ;(username && passwordInput ? passwordInput : nameInput).focus()
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault()
    const name = nameInput.value.trim()
    if (!name) return
    if (await login(name, passwordInput?.value ?? '')) init()
    else document.getElementById('login-error').textContent = msg.loginFailed
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  localStorage.setItem('maintainer_logged_out', '1')
  networkId = null
  ws?.close()
  showLogin()
}

async function changeUsername(name) {
  try {
    await send('PUT', '/api/me', { username: name })
    username = name
    localStorage.setItem('maintainer_username', name)
  } catch {
    showToast('Could not change name', 'error')
  }
  renderUserBox()
}

function renderUserBox() {
  const box = document.getElementById('user-box')
  if (!box) return
  box.innerHTML = `
    Signed in as <button id="user-name" class="link-btn" title="Click to change your name">${esc(username)}</button>
    <span>·</span>
    <button id="logout-btn" class="link-btn">Log out</button>
  `
  document.getElementById('logout-btn').onclick = logout
  document.getElementById('user-name').onclick = () => {
    box.innerHTML = `<input id="user-name-input" type="text" maxlength="32" value="${esc(username)}">`
    const input = document.getElementById('user-name-input')
    input.focus()
    input.select()
    let done = false
    const finish = (save) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name && name !== username) changeUsername(name)
      else renderUserBox()
    }
    input.onblur = () => finish(true)
    input.onkeydown = e => {
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    }
  }
}

async function saveTarget(label, data) {
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.saveFailed, 'error')
    throw new Error(msg.saveFailed)
  }
}

async function addTarget(label, threshold, batchSize, isFluid, enabled) {
  const parsedThreshold = threshold === '' ? null : clampAmount(parseAmount(threshold))
  const parsedBatch = clampAmount(parseAmount(batchSize) ?? 1)

  try {
    const res = await fetch(`/api/targets/${networkId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        threshold: parsedThreshold,
        batch_size: parsedBatch,
        is_fluid: isFluid,
        enabled
      })
    })
    if (!res.ok) throw new Error()
    isDirty = true
    pendingAdd = null
    renderAddPanel()
    await refreshTargets()
  } catch {
    showToast(msg.addFailed, 'error')
  }
}

async function removeTarget(label) {
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error()
    isDirty = true
    await refreshTargets()
  } catch {
    showToast(msg.deleteFailed, 'error')
  }
}

async function changeTargetItem(oldLabel, newLabel, newIsFluid) {
  const index = targets.findIndex(t => t.label === oldLabel)
  const old = targets[index]
  const nextLabel = targets[index + 1]?.label ?? null
  try {
    const res1 = await fetch(`/api/targets/${networkId}/${encodeURIComponent(oldLabel)}`, { method: 'DELETE' })
    if (!res1.ok) throw new Error()
    const res2 = await fetch(`/api/targets/${networkId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: newLabel,
        threshold: old?.threshold ?? null,
        batch_size: old?.batch_size ?? 1,
        is_fluid: newIsFluid,
        enabled: old?.enabled !== 0
      })
    })
    if (!res2.ok) throw new Error()
    isDirty = true
    await send('POST', `/api/layout/${networkId}/move`, { labels: [newLabel], before: nextLabel, group_id: old?.group_id ?? null })
    await refreshTargets()
  } catch {
    showToast(msg.saveFailed, 'error')
  }
}


function openItemPicker(onSelect) {
  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <input id="picker-search" type="text" placeholder="Search items..." autocomplete="off">
        <button id="picker-close">X</button>
      </div>
      <div id="picker-grid" class="picker-grid"></div>
    </div>
  `
  document.body.appendChild(overlay)

  const searchInput = overlay.querySelector('#picker-search')
  const grid = overlay.querySelector('#picker-grid')

  function renderResults(items) {
    grid.innerHTML = items.slice(0, 64).map(i => `
      <div class="picker-item" data-label="${esc(i.label)}" data-fluid="${i.is_fluid}" title="${esc(i.label)}">
        ${iconHtml(i.x, i.y)}
        <span class="picker-item-name">${esc(i.label)}</span>
      </div>
    `).join('')

    grid.querySelectorAll('.picker-item').forEach(el => {
      el.onclick = () => {
        onSelect({ label: el.dataset.label, is_fluid: el.dataset.fluid === 'true' })
        overlay.remove()
      }
    })
  }

  function search(q) {
    if (!q) { renderResults([]); return }
    const tokens = tokenize(q)
    renderResults(registry.filter(i => matchesTokens(i.label, tokens)))
  }

  search('')
  searchInput.addEventListener('input', () => search(searchInput.value.trim()))

  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  searchInput.focus()
}

function connectWs() {
  if (ws || document.hidden || !networkId) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${proto}://${location.host}/ws`)
  ws = socket

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data)
    if (data.network_id !== networkId) return

    if (data.type === 'stock') {
      Object.assign(stock, data.stock)
      if (data.status) itemStatus = data.status
      if (!isDragging) updateStockCells()
      if (isDirty) {
        isDirty = false
        showToast('Synced to OC!', 'success')
      }
    }
    if (data.type === 'targets') {
      targets = data.targets
      if (data.groups) groupList = data.groups
      if (isDragging || isEditing()) tableStale = true
      else renderTable()
    }
  }

  socket.onclose = () => {
    if (ws === socket) ws = null
    if (!document.hidden) setTimeout(connectWs, 3000)
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { ws?.close(); return }
  if (!networkId) return
  connectWs()
  await Promise.all([fetchTargets(), fetchStock()])
  if (isDragging || isEditing()) tableStale = true
  else renderTable()
})

function updateStatusCounts() {
  const el = document.getElementById('status-counts')
  if (!el) return
  const enabled = targets.filter(t => t.enabled !== 0)
  const disabled = targets.length - enabled.length
  const failed = enabled.filter(t => itemStatus.failed?.[t.label]).length
  const crafting = enabled.filter(t => itemStatus.crafting?.[t.label] && !itemStatus.failed?.[t.label]).length
  const stocked = enabled.filter(t => {
    if (itemStatus.failed?.[t.label] || itemStatus.crafting?.[t.label]) return false
    const count = stock[t.label]
    return t.threshold === null || (count !== undefined && count >= t.threshold)
  }).length
  el.innerHTML = `
    <span class="count-stocked">${stocked} stocked</span>
    <span class="count-crafting">${crafting} crafting</span>
    <span class="count-failed">${failed} failed</span>
    <span class="count-disabled">${disabled} disabled</span>
  `
}

function updateStockCells() {
  updateStatusCounts()
  const byLabel = new Map(targets.map(t => [t.label, t]))
  for (const row of document.querySelectorAll('#table-container tr[data-row]')) {
    const t = byLabel.get(row.dataset.row)
    if (!t) continue
    const cell = row.querySelector('[data-stock]')
    const count = stock[t.label]
    cell.textContent = count === undefined ? '...' : formatCount(count)
    cell.title = count === undefined ? 'Loading...' : String(count)
    const keep = ['group-first', 'group-middle', 'group-last', 'group-single', 'row-disabled'].filter(c => row.classList.contains(c))
    row.className = [rowStatusClass(t.label, t), ...keep].filter(Boolean).join(' ')
  }
}

function buildExportBundle() {
  return {
    version: 1,
    targets: targets.map(t => {
      const out = { label: t.label, threshold: t.threshold }
      if ((t.batch_size ?? 1) !== 1) out.batch_size = t.batch_size
      if (t.fluid_tag) out.fluid_tag = t.fluid_tag
      if (t.is_fluid) out.is_fluid = true
      if (t.enabled === 0) out.enabled = false
      return out
    }),
    groups: loadGroups().map(g => ({ name: g.name, labels: g.labels })),
    order: targets.map(t => t.label),
    settings: { maintainer_sleep: maintainerSleep }
  }
}

async function exportToClipboard() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildExportBundle()))
    showToast('Copied to clipboard!', 'success')
  } catch {
    showToast('Clipboard write failed', 'error')
  }
}

function exportToFile() {
  const json = JSON.stringify(buildExportBundle(), null, 2)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  a.download = `oc-maintainer-${networkId}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function uploadLayout(order, groups) {
  return send('PUT', `/api/layout/${networkId}`, {
    order,
    groups: groups.filter(g => Array.isArray(g?.labels)).map(g => ({ name: g.name, labels: g.labels }))
  })
}

async function migrateLocalLayout() {
  const orderKey = `maintainer_custom_order_${networkId}`
  const groupKey = `maintainer_groups_${networkId}`
  const rawOrder = localStorage.getItem(orderKey)
  const rawGroups = localStorage.getItem(groupKey)
  if (!rawOrder && !rawGroups) return
  const untouched = groupList.length === 0 && targets.every(t => t.position === 0)
  try {
    if (untouched) {
      const order = JSON.parse(rawOrder || 'null') ?? targets.map(t => t.label)
      await uploadLayout(order, JSON.parse(rawGroups || '[]'))
      await fetchTargets()
    }
    localStorage.removeItem(orderKey)
    localStorage.removeItem(groupKey)
    localStorage.removeItem('maintainer_sort_mode')
  } catch {}
}

function validateBundle(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.targets)) return 'missing targets array'
  for (const t of data.targets) {
    if (typeof t.label !== 'string' || !t.label.trim()) return `invalid label`
    if (t.threshold !== null && t.threshold !== undefined && !Number.isFinite(Number(t.threshold))) return `invalid threshold for ${t.label}`
    const bs = t.batch_size ?? 1
    if (!Number.isFinite(Number(bs)) || Number(bs) < 1) return `invalid batch_size for ${t.label}`
  }
  return null
}

async function importBundle(data) {
  const error = validateBundle(data)
  if (error) { showToast(`Import failed: ${error}`, 'error'); return }

  const res = await fetch(`/api/targets/${networkId}/bulk`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: data.targets })
  })
  if (!res.ok) { showToast('Import failed: server rejected data', 'error'); return }

  await uploadLayout(
    Array.isArray(data.order) ? data.order : data.targets.map(t => t.label),
    Array.isArray(data.groups) ? data.groups : []
  ).catch(() => showToast('Imported targets, but groups/order failed to save', 'error'))

  if (data.settings?.maintainer_sleep) {
    await fetch(`/api/settings/${networkId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintainer_sleep: data.settings.maintainer_sleep })
    })
    maintainerSleep = data.settings.maintainer_sleep
  }

  await fetchTargets()
  render()
  showToast(`Imported ${data.targets.length} targets`, 'success')
}

function openImportModal() {
  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <span style="flex:1">Import Config</span>
        <button id="picker-close">X</button>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
        <textarea id="import-paste" rows="14" style="width:100%;box-sizing:border-box;resize:vertical" placeholder="Paste exported JSON here..."></textarea>
        <div style="display:flex;gap:8px">
          <button id="import-paste-btn">Import from paste</button>
          <button id="import-file-btn">Load from file</button>
          <input id="import-file" type="file" accept=".json" style="display:none">
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }

  overlay.querySelector('#import-paste-btn').onclick = async () => {
    try {
      const data = JSON.parse(overlay.querySelector('#import-paste').value)
      overlay.remove()
      await importBundle(data)
    } catch { showToast('Invalid JSON', 'error') }
  }

  overlay.querySelector('#import-file-btn').onclick = () => overlay.querySelector('#import-file').click()

  overlay.querySelector('#import-file').onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      overlay.remove()
      await importBundle(data)
    } catch { showToast('Invalid JSON file', 'error') }
  }
}

function timeAgo(at) {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

let registryIcons = null

function auditItem(label) {
  registryIcons ??= new Map(registry.map(r => [r.label, r]))
  const reg = registryIcons.get(label)
  return `<span class="history-item">${iconHtml(reg?.x, reg?.y)}${esc(label)}</span>`
}

function describeAudit(e) {
  const amount = v => v === null ? 'infinite' : formatShort(v)
  const field = e.field === 'batch_size' ? 'batch size' : e.field
  if (e.action === 'import') return `imported ${esc(e.new_value)} targets`
  if (e.action === 'create') return `<span class="audit-added">added</span> ${auditItem(e.label)}`
  if (e.action === 'remove') return `<span class="audit-removed">removed</span> ${auditItem(e.label)}`
  if (e.action === 'enable' || e.action === 'disable') return `${e.action}d ${auditItem(e.label)}`
  const subject = e.label ? `${auditItem(e.label)} ${esc(field)}` : esc(field)
  return `changed ${subject} ${amount(e.old_value)} → ${amount(e.new_value)}`
}

function openHistoryModal() {
  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  overlay.innerHTML = `
    <div class="picker-modal history-modal">
      <div class="picker-header">
        <input id="history-filter" type="text" placeholder="Filter by item or user..." autocomplete="off">
        <button id="picker-close">X</button>
      </div>
      <div id="history-list" class="history-list"></div>
      <div class="history-footer"><button id="history-more" hidden>Load older</button></div>
    </div>
  `
  document.body.appendChild(overlay)
  const list = overlay.querySelector('#history-list')
  const filter = overlay.querySelector('#history-filter')
  const more = overlay.querySelector('#history-more')
  const entries = []

  function draw() {
    const tokens = tokenize(filter.value)
    const shown = entries.filter(e => matchesTokens(`${e.user} ${e.label ?? ''} ${e.field ?? ''} ${e.action}`, tokens))
    list.innerHTML = shown.map(e => `
      <div class="history-row">
        <span class="history-time" title="${esc(new Date(e.at).toLocaleString())}">${timeAgo(e.at)}</span>
        <span class="history-user">${esc(e.user)}</span>
        <span class="history-text">${describeAudit(e)}</span>
      </div>
    `).join('') || '<p class="history-empty">No changes recorded yet.</p>'
  }

  async function loadPage() {
    more.disabled = true
    const before = entries.length ? `?before=${entries[entries.length - 1].id}` : ''
    try {
      const page = await fetch(`/api/audit/${networkId}${before}`).then(r => r.json())
      entries.push(...page)
      more.hidden = page.length < 200
    } catch {
      showToast('Failed to load history', 'error')
    }
    more.disabled = false
    draw()
  }

  filter.addEventListener('input', draw)
  more.onclick = loadPage
  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  filter.focus()
  loadPage()
}

function render() {
  app.innerHTML = `
    <div class="top-bar"><span id="user-box" class="user-box"></span></div>
    <div class="page-header">
      <div class="title-container">
        <h1>OC Level Maintainer</h1>
        <span class="author-credits">
          by Soycake
          <a href="https://github.com/Soycakes/OC-WebInterface-Maintainer" target="_blank" rel="noopener noreferrer">
            <img src="/githubLogo.png" alt="GitHub" class="credit-logo gh-logo" />
          </a>
          <a href="https://www.youtube.com/@soycake" target="_blank" rel="noopener noreferrer">
            <img src="/youtubeLogo.png" alt="YouTube" class="credit-logo" />
          </a>
        </span>
      </div>
      <div class="header-actions">
        <button id="history-btn">History</button>
        <button id="export-copy-btn">Copy</button>
        <button id="export-file-btn">Export</button>
        <button id="import-btn">Import</button>
      </div>
    </div>
    <div id="network-bar"></div>
    <div class="table-toolbar">
      <div id="status-counts" class="status-counts"></div>
      <div class="toolbar-right">
        <input id="table-search" class="table-search" type="search" placeholder="Search items or groups..." autocomplete="off" value="${esc(searchQuery)}">
        <label class="sleep-setting">Check every <input id="sleep-input" type="number" min="5" value="${maintainerSleep}"> s</label>
      </div>
    </div>
    <div id="main-content">
      <div id="table-container"></div>
    </div>
    <div id="add-container" class="mc-inventory-panel"></div>
  `

  document.getElementById('export-copy-btn').onclick = exportToClipboard
  document.getElementById('export-file-btn').onclick = exportToFile
  document.getElementById('import-btn').onclick = openImportModal
  document.getElementById('history-btn').onclick = openHistoryModal
  renderUserBox()

  document.getElementById('sleep-input').addEventListener('change', async (e) => {
    const val = Math.floor(Number(e.target.value))
    if (!Number.isFinite(val) || val < 5) {
      showToast('Check interval must be at least 5s', 'error')
      e.target.value = maintainerSleep
      return
    }
    const res = await fetch(`/api/settings/${networkId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintainer_sleep: val })
    }).catch(() => null)
    if (!res?.ok) {
      showToast(msg.saveFailed, 'error')
      e.target.value = maintainerSleep
      return
    }
    maintainerSleep = val
  })

  const search = document.getElementById('table-search')
  search.addEventListener('input', () => {
    searchQuery = search.value.trim()
    renderTable()
  })
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { search.value = ''; searchQuery = ''; renderTable() }
  })

  renderNetworkBar()
  setupTableEvents(document.getElementById('table-container'))
  renderTable()
  renderAddPanel()
}

function renderNetworkBar() {
  const bar = document.getElementById('network-bar')

  if (networks.length <= 1) return

  bar.innerHTML = `
    <label>Network:
      <select id="network-select">
        ${networks.map(n => `<option value="${esc(n)}"${n === networkId ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
    </label>
  `

  document.getElementById('network-select').onchange = async (e) => {
    networkId = e.target.value
    await Promise.all([fetchTargets(), fetchStock()])
    render()
  }
}

function rowStatusClass(label, target) {
  const s = itemStatus
  if (!s.crafting && !s.failed && !s.requested) return ''
  if (s.failed?.[label]) return 'status-error'
  if (s.crafting?.[label]) return 'status-crafting'
  if (s.requested?.[label]) return 'status-ok'
  if (stock[label] !== undefined && target.threshold !== null && stock[label] >= target.threshold) return 'status-ok'
  return ''
}

function collapsedKey() {
  return `maintainer_collapsed_${networkId}`
}

function setCollapsed(id, collapsed) {
  const ids = new Set(JSON.parse(localStorage.getItem(collapsedKey()) || '[]'))
  if (collapsed) ids.add(id)
  else ids.delete(id)
  localStorage.setItem(collapsedKey(), JSON.stringify([...ids]))
  renderTable()
}

function loadGroups() {
  const collapsed = new Set(JSON.parse(localStorage.getItem(collapsedKey()) || '[]'))
  return groupList
    .map(g => ({ ...g, collapsed: collapsed.has(g.id), labels: targets.filter(t => t.group_id === g.id).map(t => t.label) }))
    .filter(g => g.labels.length >= 2)
}

function buildRowPlan(groups, tokens) {
  const byId = new Map(groups.map(g => [g.id, g]))
  const plan = []
  const seen = new Set()
  for (const t of targets) {
    const group = byId.get(t.group_id)
    if (!group) {
      if (matchesTokens(t.label, tokens)) plan.push({ type: 'item', target: t })
      continue
    }
    if (seen.has(group.id)) continue
    seen.add(group.id)
    const members = targets.filter(x => x.group_id === group.id)
    const shown = matchesTokens(group.name, tokens) ? members : members.filter(x => matchesTokens(x.label, tokens))
    if (shown.length === 0) continue
    if (group.collapsed && tokens.length === 0) {
      plan.push({ type: 'group-collapsed', group })
      continue
    }
    shown.forEach((gt, i) => {
      const pos = shown.length === 1 ? 'single' : i === 0 ? 'first' : i === shown.length - 1 ? 'last' : 'middle'
      plan.push({ type: 'group-' + pos, target: gt, group })
    })
  }
  return plan
}

function renderCollapsedGroupRow(group) {
  const members = targets.filter(t => t.group_id === group.id)
  const icons = members.slice(0, 5).map(t => iconHtml(t.x, t.y)).join('')
  const extra = members.length > 5 ? `<span class="group-extra-count">+${members.length - 5}</span>` : ''
  const allEnabled = members.every(t => t.enabled !== 0)
  return `
    <tr class="group-collapsed-row" data-group-id="${group.id}">
      <td class="bracket-cell bracket-collapse-zone" data-group-id="${group.id}" title="${esc(group.name)}"></td>
      <td>
        <div class="grab-handle">
          <span></span><span></span>
          <span></span><span></span>
          <span></span><span></span>
        </div>
      </td>
      <td>
        <button class="mc-toggle ${allEnabled ? 'mc-toggle-on' : 'mc-toggle-off'} group-toggle-btn" data-group-id="${group.id}">
          ${allEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </td>
      <td><div class="group-icons">${icons}${extra}</div></td>
      <td></td>
      <td colspan="2"><input type="text" class="group-name-input" data-group-id="${group.id}" value="${esc(group.name)}"></td>
      <td><button class="expand-btn" data-group-id="${group.id}">Expand</button></td>
    </tr>
  `
}

async function layoutRequest(method, path, body) {
  try {
    await send(method, path, body)
  } catch {
    showToast(msg.saveFailed, 'error')
  }
  refreshTargets()
}

function setupBracketDrag(container) {
  const tbody = container.querySelector('tbody')
  if (!tbody) return

  function getRows() {
    return Array.from(tbody.querySelectorAll('tr'))
  }

  function rowIndexAt(clientY) {
    const rows = getRows()
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) return i
    }
    if (rows.length === 0) return -1
    if (clientY < rows[0].getBoundingClientRect().top) return 0
    return rows.length - 1
  }

  function clearPreview() {
    tbody.querySelectorAll('tr').forEach(r =>
      r.classList.remove('group-preview-first', 'group-preview-middle', 'group-preview-last')
    )
  }

  function setPreview(lo, hi) {
    clearPreview()
    const rows = getRows()
    for (let i = lo; i <= hi; i++) {
      if (!rows[i]) continue
      rows[i].classList.add(i === lo ? 'group-preview-first' : i === hi ? 'group-preview-last' : 'group-preview-middle')
    }
  }

  function commitGroup(startIdx, endIdx) {
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const rows = getRows()
    const groups = loadGroups()

    if (lo === hi) {
      const label = rows[lo]?.dataset.row
      const g = label && groups.find(g => g.labels.includes(label))
      if (g) setCollapsed(g.id, true)
      return
    }

    const labels = []
    for (const row of rows.slice(lo, hi + 1)) {
      if (row.dataset.row) labels.push(row.dataset.row)
      else labels.push(...(groups.find(g => g.id === parseInt(row.dataset.groupId))?.labels ?? []))
    }
    if (labels.length >= 2) layoutRequest('POST', `/api/groups/${networkId}`, { labels })
  }

  container.querySelectorAll('td.bracket-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      if (!cell.classList.contains('bracket-collapse-zone')) return
      setCollapsed(parseInt(cell.closest('tr').dataset.groupId), false)
    })

    cell.addEventListener('mousedown', (e) => {
      if (cell.classList.contains('bracket-collapse-zone')) return
      if (e.button !== 0) return
      e.preventDefault()
      if (searchQuery) return showToast(msg.clearSearch, 'error')

      const rows = getRows()
      const startIdx = rows.indexOf(cell.closest('tr'))
      if (startIdx === -1) return

      isDragging = true
      setPreview(startIdx, startIdx)

      function stop() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKey)
        isDragging = false
        clearPreview()
      }

      function onMove(e) {
        const cur = rowIndexAt(e.clientY)
        setPreview(Math.min(startIdx, cur), Math.max(startIdx, cur))
      }

      function onUp(e) {
        stop()
        commitGroup(startIdx, rowIndexAt(e.clientY))
      }

      function onKey(e) {
        if (e.key !== 'Escape') return
        stop()
        if (tableStale) renderTable()
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('keydown', onKey)
    })

    cell.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (searchQuery) return showToast(msg.clearSearch, 'error')
      const row = cell.closest('tr')
      const groupId = row.dataset.groupId
        ? parseInt(row.dataset.groupId)
        : targets.find(t => t.label === row.dataset.row)?.group_id
      if (groupId == null) return
      layoutRequest('DELETE', `/api/groups/${networkId}/${groupId}`)
    })
  })
}

function setupTableEvents(container) {
  container.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-delete], [data-toggle], [data-change], .group-toggle-btn, .expand-btn')
    if (!el) return

    if ('delete' in el.dataset) return removeTarget(el.dataset.delete)

    if ('toggle' in el.dataset) {
      const label = el.dataset.toggle
      const t = targets.find(t => t.label === label)
      if (!t) return
      await saveTarget(label, { ...getRowData(label), enabled: t.enabled === 0 }).catch(() => {})
      return refreshTargets()
    }

    if ('change' in el.dataset) {
      const label = el.dataset.change
      return openItemPicker(({ label: newLabel, is_fluid }) => {
        if (newLabel !== label) changeTargetItem(label, newLabel, is_fluid)
      })
    }

    const groups = loadGroups()
    const g = groups.find(g => g.id === parseInt(el.dataset.groupId))
    if (!g) return

    if (el.classList.contains('expand-btn')) return setCollapsed(g.id, false)

    const groupTargets = targets.filter(t => g.labels.includes(t.label))
    const allEnabled = groupTargets.every(t => t.enabled !== 0)
    await Promise.all(groupTargets.map(t =>
      saveTarget(t.label, { threshold: t.threshold, batch_size: t.batch_size, is_fluid: t.is_fluid ?? false, enabled: !allEnabled })
    )).catch(() => {})
    refreshTargets()
  })

  container.addEventListener('focusin', (e) => {
    const input = e.target
    if (input.matches('input[data-field]')) {
      const t = targets.find(x => x.label === input.dataset.label)
      const raw = t?.[input.dataset.field]
      if (t) input.value = raw === null || raw === undefined ? '' : raw.toLocaleString()
    }
    if (input.matches('input')) input.dataset.saved = input.value
  })

  container.addEventListener('focusout', (e) => {
    const input = e.target
    if (input.matches('input[data-field]')) commitField(input)
    if (input.matches('.group-name-input')) commitGroupName(input)
    setTimeout(() => { if (tableStale && !isEditing() && !isDragging) renderTable() })
  })

  container.addEventListener('keydown', (e) => {
    if (!e.target.matches('input')) return
    if (e.key === 'Enter') e.target.blur()
    if (e.key === 'Escape') {
      e.target.value = e.target.dataset.saved ?? e.target.value
      e.target.blur()
    }
  })
}

function commitField(input) {
  const saved = input.dataset.saved ?? ''
  const label = input.dataset.label
  const revert = () => { input.value = saved }

  if (input.value === '') {
    if (input.dataset.field === 'batch_size') return revert()
    if (saved !== '') saveTarget(label, getRowData(label)).catch(revert)
    return
  }
  const parsed = parseAmount(input.value)
  if (parsed === null) {
    showToast('Invalid format', 'error')
    return revert()
  }
  const changed = input.value !== saved
  input.value = formatShort(clampAmount(parsed))
  if (changed) saveTarget(label, getRowData(label)).catch(revert)
}

function commitGroupName(input) {
  const name = input.value.trim()
  if (!name || name === input.dataset.saved) {
    input.value = input.dataset.saved ?? input.value
    return
  }
  layoutRequest('PUT', `/api/groups/${networkId}/${input.dataset.groupId}`, { name })
}

function renderTable() {
  const container = document.getElementById('table-container')
  tableStale = false

  updateStatusCounts()

  const plan = buildRowPlan(loadGroups(), tokenize(searchQuery))

  const rows = plan.map(entry => {
    if (entry.type === 'group-collapsed') return renderCollapsedGroupRow(entry.group)

    const t = entry.target
    const count = stock[t.label]
    const stockDisplay = count === undefined ? '...' : formatCount(count)
    const stockTitle = count === undefined ? 'Loading...' : String(count)
    const thresholdVal = formatShort(t.threshold)
    const batchVal = formatShort(t.batch_size ?? 1)
    const enabled = t.enabled !== 0
    const groupCls = entry.type !== 'item' ? entry.type : ''
    const rowClass = [rowStatusClass(t.label, t), enabled ? '' : 'row-disabled', groupCls].filter(Boolean).join(' ')

    const label = esc(t.label)
    return `
      <tr data-row="${label}" class="${rowClass}">
        <td class="bracket-cell" data-row="${label}"${entry.group ? ` title="${esc(entry.group.name)}"` : ''}></td>
        <td>
          <div class="grab-handle">
            <span></span><span></span>
            <span></span><span></span>
            <span></span><span></span>
          </div>
        </td>
        <td>
          <button class="mc-toggle ${enabled ? 'mc-toggle-on' : 'mc-toggle-off'}" data-toggle="${label}">
            ${enabled ? 'Enabled' : 'Disabled'}
          </button>
        </td>
        <td>
          <div class="item-slot" data-change="${label}">
            ${iconHtml(t.x, t.y)}
            <span>${label}</span>
          </div>
        </td>
        <td data-stock title="${stockTitle}">${stockDisplay}</td>
        <td>
          <input type="text" value="${thresholdVal}" placeholder="infinite"
            data-label="${label}" data-field="threshold">
        </td>
        <td>
          <input type="text" value="${batchVal}"
            data-label="${label}" data-field="batch_size">
        </td>
        <td>
          <button data-delete="${label}">Delete</button>
        </td>
      </tr>
    `
  }).join('')

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th class="bracket-hint">${groupList.length ? '' : '↓ drag here to group'}</th>
          <th></th>
          <th></th>
          <th>Item</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Batch size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${plan.length === 0 && searchQuery ? '<p class="empty-search">No items or groups match your search.</p>' : ''}
  `

  setupBracketDrag(container)

  let draggedRow = null
  let startNext = null

  function moveDraggedTo(e, targetRow) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!draggedRow || targetRow === draggedRow) return
    if (targetRow.parentNode !== draggedRow.parentNode) return
    const rect = targetRow.getBoundingClientRect()
    const anchor = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5 ? targetRow.nextSibling : targetRow
    targetRow.parentNode.insertBefore(draggedRow, anchor)
  }

  function firstLabel(row) {
    if (!row) return null
    if (row.dataset.row) return row.dataset.row
    return targets.find(t => t.group_id === parseInt(row.dataset.groupId))?.label ?? null
  }

  function neighborGroup(row) {
    const groupOf = r => r?.dataset.row ? targets.find(t => t.label === r.dataset.row)?.group_id ?? null : null
    const prev = groupOf(row.previousElementSibling)
    return prev !== null && prev === groupOf(row.nextElementSibling) ? prev : null
  }

  container.querySelectorAll('tr[data-row], tr[data-group-id]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })
    row.setAttribute('draggable', 'true')

    row.addEventListener('dragstart', (e) => {
      if (!dragAllowed) { e.preventDefault(); return }
      if (searchQuery) {
        e.preventDefault()
        showToast(msg.clearSearch, 'error')
        return
      }
      draggedRow = row
      startNext = row.nextElementSibling
      isDragging = true
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    row.addEventListener('dragend', () => {
      isDragging = false
      if (!draggedRow) return
      draggedRow.classList.remove('dragging')
      draggedRow = null
      if (row.nextElementSibling === startNext) {
        if (tableStale) renderTable()
        return
      }
      const before = firstLabel(row.nextElementSibling)
      if (row.dataset.row) {
        layoutRequest('POST', `/api/layout/${networkId}/move`, { labels: [row.dataset.row], before, group_id: neighborGroup(row) })
      } else {
        const groupId = parseInt(row.dataset.groupId)
        const labels = targets.filter(t => t.group_id === groupId).map(t => t.label)
        layoutRequest('POST', `/api/layout/${networkId}/move`, { labels, before, group_id: groupId })
      }
    })

    row.addEventListener('dragover', (e) => moveDraggedTo(e, row))
  })
}

function renderAddPanel() {
  const container = document.getElementById('add-container')
  if (!container) return

  const slotHtml = pendingAdd
    ? `<div class="item-slot item-slot-pick" id="add-slot">${iconHtml(pendingAdd.x, pendingAdd.y)}<span>${esc(pendingAdd.label)}</span></div>`
    : `<div class="item-slot item-slot-empty" id="add-slot">Click to select item</div>`

  const threshVal = addDefaults.threshold != null ? formatShort(addDefaults.threshold) : ''
  const batchVal = addDefaults.batch_size != null ? formatShort(addDefaults.batch_size) : '1'
  const addEnabled = addDefaults.enabled

  container.innerHTML = `
    <div class="inventory-title">Add new item</div>
    <div class="add-fields">
      <div class="add-field-cell">
        <button id="add-toggle" class="mc-toggle ${addEnabled ? 'mc-toggle-on' : 'mc-toggle-off'}">
          ${addEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      <div class="add-field-cell add-field-item">
        ${slotHtml}
      </div>
      <div class="add-field-cell">
        <input id="add-threshold" type="text" placeholder="infinite" value="${threshVal}">
      </div>
      <div class="add-field-cell">
        <input id="add-batch" type="text" placeholder="1" value="${batchVal}">
      </div>
      <div class="add-field-cell">
        <button id="add-btn" ${pendingAdd ? '' : 'disabled'}>Add</button>
      </div>
    </div>
  `

  ;['add-threshold', 'add-batch'].forEach(id => {
    const input = document.getElementById(id)
    if (!input) return
    const field = id === 'add-threshold' ? 'threshold' : 'batch_size'
    let savedValue = input.value
    input.addEventListener('focus', () => {
      const raw = addDefaults[field]
      input.value = raw === null || raw === undefined ? '' : raw.toLocaleString()
      savedValue = input.value
    })
    input.addEventListener('blur', () => {
      if (input.value === '') {
        if (field === 'batch_size') { input.value = savedValue; return }
        addDefaults[field] = null
        if (pendingAdd) pendingAdd[field] = null
        return
      }
      let parsed = parseAmount(input.value)
      if (parsed === null) { showToast('Invalid format', 'error'); input.value = savedValue; return }
      parsed = clampAmount(parsed)
      addDefaults[field] = parsed
      if (pendingAdd) pendingAdd[field] = parsed
      input.value = formatShort(parsed)
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') { input.value = savedValue; input.blur() }
    })
  })

  document.getElementById('add-slot').onclick = () => {
    openItemPicker(item => {
      const reg = registry.find(i => i.label === item.label)
      pendingAdd = { ...item, x: reg?.x, y: reg?.y, ...addDefaults }
      renderAddPanel()
    })
  }

  document.getElementById('add-toggle').onclick = () => {
    addDefaults.enabled = !addDefaults.enabled
    if (pendingAdd) pendingAdd.enabled = addDefaults.enabled
    renderAddPanel()
  }

  if (pendingAdd) {
    document.getElementById('add-btn').onclick = () => {
      const threshStr = document.getElementById('add-threshold').value
      const batchStr = document.getElementById('add-batch').value || '1'
      if (threshStr && parseAmount(threshStr) === null) {
        showToast('Invalid threshold format', 'error')
        return
      }
      if (parseAmount(batchStr) === null) {
        showToast('Invalid batch size format', 'error')
        return
      }
      addTarget(pendingAdd.label, threshStr, batchStr, pendingAdd.is_fluid, addDefaults.enabled)
    }
  }
}

function getRowData(label) {
  const thresholdInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="threshold"]`)
  const batchInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="batch_size"]`)
  const target = targets.find(t => t.label === label)

  return {
    threshold: thresholdInput.value === '' ? null : clampAmount(parseAmount(thresholdInput.value)),
    batch_size: clampAmount(parseAmount(batchInput.value) ?? 1),
    is_fluid: target?.is_fluid ?? false,
    enabled: target ? target.enabled !== 0 : true
  }
}

async function init() {
  try {
    networks = await fetchNetworks()
    if (networks === null) {
      const canAutoLogin = username && !localStorage.getItem('maintainer_logged_out')
      if (canAutoLogin && await login(username)) return init()
      return showLogin()
    }
    const me = await fetch('/api/me').then(r => r.json())
    username = me.username
    networkId = networks[0] || 'main'
    await Promise.all([fetchTargets(), fetchStock(), fetchRegistry(), fetchSettings()])
    await migrateLocalLayout()
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
