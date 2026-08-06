import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import {
  getTargets, upsertTarget, deleteTarget,
  getStock, getCatalog, getNetworks,
  updateStock, updateCatalog
} from './db.js'

const app = express()
app.use(express.json())
app.use(express.static('public'))

const server = createServer(app)
const wss = new WebSocketServer({ server })

function auth(req, res, next) {
  const key = process.env.API_KEY
  if (!key) return next()
  if (req.headers.authorization !== `Bearer ${key}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

function broadcast(data) {
  const message = JSON.stringify(data)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message)
  }
}

app.post('/api/sync', auth, (req, res) => {
  const { network_id, stock, catalog } = req.body
  if (!network_id) return res.status(400).json({ error: 'network_id required' })
  if (stock) updateStock(network_id, stock)
  if (catalog) updateCatalog(network_id, catalog)
  if (stock) broadcast({ type: 'stock', network_id, stock })
  res.json({ targets: getTargets(network_id) })
})

app.get('/api/networks', (req, res) => {
  res.json(getNetworks())
})

app.get('/api/targets/:networkId', (req, res) => {
  res.json(getTargets(req.params.networkId))
})

app.post('/api/targets/:networkId', (req, res) => {
  const { label, threshold, batch_size, fluid_tag, is_fluid } = req.body
  if (!label) return res.status(400).json({ error: 'label required' })
  upsertTarget(req.params.networkId, { label, threshold, batch_size, fluid_tag, is_fluid })
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: getTargets(req.params.networkId) })
  res.json({ ok: true })
})

app.put('/api/targets/:networkId/:label', (req, res) => {
  const { threshold, batch_size, fluid_tag, is_fluid } = req.body
  upsertTarget(req.params.networkId, {
    label: req.params.label,
    threshold, batch_size, fluid_tag, is_fluid
  })
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: getTargets(req.params.networkId) })
  res.json({ ok: true })
})

app.delete('/api/targets/:networkId/:label', (req, res) => {
  deleteTarget(req.params.networkId, req.params.label)
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: getTargets(req.params.networkId) })
  res.json({ ok: true })
})

app.get('/api/stock/:networkId', (req, res) => {
  res.json(getStock(req.params.networkId))
})

app.get('/api/catalog/:networkId', (req, res) => {
  res.json(getCatalog(req.params.networkId))
})

wss.on('connection', (ws) => {
  ws.on('error', console.error)
})

const port = process.env.PORT || 3000
server.listen(port, () => console.log(`running on http://localhost:${port}`))
