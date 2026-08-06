const app = document.getElementById('app')

let networkId = null
let targets = []
let stock = {}
let networks = []
const timers = {}

async function fetchNetworks() {
  const res = await fetch('/api/networks')
  return res.json()
}

async function fetchTargets() {
  const res = await fetch(`/api/targets/${networkId}`)
  targets = await res.json()
}

async function fetchStock() {
  const res = await fetch(`/api/stock/${networkId}`)
  stock = await res.json()
}

async function saveTarget(label, data) {
  await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
}

async function addTarget(label, threshold, batchSize, isFluid) {
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
}

async function removeTarget(label) {
  await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
    method: 'DELETE'
  })
  await fetchTargets()
  render()
}

function scheduleUpdate(label, getData) {
  clearTimeout(timers[label])
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
      updateStockCells()
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
    if (cell) cell.textContent = stock[t.label] ?? 0
  }
}

function render() {
  app.innerHTML = `
    <div>
      <h1>OC Level Maintainer</h1>
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

    return `
      <tr>
        <td>${t.label}</td>
        <td id="stock-${t.label}">${count}</td>
        <td>
          <input
            type="number"
            value="${thresholdVal}"
            placeholder="blank = infinite"
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

function renderAddRow() {
  const container = document.getElementById('add-row')
  container.innerHTML = `
    <p>
      <input id="add-label" type="text" placeholder="Item label">
      <input id="add-threshold" type="number" placeholder="Threshold (blank = infinite)">
      <input id="add-batch" type="number" placeholder="Batch size" value="1">
      <label><input id="add-fluid" type="checkbox"> Fluid</label>
      <button id="add-btn">Add</button>
    </p>
  `

  document.getElementById('add-btn').onclick = () => {
    const label = document.getElementById('add-label').value.trim()
    if (!label) return
    addTarget(
      label,
      document.getElementById('add-threshold').value,
      document.getElementById('add-batch').value || 1,
      document.getElementById('add-fluid').checked
    )
  }
}

async function init() {
  networks = await fetchNetworks()
  networkId = networks[0] || 'main'
  await Promise.all([fetchTargets(), fetchStock()])
  render()
  connectWs()
}

init()
