const app = document.getElementById('app')

const msg = {
  saving: 'Saving...',
  saved: 'Saved.',
  saveFailed: 'Save failed.',
  serverUnreachable: 'Save failed: server unreachable.',
  addFailed: 'Failed to add target: server unreachable.',
  deleteFailed: 'Failed to delete target: server unreachable.',
  serverDown: 'Failed to connect to server. Is it running?',
  loginFailed: 'Wrong password.'
}

let networkId = null
let targets = []
let stock = {}
let networks = []
let catalog = []
let registry = []
let itemStatus = {}
const timers = {}
let statusMsg = ''
let statusTimer = null
let sleepTimer = null
let maintainerSleep = 5
let pendingAdd = null

function formatCount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'b'
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function iconStyle(x, y) {
  if (x === undefined || y === undefined) return ''
  return `background-position: -${x}px -${y}px`
}

function iconHtml(x, y) {
  if (x === undefined || y === undefined) return '<span class="gtnh-icon gtnh-icon-missing"></span>'
  return `<span class="gtnh-icon" style="${iconStyle(x, y)}"></span>`
}

function setStatus(text) {
  clearTimeout(statusTimer)
  statusMsg = text
  const el = document.getElementById('status')
  if (el) el.textContent = text
  if (text) statusTimer = setTimeout(() => setStatus(''), 3000)
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

async function fetchStock() {
  const res = await fetch(`/api/stock/${networkId}`)
  const rows = await res.json()
  stock = Object.fromEntries(rows.map(r => [r.label, r.count]))
}

async function fetchCatalog() {
  const res = await fetch(`/api/catalog/${networkId}`)
  catalog = await res.json()
}

async function fetchRegistry() {
  const res = await fetch('/gtnh_registry.json')
  registry = await res.json()
}

async function fetchSettings() {
  const res = await fetch(`/api/settings/${networkId}`)
  const data = await res.json()
  maintainerSleep = data.maintainer_sleep ?? 5
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

async function saveTarget(label, data, silent = false) {
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (!silent) setStatus(res.ok ? msg.saved : msg.saveFailed)
  } catch {
    if (!silent) setStatus(msg.serverUnreachable)
  }
}

async function addTarget(label, threshold, batchSize, isFluid) {
  try {
    await fetch(`/api/targets/${networkId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        threshold: threshold === '' ? null : Number(threshold),
        batch_size: Number(batchSize),
        is_fluid: isFluid
      })
    })
    await fetchTargets()
    pendingAdd = null
    render()
  } catch {
    setStatus(msg.addFailed)
  }
}

async function removeTarget(label) {
  clearTimeout(timers[label])
  delete timers[label]
  try {
    await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, { method: 'DELETE' })
    await fetchTargets()
    render()
  } catch {
    setStatus(msg.deleteFailed)
  }
}

async function changeTargetItem(oldLabel, newLabel, newIsFluid) {
  const old = targets.find(t => t.label === oldLabel)
  try {
    await fetch(`/api/targets/${networkId}/${encodeURIComponent(oldLabel)}`, { method: 'DELETE' })
    await fetch(`/api/targets/${networkId}`, {
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
    await fetchTargets()
    render()
  } catch {
    setStatus(msg.saveFailed)
  }
}

function scheduleUpdate(label, getData) {
  clearTimeout(timers[label])
  setStatus(msg.saving)
  timers[label] = setTimeout(async () => {
    await saveTarget(label, getData())
  }, 5000)
}

function openItemPicker(onSelect) {
  const catalogSet = new Set(catalog)

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
      <div class="picker-item" data-label="${i.label}" data-fluid="${i.is_fluid}" title="${i.label}">
        ${iconHtml(i.x, i.y)}
        <span class="picker-item-name">${i.label}</span>
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
    if (!q) {
      const catalogItems = registry.filter(i => catalogSet.has(i.label))
      renderResults(catalogItems)
      return
    }
    const lower = q.toLowerCase()
    const results = registry
      .filter(i => i.label.toLowerCase().includes(lower))
      .sort((a, b) => {
        const ac = catalogSet.has(a.label) ? 0 : 1
        const bc = catalogSet.has(b.label) ? 0 : 1
        return ac - bc
      })
    renderResults(results)
  }

  search('')
  searchInput.addEventListener('input', () => search(searchInput.value.trim()))

  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  searchInput.focus()
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.network_id !== networkId) return

    if (msg.type === 'stock') {
      Object.assign(stock, msg.stock)
      if (msg.status) itemStatus = msg.status
      updateStockCells()
    }
    if (msg.type === 'catalog') {
      catalog = msg.catalog
    }
    if (msg.type === 'targets') {
      targets = msg.targets
      Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k] })
      render()
    }
  }

  ws.onclose = () => setTimeout(connectWs, 3000)
}

function updateStockCells() {
  for (const t of targets) {
    const cell = document.getElementById(`stock-${t.label}`)
    if (cell) {
      const count = stock[t.label]
      cell.textContent = count === undefined ? '...' : formatCount(count)
      cell.title = count === undefined ? 'Loading...' : String(count)
    }
    const row = document.querySelector(`tr[data-row="${CSS.escape(t.label)}"]`)
    if (row) row.className = rowStatusClass(t.label, t)
  }
}

function render() {
  app.innerHTML = `
    <div>
      <div class="page-header">
        <h1>OC Level Maintainer</h1>
        <label class="sleep-setting">Check every <input id="sleep-input" type="number" min="1" value="${maintainerSleep}"> s</label>
      </div>
      <p id="status">${statusMsg}</p>
      <div id="network-bar"></div>
      <div id="table-container"></div>
    </div>
  `

  document.getElementById('sleep-input').addEventListener('input', (e) => {
    const val = Math.max(1, Math.floor(Number(e.target.value)))
    if (!val) return
    clearTimeout(sleepTimer)
    sleepTimer = setTimeout(async () => {
      await fetch(`/api/settings/${networkId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintainer_sleep: val })
      })
      maintainerSleep = val
    }, 2000)
  })

  renderNetworkBar()
  renderTable()
}

