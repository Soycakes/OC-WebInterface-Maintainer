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
let sleepInterval = null
const timers = {}
let statusMsg = ''

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

function setStatus(msg) {
  statusMsg = msg
  const el = document.getElementById('status')
  if (el) el.textContent = msg
}

async function fetchNetworks() {
  const res = await fetch('/api/networks')
  if (res.status === 401) return null
  return res.json()
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

async function fetchTargets() {
  const res = await fetch(`/api/targets/${networkId}`)
  targets = await res.json()
}

async function fetchStock() {
  const res = await fetch(`/api/stock/${networkId}`)
  const rows = await res.json()
  stock = Object.fromEntries(rows.map(r => [r.label, r.count]))
}

async function saveTarget(label, data) {
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    setStatus(res.ok ? msg.saved : msg.saveFailed)
  } catch {
    setStatus(msg.serverUnreachable)
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
    render()
  } catch {
    setStatus(msg.addFailed)
  }
}

async function removeTarget(label) {
  clearTimeout(timers[label])
  delete timers[label]
  try {
    await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
      method: 'DELETE'
    })
    await fetchTargets()
    render()
  } catch {
    setStatus(msg.deleteFailed)
  }
}

function scheduleUpdate(label, getData) {
  clearTimeout(timers[label])
  setStatus(msg.saving)
  timers[label] = setTimeout(async () => {
    await saveTarget(label, getData())
  }, 5000)
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.network_id !== networkId) return

    if (msg.type === 'stock') {
      stock = msg.stock
      if (msg.sleep) sleepInterval = msg.sleep
      updateStockCells()
      const el = document.getElementById('sleep-interval')
      if (el) el.textContent = sleepInterval ? `Syncing every ${sleepInterval}s` : ''
    }
    if (msg.type === 'targets') {
      targets = msg.targets
      render()
    }
  }

  ws.onclose = () => setTimeout(connectWs, 3000)
}

function updateStockCells() {
  for (const t of targets) {
    const cell = document.getElementById(`stock-${t.label}`)
    if (cell) {
      const count = stock[t.label] ?? 0
      cell.textContent = formatCount(count)
      cell.title = String(count)
    }
  }
}

function render() {
  app.innerHTML = `
    <div>
      <h1>OC Level Maintainer</h1>
      <p id="status">${statusMsg}</p>
      <p id="sleep-interval">${sleepInterval ? `Syncing every ${sleepInterval}s` : ''}</p>
      <div id="network-bar"></div>
      <div id="table-container"></div>
      <div id="add-row"></div>
    </div>
  `

  renderNetworkBar()
  renderTable()
  renderAddRow()
}

function renderNetworkBar() {
  const bar = document.getElementById('network-bar')

  if (networks.length <= 1) {
    bar.innerHTML = `<p>Network: <strong>${networkId}</strong></p>`
    return
  }

  bar.innerHTML = `
    <label>Network:
      <select id="network-select">
        ${networks.map(n => `<option value="${n}"${n === networkId ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
  `

  document.getElementById('network-select').onchange = async (e) => {
    networkId = e.target.value
    await Promise.all([fetchTargets(), fetchStock()])
    render()
  }
}

function renderTable() {
  const container = document.getElementById('table-container')

  const rows = targets.map(t => {
    const count = stock[t.label] ?? 0
    const thresholdVal = t.threshold === null ? '' : t.threshold
    const batchVal = t.batch_size ?? 1
    const icon = t.x !== undefined
      ? `<span class="gtnh-icon" style="${iconStyle(t.x, t.y)}"></span>`
      : ''

    return `
      <tr>
        <td>${icon} ${t.label}</td>
        <td id="stock-${t.label}" title="${count}">${formatCount(count)}</td>
        <td>
          <input
            type="number"
            value="${thresholdVal}"
            placeholder="infinite"
            data-label="${t.label}"
            data-field="threshold"
          >
        </td>
        <td>
          <input
            type="number"
            value="${batchVal}"
            data-label="${t.label}"
            data-field="batch_size"
          >
        </td>
        <td>
          <input
            type="checkbox"
            ${t.is_fluid ? 'checked' : ''}
            data-label="${t.label}"
            data-field="is_fluid"
          >
        </td>
        <td>
          <button data-delete="${t.label}">Delete</button>
        </td>
      </tr>
    `
  }).join('')

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Batch size</th>
          <th>Fluid</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `

  container.querySelectorAll('input[data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const label = input.dataset.label
      scheduleUpdate(label, () => getRowData(label))
    })
    input.addEventListener('change', () => {
      const label = input.dataset.label
      scheduleUpdate(label, () => getRowData(label))
    })
  })

  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => removeTarget(btn.dataset.delete))
  })
}

function getRowData(label) {
  const thresholdInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="threshold"]`)
  const batchInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="batch_size"]`)
  const fluidInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="is_fluid"]`)

  return {
    threshold: thresholdInput.value === '' ? null : Number(thresholdInput.value),
    batch_size: Number(batchInput.value),
    is_fluid: fluidInput.checked
  }
}

let searchTimer = null

function renderAddRow() {
  const container = document.getElementById('add-row')
  container.innerHTML = `
    <div style="position:relative;display:inline-block">
      <input id="add-label" type="text" placeholder="Item label" autocomplete="off">
      <ul id="search-dropdown" style="display:none;position:absolute;z-index:10;background:#222;list-style:none;margin:0;padding:0;width:100%;max-height:200px;overflow-y:auto"></ul>
    </div>
    <input id="add-threshold" type="number" placeholder="Threshold (blank = infinite)">
    <input id="add-batch" type="number" placeholder="Batch size" value="1">
    <label><input id="add-fluid" type="checkbox"> Fluid</label>
    <button id="add-btn">Add</button>
  `

  const labelInput = document.getElementById('add-label')
  const dropdown = document.getElementById('search-dropdown')

  labelInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    const q = labelInput.value.trim()
    if (!q) { dropdown.style.display = 'none'; return }
    searchTimer = setTimeout(async () => {
      const res = await fetch(`/api/items/search?q=${encodeURIComponent(q)}`)
      const items = await res.json()
      if (!items.length) { dropdown.style.display = 'none'; return }
      dropdown.innerHTML = items.map(i => {
        const style = iconStyle(i.x, i.y)
        return `<li data-label="${i.label}" data-fluid="${i.is_fluid}" style="cursor:pointer;padding:4px 8px;display:flex;align-items:center;gap:6px">
          <span class="gtnh-icon" style="${style}"></span>${i.label}
        </li>`
      }).join('')
      dropdown.style.display = 'block'
    }, 200)
  })

  dropdown.addEventListener('click', e => {
    const li = e.target.closest('li')
    if (!li) return
    labelInput.value = li.dataset.label
    document.getElementById('add-fluid').checked = li.dataset.fluid === 'true'
    dropdown.style.display = 'none'
  })

  document.addEventListener('click', e => {
    if (!container.contains(e.target)) dropdown.style.display = 'none'
  }, { once: false })

  document.getElementById('add-btn').onclick = () => {
    const label = document.getElementById('add-label').value.trim()
    if (!label) return
    dropdown.style.display = 'none'
    addTarget(
      label,
      document.getElementById('add-threshold').value,
      document.getElementById('add-batch').value || 1,
      document.getElementById('add-fluid').checked
    )
  }
}

async function init() {
  try {
    networks = await fetchNetworks()
    if (networks === null) { showLogin(); return }
    networkId = networks[0] || 'main'
    await Promise.all([fetchTargets(), fetchStock()])
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
