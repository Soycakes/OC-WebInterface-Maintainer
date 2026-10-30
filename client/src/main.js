const app = document.getElementById('app')

const msg = {
  addFailed: 'Failed to add target: server unreachable.',
  deleteFailed: 'Failed to delete target: server unreachable.',
  saveFailed: 'Failed to save target: server unreachable or invalid value.',
  serverDown: 'Failed to connect to server. Is it running?',
  loginFailed: 'Wrong password.'
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
let currentSort = localStorage.getItem('maintainer_sort_mode') || 'default'
let isDragging = false
let tableStale = false
let ws = null

const MAX_AMOUNT = 9000000000000000
const clampAmount = n => n === null ? null : Math.min(n, MAX_AMOUNT)

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
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
  const res = await fetch(`/api/targets/${networkId}`)
  targets = await res.json()
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

function showLogin() {
  app.innerHTML = `
    <div>
      <h1>OC Level Maintainer</h1>
      <p id="login-error"></p>
      <input id="login-password" type="password" placeholder="Password">
      <button id="login-btn">Login</button>
    </div>
  `
  document.getElementById('login-btn').onclick = async () => {
    const password = document.getElementById('login-password').value
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    if (res.ok) {
      init()
    } else {
      document.getElementById('login-error').textContent = msg.loginFailed
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
  const old = targets.find(t => t.label === oldLabel)
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
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
    renderResults(registry.filter(i => {
      const label = i.label.toLowerCase()
      return tokens.every(t => label.includes(t))
    }))
  }

  search('')
  searchInput.addEventListener('input', () => search(searchInput.value.trim()))

  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  searchInput.focus()
}

function connectWs() {
  if (ws || document.hidden) return
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
    const keep = ['group-first', 'group-middle', 'group-last', 'row-disabled'].filter(c => row.classList.contains(c))
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
    groups: JSON.parse(localStorage.getItem(`maintainer_groups_${networkId}`) || '[]'),
    order: JSON.parse(localStorage.getItem(`maintainer_custom_order_${networkId}`) || 'null'),
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

  if (Array.isArray(data.groups)) localStorage.setItem(`maintainer_groups_${networkId}`, JSON.stringify(data.groups))
  if (data.order) localStorage.setItem(`maintainer_custom_order_${networkId}`, JSON.stringify(data.order))

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

function render() {
  app.innerHTML = `
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
        <button id="export-copy-btn">Copy</button>
        <button id="export-file-btn">Export</button>
        <button id="import-btn">Import</button>
      </div>
    </div>
    <div id="network-bar"></div>
    <div class="table-toolbar">
      <div id="status-counts" class="status-counts"></div>
      <div class="toolbar-right">
        <div class="sort-container">
          <label for="sort-select">Sort by:</label>
          <select id="sort-select">
            <option value="default">Default</option>
            <option value="az">Alphabetical A-Z</option>
            <option value="za">Alphabetical Z-A</option>
            <option value="threshold-lh">Threshold (Low to High)</option>
            <option value="threshold-hl">Threshold (High to Low)</option>
            <option value="custom">Custom (Drag & Drop)</option>
          </select>
        </div>
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

  const sortSelect = document.getElementById('sort-select')
  sortSelect.value = currentSort
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value
    localStorage.setItem('maintainer_sort_mode', currentSort)
    renderTable()
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

function getSortedTargets() {
  const list = [...targets]
  if (currentSort === 'az') {
    list.sort((a, b) => a.label.localeCompare(b.label))
  } else if (currentSort === 'za') {
    list.sort((a, b) => b.label.localeCompare(a.label))
  } else if (currentSort === 'threshold-lh') {
    list.sort((a, b) => {
      const ta = a.threshold === null ? Infinity : a.threshold
      const tb = b.threshold === null ? Infinity : b.threshold
      return ta - tb
    })
  } else if (currentSort === 'threshold-hl') {
    list.sort((a, b) => {
      const ta = a.threshold === null ? Infinity : a.threshold
      const tb = b.threshold === null ? Infinity : b.threshold
      return tb - ta
    })
  } else if (currentSort === 'custom') {
    const savedOrder = JSON.parse(localStorage.getItem(`maintainer_custom_order_${networkId}`) || '[]')
    if (savedOrder.length > 0) {
      const activeLabels = new Set(targets.map(t => t.label))
      const cleanedOrder = savedOrder.filter(label => activeLabels.has(label))
      const orderMap = new Map(cleanedOrder.map((label, idx) => [label, idx]))
      list.sort((a, b) => {
        const idxA = orderMap.has(a.label) ? orderMap.get(a.label) : Infinity
        const idxB = orderMap.has(b.label) ? orderMap.get(b.label) : Infinity
        return idxA - idxB
      })
    }
  }
  return list
}

function loadGroups() {
  if (!networkId) return []
  const groups = JSON.parse(localStorage.getItem(`maintainer_groups_${networkId}`) || '[]')
  const validLabels = new Set(targets.map(t => t.label))
  return groups
    .map(g => ({ ...g, labels: g.labels.filter(l => validLabels.has(l)) }))
    .filter(g => g.labels.length >= 2)
}

function saveGroups(groups) {
  localStorage.setItem(`maintainer_groups_${networkId}`, JSON.stringify(groups))
}

function buildRowPlan(sortedTargets, groups) {
  const labelToGroup = new Map()
  for (const g of groups) {
    for (const label of g.labels) labelToGroup.set(label, g)
  }
  const plan = []
  const seen = new Set()
  for (const t of sortedTargets) {
    const group = labelToGroup.get(t.label)
    if (!group) {
      plan.push({ type: 'item', target: t })
      continue
    }
    if (seen.has(group.id)) continue
    seen.add(group.id)
    if (group.collapsed) {
      plan.push({ type: 'group-collapsed', group })
    } else {
      const members = sortedTargets.filter(x => group.labels.includes(x.label))
      members.forEach((gt, i) => {
        const pos = i === 0 ? 'first' : i === members.length - 1 ? 'last' : 'middle'
        plan.push({ type: 'group-' + pos, target: gt, group })
      })
    }
  }
  return plan
}

function renderCollapsedGroupRow(group, grabDisabled) {
  const icons = group.labels.slice(0, 5).map(label => {
    const reg = registry.find(r => r.label === label)
    return iconHtml(reg?.x, reg?.y)
  }).join('')
  const extra = group.labels.length > 5 ? `<span class="group-extra-count">+${group.labels.length - 5}</span>` : ''
  const groupTargets = targets.filter(t => group.labels.includes(t.label))
  const allEnabled = groupTargets.length > 0 && groupTargets.every(t => t.enabled !== 0)
  return `
    <tr class="group-collapsed-row" data-group-id="${group.id}">
      <td class="bracket-cell bracket-collapse-zone" data-group-id="${group.id}"></td>
      <td>
        <div class="grab-handle ${grabDisabled ? 'grab-handle-disabled' : ''}">
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
    if (lo === hi) {
      const rows = getRows()
      const row = rows[lo]
      if (!row || !row.dataset.row) return
      const isGrouped = ['group-first', 'group-middle', 'group-last'].some(c => row.classList.contains(c))
      if (!isGrouped) return
      const groups = loadGroups()
      const g = groups.find(g => g.labels.includes(row.dataset.row))
      if (!g) return
      g.collapsed = true
      saveGroups(groups)
      renderTable()
      return
    }

    const rows = getRows()
    const groups = loadGroups()
    const newLabels = []
    const overlapping = []
    const seenOverlap = new Set()

    for (let i = lo; i <= hi; i++) {
      const row = rows[i]
      if (!row) continue
      if (row.dataset.row) {
        newLabels.push(row.dataset.row)
        const g = groups.find(gr => gr.labels.includes(row.dataset.row))
        if (g && !seenOverlap.has(g.id)) { seenOverlap.add(g.id); overlapping.push(g) }
      } else if (row.dataset.groupId) {
        const g = groups.find(gr => gr.id === parseInt(row.dataset.groupId))
        if (g) {
          newLabels.push(...g.labels)
          if (!seenOverlap.has(g.id)) { seenOverlap.add(g.id); overlapping.push(g) }
        }
      }
    }

    if (newLabels.length < 2) return

    const newLabelSet = new Set(newLabels)

    const kept = groups
      .map(g => ({ ...g, labels: g.labels.filter(l => !newLabelSet.has(l)) }))
      .filter(g => g.labels.length >= 2)

    const id = kept.length === 0 ? 1 : Math.max(...kept.map(g => g.id)) + 1
    const name = overlapping.length > 0 ? overlapping[0].name : 'Group ' + id
    kept.push({ id, name, labels: newLabels, collapsed: false })
    saveGroups(kept)
    renderTable()
  }

  container.querySelectorAll('td.bracket-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      if (currentSort !== 'custom') return
      if (!cell.classList.contains('bracket-collapse-zone')) return
      const row = cell.closest('tr')
      const groupId = parseInt(row.dataset.groupId)
      const groups = loadGroups()
      const g = groups.find(g => g.id === groupId)
      if (!g) return
      g.collapsed = false
      saveGroups(groups)
      renderTable()
    })

    cell.addEventListener('mousedown', (e) => {
      if (currentSort !== 'custom') return
      if (cell.classList.contains('bracket-collapse-zone')) return
      if (e.button !== 0) return
      e.preventDefault()

      const rows = getRows()
      const startIdx = rows.indexOf(cell.closest('tr'))
      if (startIdx === -1) return

      isDragging = true
      setPreview(startIdx, startIdx)

      function onMove(e) {
        const cur = rowIndexAt(e.clientY)
        setPreview(Math.min(startIdx, cur), Math.max(startIdx, cur))
      }

      function onUp(e) {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKey)
        isDragging = false
        clearPreview()
        commitGroup(startIdx, rowIndexAt(e.clientY))
      }

      function onKey(e) {
        if (e.key !== 'Escape') return
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKey)
        isDragging = false
        clearPreview()
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('keydown', onKey)
    })

    cell.addEventListener('contextmenu', (e) => {
      if (currentSort !== 'custom') return
      e.preventDefault()
      const row = cell.closest('tr')
      const groups = loadGroups()
      let groupId = null
      if (row.dataset.groupId) {
        groupId = parseInt(row.dataset.groupId)
      } else if (row.dataset.row) {
        const g = groups.find(g => g.labels.includes(row.dataset.row))
        if (g) groupId = g.id
      }
      if (groupId === null) return
      saveGroups(groups.filter(g => g.id !== groupId))
      renderTable()
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

    if (el.classList.contains('expand-btn')) {
      g.collapsed = false
      saveGroups(groups)
      return renderTable()
    }

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
  const groups = loadGroups()
  const g = groups.find(g => g.id === parseInt(input.dataset.groupId))
  if (!g) return
  g.name = input.value.trim() || input.dataset.saved || g.name
  input.value = g.name
  saveGroups(groups)
}

function renderTable() {
  const container = document.getElementById('table-container')
  tableStale = false

  updateStatusCounts()

  const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
  const grabDisabled = currentSort !== 'custom' && hasCustomOrder

  const sortedTargets = getSortedTargets()
  const groups = currentSort === 'custom' ? loadGroups() : []
  const plan = buildRowPlan(sortedTargets, groups)

  const rows = plan.map(entry => {
    if (entry.type === 'group-collapsed') return renderCollapsedGroupRow(entry.group, grabDisabled)

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
        <td class="bracket-cell" data-row="${label}"></td>
        <td>
          <div class="grab-handle ${grabDisabled ? 'grab-handle-disabled' : ''}">
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
          <th></th>
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
  `

  setupBracketDrag(container)

  let draggedRow = null

  function moveDraggedTo(e, targetRow) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!draggedRow || targetRow === draggedRow) return
    if (targetRow.parentNode !== draggedRow.parentNode) return
    const rect = targetRow.getBoundingClientRect()
    const anchor = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5 ? targetRow.nextSibling : targetRow
    targetRow.parentNode.insertBefore(draggedRow, anchor)
  }

  container.querySelectorAll('tr[data-row]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })

    row.setAttribute('draggable', 'true')

    row.addEventListener('dragstart', (e) => {
      const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
      if (currentSort !== 'custom' && hasCustomOrder) {
        e.preventDefault()
        showToast("Switch to 'Custom' sorting to drag and reorder items.", "error")
        return
      }
      if (!dragAllowed) {
        e.preventDefault()
        return
      }
      draggedRow = row
      isDragging = true
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    const handle = row.querySelector('.grab-handle')
    if (handle) {
      handle.addEventListener('click', () => {
        const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
        if (currentSort !== 'custom' && hasCustomOrder) {
          showToast("Switch to 'Custom' sorting to drag and reorder items.", "error")
        }
      })
    }

    row.addEventListener('dragend', () => {
      if (draggedRow) {
        draggedRow.classList.remove('dragging')
        const label = draggedRow.dataset.row
        draggedRow = null
        isDragging = false
        saveCustomOrder()
        autoJoinGroup(label)
      } else {
        isDragging = false
      }
    })

    row.addEventListener('dragover', (e) => moveDraggedTo(e, row))
  })

  container.querySelectorAll('tr[data-group-id]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })
    row.setAttribute('draggable', 'true')
    row.addEventListener('dragstart', (e) => {
      if (currentSort !== 'custom') { e.preventDefault(); return }
      if (!dragAllowed) { e.preventDefault(); return }
      draggedRow = row
      isDragging = true
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })
    row.addEventListener('dragend', () => {
      if (draggedRow) {
        draggedRow.classList.remove('dragging')
        draggedRow = null
      }
      isDragging = false
      saveCustomOrder()
      if (tableStale) renderTable()
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

function autoJoinGroup(label) {
  if (currentSort !== 'custom') return
  const tbody = document.querySelector('table tbody')
  if (!tbody) return
  const row = tbody.querySelector(`tr[data-row="${CSS.escape(label)}"]`)
  if (!row) return

  let groups = loadGroups()

  // Remove from current group if it's in one
  const currentGroup = groups.find(g => g.labels.includes(label))
  if (currentGroup) {
    groups = groups
      .map(g => g.id === currentGroup.id ? { ...g, labels: g.labels.filter(l => l !== label) } : g)
      .filter(g => g.labels.length >= 2)
    saveGroups(groups)
  }

  // Only auto-join if both immediate neighbors are regular item rows in the same group
  const prev = row.previousElementSibling
  const next = row.nextElementSibling
  if (!prev?.dataset?.row || !next?.dataset?.row) { renderTable(); return }

  const labelToGroup = new Map()
  for (const g of groups) for (const l of g.labels) labelToGroup.set(l, g)

  const prevGroup = labelToGroup.get(prev.dataset.row)
  const nextGroup = labelToGroup.get(next.dataset.row)
  if (!prevGroup || !nextGroup || prevGroup.id !== nextGroup.id) { renderTable(); return }

  groups = groups.map(g => g.id === prevGroup.id ? { ...g, labels: [...g.labels, label] } : g)
  saveGroups(groups)
  renderTable()
}

function saveCustomOrder() {
  const groups = loadGroups()
  const seenGroupIds = new Set()
  const rowLabels = []
  for (const row of document.querySelectorAll('table tbody tr')) {
    if (row.dataset.row) {
      rowLabels.push(row.dataset.row)
    } else if (row.dataset.groupId) {
      const gid = parseInt(row.dataset.groupId)
      if (seenGroupIds.has(gid)) continue
      seenGroupIds.add(gid)
      const g = groups.find(g => g.id === gid)
      if (g) rowLabels.push(...g.labels)
    }
  }
  if (currentSort !== 'custom') {
    const oldCustomOrder = localStorage.getItem(`maintainer_custom_order_${networkId}`)
    const oldSortMode = currentSort
    currentSort = 'custom'
    localStorage.setItem('maintainer_sort_mode', 'custom')
    const select = document.getElementById('sort-select')
    if (select) select.value = 'custom'
    
    showToast('Switched to Custom sorting.', 'success', {
      text: 'Undo',
      callback: () => {
        currentSort = oldSortMode
        localStorage.setItem('maintainer_sort_mode', oldSortMode)
        if (oldCustomOrder) {
          localStorage.setItem(`maintainer_custom_order_${networkId}`, oldCustomOrder)
        } else {
          localStorage.removeItem(`maintainer_custom_order_${networkId}`)
        }
        const select2 = document.getElementById('sort-select')
        if (select2) select2.value = oldSortMode
        renderTable()
        showToast('Reverted sort changes.', 'success')
      }
    })
  }
  localStorage.setItem(`maintainer_custom_order_${networkId}`, JSON.stringify(rowLabels))
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
    if (networks === null) { showLogin(); return }
    networkId = networks[0] || 'main'
    await Promise.all([fetchTargets(), fetchStock(), fetchRegistry(), fetchSettings()])
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
