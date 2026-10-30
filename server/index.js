import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
const itemRegistry = JSON.parse(readFileSync(resolve(dir, '../client/public/gtnh_registry.json'), 'utf8'))
const iconMap = new Map(itemRegistry.map(i => [i.label, { x: i.x, y: i.y }]))

function withIcons(targets) {
  return targets.map(t => ({ ...t, ...iconMap.get(t.label) }))
}
import {
  getTargets, getTarget, upsertTarget, deleteTarget, replaceTargets,
  getGroups, moveTargets, createGroup, renameGroup, deleteGroup, replaceLayout,
  audit, getAudit,
  getStock, getNetworks,
  updateStock,
  getSettings, setSettings
} from './db.js'

if (!process.env.BROWSER_PASSWORD) {
  console.log('WARNING : No BROWSER_PASSWORD in .env, anyone can access the page with link!')
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const sessionSecret = process.env.BROWSER_PASSWORD || 'no-password'

function parseCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return v
  }
  return null
}

function sign(payload) {
  return createHmac('sha256', sessionSecret).update(payload).digest('base64url')
}

function issueSession(res, username) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString('base64url')
  res.cookie('session', `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS })
}

function sessionUser(req) {
  const [payload, sig] = (parseCookie(req, 'session') ?? '').split('.')
  if (!payload || !sig) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (Date.now() - t > SESSION_MS) return null
    return typeof u === 'string' ? u : null
  } catch { return null }
}

function parseUsername(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name.length <= 32 ? name : null
}

function browserAuth(req, res, next) {
  req.user = sessionUser(req)
  if (!req.user) return res.status(401).end()
  next()
}

const app = express()
app.use(express.json())
app.use(express.static('public'))

const server = createServer(app)
const wss = new WebSocketServer({ server })

const lastSync = {}
const lastStockStr = {}

function rateLimit(req, res, next) {
  const id = req.body?.network_id
  if (!id) return next()
  const now = Date.now()
  if (lastSync[id] && now - lastSync[id] < 2000) {
    return res.status(429).end()
  }
  lastSync[id] = now
  next()
}

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

function broadcastTargets(networkId) {
  broadcast({ type: 'targets', network_id: networkId, targets: withIcons(getTargets(networkId)), groups: getGroups(networkId) })
}

app.post('/api/sync', auth, rateLimit, (req, res) => {
  const { network_id, stock, status } = req.body
  if (!network_id) return res.status(400).json({ error: 'network_id required' })
  if (stock) {
    const str = JSON.stringify({ stock, status })
    if (str !== lastStockStr[network_id]) {
      lastStockStr[network_id] = str
      updateStock(network_id, stock)
      broadcast({ type: 'stock', network_id, stock, status })
    }
  }
  const settings = getSettings(network_id)
  const ocTargets = getTargets(network_id)
    .filter(t => t.enabled !== 0)
    .map(t => ({
      label: t.label,
      threshold: t.threshold,
      batch_size: t.batch_size,
      fluid_tag: t.fluid_tag,
      is_fluid: t.is_fluid
    }))
  res.json({ targets: ocTargets, maintainer_sleep: settings.maintainer_sleep })
})

app.post('/api/login', (req, res) => {
  const username = parseUsername(req.body?.username)
  if (!username) return res.status(400).json({ error: 'username required' })
  if (process.env.BROWSER_PASSWORD && req.body.password !== process.env.BROWSER_PASSWORD) {
    return res.status(401).json({ error: 'wrong password' })
  }
  issueSession(res, username)
  res.json({ username })
})

app.get('/api/auth', (req, res) => {
  res.json({ password: !!process.env.BROWSER_PASSWORD })
})

app.get('/api/me', browserAuth, (req, res) => {
  res.json({ username: req.user })
})

app.put('/api/me', browserAuth, (req, res) => {
  const username = parseUsername(req.body?.username)
  if (!username) return res.status(400).json({ error: 'username required' })
  issueSession(res, username)
  res.json({ username })
})

app.post('/api/logout', (req, res) => {
  res.clearCookie('session')
  res.json({ ok: true })
})

app.get('/api/networks', browserAuth, (req, res) => {
  res.json(getNetworks())
})

app.get('/api/targets/:networkId', browserAuth, (req, res) => {
  res.json(withIcons(getTargets(req.params.networkId)))
})

function parseTarget(body) {
  const { label, threshold, batch_size, fluid_tag, is_fluid, enabled } = body
  const parsedThreshold = threshold === null || threshold === undefined || threshold === '' ? null : Number(threshold)
  const parsedBatch = Number(batch_size ?? 1)
  if (parsedThreshold !== null && !Number.isFinite(parsedThreshold)) return null
  if (!Number.isFinite(parsedBatch) || parsedBatch < 1) return null
  return {
    label,
    threshold: parsedThreshold,
    batch_size: Math.floor(parsedBatch),
    fluid_tag: fluid_tag ?? null,
    is_fluid: Boolean(is_fluid),
    enabled: enabled !== false
  }
}

function auditChanges(req, before, after) {
  const id = req.params.networkId
  for (const field of ['threshold', 'batch_size']) {
    if (before[field] !== after[field]) {
      audit(id, req.user, 'edit', { label: after.label, field, old_value: before[field], new_value: after[field] })
    }
  }
  if ((before.enabled !== 0) !== after.enabled) {
    audit(id, req.user, after.enabled ? 'enable' : 'disable', { label: after.label })
  }
}

app.post('/api/targets/:networkId', browserAuth, (req, res) => {
  const { label } = req.body
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label required' })
  }
  const target = parseTarget(req.body)
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  const before = getTarget(req.params.networkId, target.label)
  upsertTarget(req.params.networkId, target)
  if (before) auditChanges(req, before, target)
  else audit(req.params.networkId, req.user, 'create', { label: target.label, new_value: target.threshold })
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.put('/api/targets/:networkId/bulk', browserAuth, (req, res) => {
  const incoming = req.body?.targets
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'targets array required' })
  const parsed = []
  for (const item of incoming) {
    const t = parseTarget(item)
    if (!t) return res.status(400).json({ error: `invalid target: ${item?.label}` })
    parsed.push(t)
  }
  replaceTargets(req.params.networkId, parsed)
  audit(req.params.networkId, req.user, 'import', { new_value: parsed.length })
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.put('/api/targets/:networkId/:label', browserAuth, (req, res) => {
  const target = parseTarget({ ...req.body, label: req.params.label })
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  const before = getTarget(req.params.networkId, target.label)
  upsertTarget(req.params.networkId, target)
  if (before) auditChanges(req, before, target)
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.delete('/api/targets/:networkId/:label', browserAuth, (req, res) => {
  if (getTarget(req.params.networkId, req.params.label)) {
    deleteTarget(req.params.networkId, req.params.label)
    audit(req.params.networkId, req.user, 'remove', { label: req.params.label })
  }
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

function labelList(value) {
  return Array.isArray(value) && value.length <= 5000 && value.every(l => typeof l === 'string') ? value : null
}

app.get('/api/groups/:networkId', browserAuth, (req, res) => {
  res.json(getGroups(req.params.networkId))
})

app.post('/api/groups/:networkId', browserAuth, (req, res) => {
  const labels = labelList(req.body?.labels)
  if (!labels || labels.length < 2) return res.status(400).json({ error: 'at least 2 labels required' })
  createGroup(req.params.networkId, labels)
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.put('/api/groups/:networkId/:id', browserAuth, (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 64)
  if (!name) return res.status(400).json({ error: 'name required' })
  renameGroup(req.params.networkId, Number(req.params.id), name)
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.delete('/api/groups/:networkId/:id', browserAuth, (req, res) => {
  deleteGroup(req.params.networkId, Number(req.params.id))
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.post('/api/layout/:networkId/move', browserAuth, (req, res) => {
  const labels = labelList(req.body?.labels)
  if (!labels?.length) return res.status(400).json({ error: 'labels required' })
  const before = typeof req.body.before === 'string' ? req.body.before : null
  const groupId = Number.isInteger(req.body.group_id) ? req.body.group_id : null
  moveTargets(req.params.networkId, labels, before, groupId)
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.put('/api/layout/:networkId', browserAuth, (req, res) => {
  const order = labelList(req.body?.order)
  const groups = req.body?.groups ?? []
  if (!order || !Array.isArray(groups)) return res.status(400).json({ error: 'order and groups required' })
  const parsed = []
  for (const g of groups) {
    const labels = labelList(g?.labels)
    if (!labels) return res.status(400).json({ error: 'invalid group' })
    parsed.push({ name: String(g.name ?? '').trim().slice(0, 64) || `Group ${parsed.length + 1}`, labels })
  }
  replaceLayout(req.params.networkId, order, parsed)
  broadcastTargets(req.params.networkId)
  res.json({ ok: true })
})

app.get('/api/audit/:networkId', browserAuth, (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER
  res.json(getAudit(req.params.networkId, before, 200))
})

app.get('/api/stock/:networkId', browserAuth, (req, res) => {
  res.json(getStock(req.params.networkId))
})

app.get('/api/settings/:networkId', browserAuth, (req, res) => {
  res.json(getSettings(req.params.networkId))
})

app.put('/api/settings/:networkId', browserAuth, (req, res) => {
  const sleep = Math.floor(Number(req.body.maintainer_sleep))
  if (!Number.isFinite(sleep) || sleep < 5) return res.status(400).json({ error: 'invalid' })
  const old = getSettings(req.params.networkId).maintainer_sleep
  setSettings(req.params.networkId, { maintainer_sleep: sleep })
  if (old !== sleep) audit(req.params.networkId, req.user, 'edit', { field: 'check interval', old_value: old, new_value: sleep })
  res.json({ ok: true })
})

wss.on('connection', (ws, req) => {
  if (!sessionUser(req)) return ws.close(4001, 'unauthorized')
  ws.on('error', console.error)
})

const port = process.env.PORT || 3000
server.listen(port, () => console.log(`running on http://localhost:${port}`))
