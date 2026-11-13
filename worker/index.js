import { DurableObject } from 'cloudflare:workers'
import { openDatabase } from './db.js'

export default {
  fetch(request, env) {
    if (!env.LOCAL && (!env.BROWSER_PASSWORD || !env.API_KEY)) {
      return new Response('Set BROWSER_PASSWORD and API_KEY in your Cloudflare Worker settings (Settings > Variables and Secrets), then reload.', { status: 503 })
    }
    return env.MAINTAINER.get(env.MAINTAINER.idFromName('main')).fetch(request)
  }
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const AUDIT_SETTLE_MS = 60000
const MAX_EMITTER_RULES = 10

const encoder = new TextEncoder()
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers })
const empty = status => new Response(null, { status })

function withEmitters(targets) {
  return targets.map(t => ({ ...t, emitter: t.emitter ? JSON.parse(t.emitter) : null }))
}

function parseEmitter(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) return null
  const rules = []
  for (const r of value.rules.slice(0, MAX_EMITTER_RULES)) {
    const amount = Math.floor(Number(r?.amount))
    if (typeof r?.label !== 'string' || !r.label.trim() || !Number.isFinite(amount) || amount < 0) continue
    rules.push({ label: r.label, is_fluid: Boolean(r.is_fluid), amount, below: Boolean(r.below) })
  }
  if (rules.length === 0) return null
  return JSON.stringify({ mode: value.mode === 'or' ? 'or' : 'and', rules })
}

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
    enabled: enabled !== false,
    emitter: parseEmitter(body.emitter)
  }
}

function parseUsername(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name.length <= 32 ? name : null
}

function labelList(value) {
  return Array.isArray(value) && value.length <= 5000 && value.every(l => typeof l === 'string') ? value : null
}

function parseCookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return v
  }
  return null
}

const routes = [
  ['POST', '/api/sync', 'sync', false],
  ['POST', '/api/login', 'login', false],
  ['GET', '/api/auth', 'authInfo', false],
  ['POST', '/api/logout', 'logout', false],
  ['GET', '/api/me', 'me'],
  ['PUT', '/api/me', 'changeName'],
  ['GET', '/api/networks', 'networks'],
  ['GET', '/api/targets/:networkId', 'listTargets'],
  ['POST', '/api/targets/:networkId', 'addTarget'],
  ['PUT', '/api/targets/:networkId/bulk', 'importTargets'],
  ['POST', '/api/targets/:networkId/enabled', 'setEnabled'],
  ['PUT', '/api/targets/:networkId/:label', 'saveTarget'],
  ['PUT', '/api/targets/:networkId/:label/emitter', 'saveEmitter'],
  ['PUT', '/api/targets/:networkId/:label/item', 'changeItem'],
  ['DELETE', '/api/targets/:networkId/:label', 'removeTarget'],
  ['GET', '/api/groups/:networkId', 'listGroups'],
  ['POST', '/api/groups/:networkId', 'addGroup'],
  ['PUT', '/api/groups/:networkId/:id', 'renameGroup'],
  ['DELETE', '/api/groups/:networkId/:id', 'removeGroup'],
  ['POST', '/api/layout/:networkId/move', 'moveLayout'],
  ['PUT', '/api/layout/:networkId', 'saveLayout'],
  ['GET', '/api/audit/:networkId', 'history'],
  ['GET', '/api/stock/:networkId', 'listStock'],
  ['GET', '/api/settings/:networkId', 'getSettings'],
  ['PUT', '/api/settings/:networkId', 'saveSettings']
].map(([method, path, handler, signedIn = true]) => ({ method, parts: path.split('/'), handler, signedIn }))

function findRoute(method, pathname) {
  const parts = pathname.split('/')
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== parts.length) continue
    const params = {}
    const matched = route.parts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(parts[i])
        return true
      }
      return part === parts[i]
    })
    if (matched) return { route, params }
  }
  return null
}