function renderNetworkBar() {
  const bar = document.getElementById('network-bar')

  if (networks.length <= 1) return

  bar.innerHTML = `
    <label>Network:
      <select id="network-select">
        ${networks.map(n => `<option value="${n}"${n === networkId ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
  `

  document.getElementById('network-select').onchange = async (e) => {
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k] })
    networkId = e.target.value
    await Promise.all([fetchTargets(), fetchStock(), fetchCatalog()])
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

function renderTable() {
  const container = document.getElementById('table-container')

  const rows = targets.map(t => {
    const count = stock[t.label]
    const stockDisplay = count === undefined ? '...' : formatCount(count)
    const stockTitle = count === undefined ? 'Loading...' : String(count)
    const thresholdVal = t.threshold === null ? '' : t.threshold
    const batchVal = t.batch_size ?? 1
    const enabled = t.enabled !== 0
    const opacity = enabled ? '' : 'style="opacity:0.35"'

    return `
      <tr data-row="${t.label}" class="${rowStatusClass(t.label, t)}" ${opacity}>
        <td>
          <button class="mc-toggle ${enabled ? 'mc-toggle-on' : 'mc-toggle-off'}" data-toggle="${t.label}">
            ${enabled ? 'Enabled' : 'Disabled'}
          </button>
        </td>
        <td>
          <div class="item-slot" data-change="${t.label}">
            ${iconHtml(t.x, t.y)}
            <span>${t.label}</span>
          </div>
        </td>
        <td id="stock-${t.label}" title="${stockTitle}">${stockDisplay}</td>
        <td>
          <input type="number" value="${thresholdVal}" placeholder="infinite"
            data-label="${t.label}" data-field="threshold">
        </td>
        <td>
          <input type="number" value="${batchVal}"
            data-label="${t.label}" data-field="batch_size">
        </td>
        <td>
          <button data-delete="${t.label}">Delete</button>
        </td>
      </tr>
    `
  }).join('')

  const slotHtml = pendingAdd
    ? `<div class="item-slot item-slot-pick" id="add-slot">${iconHtml(pendingAdd.x, pendingAdd.y)}<span>${pendingAdd.label}</span></div>`
    : `<div class="item-slot item-slot-empty" id="add-slot">Click to select item</div>`

  const addRow = `
    <tr>
      <td></td>
      <td>${slotHtml}</td>
      <td></td>
      <td><input id="add-threshold" type="number" placeholder="infinite" ${pendingAdd ? '' : 'disabled'}></td>
      <td><input id="add-batch" type="number" placeholder="1" value="1" ${pendingAdd ? '' : 'disabled'}></td>
      <td><button id="add-btn" ${pendingAdd ? '' : 'disabled'}>Add</button></td>
    </tr>
  `

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Item</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Batch size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}${addRow}</tbody>
    </table>
  `

  container.querySelectorAll('input[data-field]').forEach(input => {
    const handler = () => {
      const label = input.dataset.label
      scheduleUpdate(label, () => getRowData(label))
    }
    input.addEventListener('input', handler)
    input.addEventListener('change', handler)
  })

  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => removeTarget(btn.dataset.delete))
  })

  container.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.toggle
      const t = targets.find(t => t.label === label)
      if (!t) return
      saveTarget(label, { ...getRowData(label), enabled: t.enabled === 0 }, true)
        .then(fetchTargets)
        .then(render)
    })
  })

  container.querySelectorAll('[data-change]').forEach(slot => {
    slot.addEventListener('click', () => {
      const label = slot.dataset.change
      openItemPicker(({ label: newLabel, is_fluid }) => {
        if (newLabel !== label) changeTargetItem(label, newLabel, is_fluid)
      })
    })
  })

  document.getElementById('add-slot').onclick = () => {
    openItemPicker(item => {
      const reg = registry.find(i => i.label === item.label)
      pendingAdd = { ...item, x: reg?.x, y: reg?.y }
      renderTable()
    })
  }

  if (pendingAdd) {
    document.getElementById('add-btn').onclick = () => {
      addTarget(
        pendingAdd.label,
        document.getElementById('add-threshold').value,
        document.getElementById('add-batch').value || 1,
        pendingAdd.is_fluid
      )
    }
  }
}

function getRowData(label) {
  const thresholdInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="threshold"]`)
  const batchInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="batch_size"]`)
  const target = targets.find(t => t.label === label)

  return {
    threshold: thresholdInput.value === '' ? null : Number(thresholdInput.value),
    batch_size: Number(batchInput.value),
    is_fluid: target?.is_fluid ?? false
  }
}

async function init() {
  try {
    networks = await fetchNetworks()
    if (networks === null) { showLogin(); return }
    networkId = networks[0] || 'main'
    await Promise.all([fetchTargets(), fetchStock(), fetchCatalog(), fetchRegistry(), fetchSettings()])
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