export class Maintainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.db = openDatabase(ctx.storage)
    this.stock = {}
    this.lastStatus = {}
    this.lastSync = {}
    this.syncReply = {}
  }

  get password() {
    return this.env.BROWSER_PASSWORD || ''
  }

  async signingKey() {
    this.key ??= crypto.subtle.importKey('raw', encoder.encode(this.password || 'no-password'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    return this.key
  }

  async sessionCookie(username, secure) {
    const payload = toBase64Url(encoder.encode(JSON.stringify({ u: username, t: Date.now() })))
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await this.signingKey(), encoder.encode(payload)))
    return `session=${payload}.${toBase64Url(signature)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`
  }

  async sessionUser(request) {
    const [payload, signature] = (parseCookie(request, 'session') ?? '').split('.')
    if (!payload || !signature) return null
    try {
      const valid = await crypto.subtle.verify('HMAC', await this.signingKey(), fromBase64Url(signature), encoder.encode(payload))
      if (!valid) return null
      const { u, t } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
      if (Date.now() - t > SESSION_MS) return null
      return typeof u === 'string' ? u : null
    } catch {
      return null
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return empty(426)
      if (!await this.sessionUser(request)) return empty(401)
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    const found = findRoute(request.method, url.pathname)
    if (!found) return empty(404)
    const req = { request, url, params: found.params, body: {}, secure: url.protocol === 'https:' }
    if (found.route.signedIn) {
      req.user = await this.sessionUser(request)
      if (!req.user) return empty(401)
    }
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      req.body = await request.json().catch(() => ({}))
    }
    return this[found.route.handler](req)
  }

  webSocketClose(ws, code) {
    try { ws.close(code) } catch {}
  }

  broadcast(data) {
    const message = JSON.stringify(data)
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message) } catch {}
    }
  }

  broadcastTargets(networkId) {
    delete this.syncReply[networkId]
    this.broadcast({ type: 'targets', network_id: networkId, targets: withEmitters(this.db.getTargets(networkId)), groups: this.db.getGroups(networkId) })
  }

  readState(networkId, label) {
    if (label === null) return this.db.getSettings(networkId).maintainer_sleep
    const t = this.db.getTarget(networkId, label)
    if (!t) return null
    return { threshold: t.threshold, batch_size: t.batch_size, enabled: t.enabled !== 0, emitter: t.emitter ? JSON.parse(t.emitter) : null }
  }

  noteChange(req, label) {
    const networkId = req.params.networkId
    const key = JSON.stringify([networkId, label])
    const pending = this.db.getPendingAudit(key)
    const users = new Set(pending ? JSON.parse(pending.users) : [])
    users.add(req.user)
    const now = Date.now()
    this.db.savePendingAudit({
      key,
      network_id: networkId,
      label,
      before: pending ? pending.before : JSON.stringify(this.readState(networkId, label)),
      users: JSON.stringify([...users]),
      at: now,
      due: now + AUDIT_SETTLE_MS
    })
    this.scheduleAuditFlush()
  }

  scheduleAuditFlush() {
    const due = this.db.nextAuditDue()
    if (due === null) this.ctx.storage.deleteAlarm()
    else this.ctx.storage.setAlarm(due)
  }

  flushChange(key) {
    const entry = this.db.getPendingAudit(key)
    if (!entry) return
    this.db.deletePendingAudit(key)
    const before = JSON.parse(entry.before)
    const after = this.readState(entry.network_id, entry.label)
    if (JSON.stringify(after) === JSON.stringify(before)) return
    const user = JSON.parse(entry.users).join(', ')
    if (entry.label === null) {
      this.db.audit(entry.network_id, user, 'edit', { field: 'check interval', old_value: before, new_value: after, at: entry.at })
    } else {
      const text = state => state && JSON.stringify(state)
      this.db.audit(entry.network_id, user, 'change', { label: entry.label, old_value: text(before), new_value: text(after), at: entry.at })
    }
  }

  flushPending(networkId) {
    for (const key of this.db.pendingAuditKeys(networkId, Number.MAX_SAFE_INTEGER)) this.flushChange(key)
    this.scheduleAuditFlush()
  }

  alarm() {
    for (const key of this.db.pendingAuditKeys(null, Date.now())) this.flushChange(key)
    this.scheduleAuditFlush()
  }

  sync(req) {
    if (this.env.API_KEY && req.request.headers.get('Authorization') !== `Bearer ${this.env.API_KEY}`) {
      return json({ error: 'unauthorized' }, 401)
    }
    const { network_id, stock, status } = req.body
    if (!network_id) return json({ error: 'network_id required' }, 400)
    const now = Date.now()
    if (this.lastSync[network_id] && now - this.lastSync[network_id] < 2000) return empty(429)
    this.lastSync[network_id] = now

    const resend = !(network_id in this.lastStatus)
    const statusText = JSON.stringify(status)
    if (stock) Object.assign(this.stock[network_id] ??= {}, stock)
    if (stock || statusText !== this.lastStatus[network_id]) {
      this.lastStatus[network_id] = statusText
      this.broadcast({ type: 'stock', network_id, stock: stock ?? {}, status })
    }
    if (resend) return json({ ...this.syncBody(network_id), resend_stock: true })
    this.syncReply[network_id] ??= JSON.stringify(this.syncBody(network_id))
    return new Response(this.syncReply[network_id], { headers: { 'Content-Type': 'application/json' } })
  }

  syncBody(networkId) {
    const targets = this.db.getTargets(networkId)
      .filter(t => t.enabled !== 0)
      .map(t => ({
        label: t.label,
        threshold: t.threshold,
        batch_size: t.batch_size,
        fluid_tag: t.fluid_tag,
        is_fluid: t.is_fluid,
        emitter: t.emitter ? JSON.parse(t.emitter) : undefined
      }))
    return { targets, maintainer_sleep: this.db.getSettings(networkId).maintainer_sleep }
  }

  async login(req) {
    const username = parseUsername(req.body?.username)
    if (!username) return json({ error: 'username required' }, 400)
    if (this.password && req.body.password !== this.password) return json({ error: 'wrong password' }, 401)
    return json({ username }, 200, { 'Set-Cookie': await this.sessionCookie(username, req.secure) })
  }

  authInfo() {
    return json({ password: !!this.password })
  }

  logout() {
    return json({ ok: true }, 200, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' })
  }

  me(req) {
    return json({ username: req.user })
  }

  async changeName(req) {
    const username = parseUsername(req.body?.username)
    if (!username) return json({ error: 'username required' }, 400)
    return json({ username }, 200, { 'Set-Cookie': await this.sessionCookie(username, req.secure) })
  }

  networks() {
    return json([...new Set([...Object.keys(this.stock), ...this.db.getNetworks()])])
  }

  listTargets(req) {
    return json(withEmitters(this.db.getTargets(req.params.networkId)))
  }

  addTarget(req) {
    const { label } = req.body
    if (!label || typeof label !== 'string' || !label.trim()) return json({ error: 'label required' }, 400)
    const target = parseTarget(req.body)
    if (!target) return json({ error: 'invalid threshold or batch_size' }, 400)
    this.noteChange(req, target.label)
    this.db.upsertTarget(req.params.networkId, target)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  importTargets(req) {
    const incoming = req.body?.targets
    if (!Array.isArray(incoming)) return json({ error: 'targets array required' }, 400)
    const parsed = []
    for (const item of incoming) {
      const t = parseTarget(item)
      if (!t) return json({ error: `invalid target: ${item?.label}` }, 400)
      parsed.push(t)
    }
    this.flushPending(req.params.networkId)
    this.db.replaceTargets(req.params.networkId, parsed)
    this.db.audit(req.params.networkId, req.user, 'import', { new_value: parsed.length })
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  setEnabled(req) {
    const labels = labelList(req.body?.labels)
    if (!labels?.length) return json({ error: 'labels required' }, 400)
    for (const label of labels) this.noteChange(req, label)
    this.db.setEnabled(req.params.networkId, labels, req.body.enabled !== false)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  saveTarget(req) {
    const target = parseTarget({ ...req.body, label: req.params.label })
    if (!target) return json({ error: 'invalid threshold or batch_size' }, 400)
    this.noteChange(req, target.label)
    this.db.upsertTarget(req.params.networkId, target)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  saveEmitter(req) {
    const { networkId, label } = req.params
    const before = this.db.getTarget(networkId, label)
    if (!before) return json({ error: 'unknown target' }, 404)
    const emitter = parseEmitter(req.body)
    if (emitter !== before.emitter) {
      this.noteChange(req, label)
      this.db.setEmitter(networkId, label, emitter)
      this.broadcastTargets(networkId)
    }
    return json({ ok: true })
  }

  changeItem(req) {
    const { networkId, label } = req.params
    const newLabel = req.body?.label
    if (typeof newLabel !== 'string' || !newLabel.trim()) return json({ error: 'label required' }, 400)
    if (!this.db.getTarget(networkId, label)) return json({ error: 'unknown target' }, 404)
    if (this.db.getTarget(networkId, newLabel)) return json({ error: 'already in the list' }, 409)
    this.flushPending(networkId)
    this.db.renameTarget(networkId, label, newLabel, req.body.is_fluid)
    this.db.audit(networkId, req.user, 'replace', { label: newLabel, old_value: label })
    this.broadcastTargets(networkId)
    return json({ ok: true })
  }

  removeTarget(req) {
    const { networkId, label } = req.params
    if (this.db.getTarget(networkId, label)) {
      this.noteChange(req, label)
      this.db.deleteTarget(networkId, label)
    }
    this.broadcastTargets(networkId)
    return json({ ok: true })
  }

  listGroups(req) {
    return json(this.db.getGroups(req.params.networkId))
  }

  addGroup(req) {
    const labels = labelList(req.body?.labels)
    if (!labels || labels.length < 2) return json({ error: 'at least 2 labels required' }, 400)
    this.db.createGroup(req.params.networkId, labels)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  renameGroup(req) {
    const name = String(req.body?.name ?? '').trim().slice(0, 64)
    if (!name) return json({ error: 'name required' }, 400)
    this.db.renameGroup(req.params.networkId, Number(req.params.id), name)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  removeGroup(req) {
    this.db.deleteGroup(req.params.networkId, Number(req.params.id))
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  moveLayout(req) {
    const labels = labelList(req.body?.labels)
    if (!labels?.length) return json({ error: 'labels required' }, 400)
    const before = typeof req.body.before === 'string' ? req.body.before : null
    const groupId = Number.isInteger(req.body.group_id) ? req.body.group_id : null
    this.db.moveTargets(req.params.networkId, labels, before, groupId)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  saveLayout(req) {
    const order = labelList(req.body?.order)
    const groups = req.body?.groups ?? []
    if (!order || !Array.isArray(groups)) return json({ error: 'order and groups required' }, 400)
    const parsed = []
    for (const g of groups) {
      const labels = labelList(g?.labels)
      if (!labels) return json({ error: 'invalid group' }, 400)
      parsed.push({ name: String(g.name ?? '').trim().slice(0, 64) || `Group ${parsed.length + 1}`, labels })
    }
    this.db.replaceLayout(req.params.networkId, order, parsed)
    this.broadcastTargets(req.params.networkId)
    return json({ ok: true })
  }

  history(req) {
    const before = Number(req.url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER
    return json(this.db.getAudit(req.params.networkId, before, 200))
  }

  listStock(req) {
    return json(Object.entries(this.stock[req.params.networkId] ?? {}).map(([label, count]) => ({ label, count })))
  }

  getSettings(req) {
    return json(this.db.getSettings(req.params.networkId))
  }

  saveSettings(req) {
    const sleep = Math.floor(Number(req.body.maintainer_sleep))
    if (!Number.isFinite(sleep) || sleep < 5) return json({ error: 'invalid' }, 400)
    this.noteChange(req, null)
    this.db.setSettings(req.params.networkId, { maintainer_sleep: sleep })
    delete this.syncReply[req.params.networkId]
    return json({ ok: true })
  }
}
