import Database from 'better-sqlite3'

const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
const db = new Database(dataDir ? `${dataDir}/data.db` : 'data.db')

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    threshold INTEGER,
    batch_size INTEGER NOT NULL DEFAULT 1,
    fluid_tag TEXT,
    is_fluid INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS stock (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS settings (
    network_id TEXT PRIMARY KEY,
    maintainer_sleep INTEGER NOT NULL DEFAULT 10
  );

  CREATE TABLE IF NOT EXISTS groups (
    network_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (network_id, id)
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    label TEXT,
    field TEXT,
    old_value TEXT,
    new_value TEXT
  );
`)

try { db.exec(`ALTER TABLE targets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`) } catch {}
try { db.exec(`ALTER TABLE targets ADD COLUMN position INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE targets ADD COLUMN group_id INTEGER`) } catch {}

const AUDIT_CAP = 30000

const q = {
  getTargets: db.prepare('SELECT * FROM targets WHERE network_id = ? ORDER BY position ASC, rowid ASC'),
  getTarget: db.prepare('SELECT * FROM targets WHERE network_id = ? AND label = ?'),
  deleteAllTargets: db.prepare('DELETE FROM targets WHERE network_id = ?'),
  upsertTarget: db.prepare(`
    INSERT INTO targets (network_id, label, threshold, batch_size, fluid_tag, is_fluid, enabled, position)
    VALUES (@network_id, @label, @threshold, @batch_size, @fluid_tag, @is_fluid, @enabled,
      (SELECT COALESCE(MAX(position), 0) + 1 FROM targets WHERE network_id = @network_id))
    ON CONFLICT(network_id, label) DO UPDATE SET
      threshold = excluded.threshold,
      batch_size = excluded.batch_size,
      fluid_tag = excluded.fluid_tag,
      is_fluid = excluded.is_fluid,
      enabled = excluded.enabled
  `),
  deleteTarget: db.prepare('DELETE FROM targets WHERE network_id = ? AND label = ?'),
  getStock: db.prepare('SELECT * FROM stock WHERE network_id = ?'),
  getNetworks: db.prepare('SELECT DISTINCT network_id FROM stock'),
  upsertStock: db.prepare(`
    INSERT INTO stock (network_id, label, count) VALUES (?, ?, ?)
    ON CONFLICT(network_id, label) DO UPDATE SET count = excluded.count
  `),
  setPosition: db.prepare('UPDATE targets SET position = ? WHERE network_id = ? AND label = ?'),
  setGroup: db.prepare('UPDATE targets SET group_id = ? WHERE network_id = ? AND label = ?'),
  getGroups: db.prepare('SELECT id, name FROM groups WHERE network_id = ? ORDER BY id'),
  getGroup: db.prepare('SELECT id, name FROM groups WHERE network_id = ? AND id = ?'),
  nextGroupId: db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM groups WHERE network_id = ?'),
  insertGroup: db.prepare('INSERT INTO groups (network_id, id, name) VALUES (?, ?, ?)'),
  renameGroup: db.prepare('UPDATE groups SET name = ? WHERE network_id = ? AND id = ?'),
  deleteGroup: db.prepare('DELETE FROM groups WHERE network_id = ? AND id = ?'),
  deleteAllGroups: db.prepare('DELETE FROM groups WHERE network_id = ?'),
  dropThinGroups: db.prepare(`
    DELETE FROM groups WHERE network_id = ? AND id NOT IN (
      SELECT group_id FROM targets WHERE network_id = ? AND group_id IS NOT NULL
      GROUP BY group_id HAVING COUNT(*) >= 2
    )
  `),
  clearOrphans: db.prepare(`
    UPDATE targets SET group_id = NULL WHERE network_id = ? AND group_id IS NOT NULL
      AND group_id NOT IN (SELECT id FROM groups WHERE network_id = ?)
  `),
  insertAudit: db.prepare(`
    INSERT INTO audit (network_id, at, user, action, label, field, old_value, new_value)
    VALUES (@network_id, @at, @user, @action, @label, @field, @old_value, @new_value)
  `),
  pruneAudit: db.prepare(`DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ${AUDIT_CAP}`),
  getAudit: db.prepare('SELECT * FROM audit WHERE network_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
  getSettings: db.prepare('SELECT maintainer_sleep FROM settings WHERE network_id = ?'),
  setSettings: db.prepare('INSERT INTO settings (network_id, maintainer_sleep) VALUES (?, ?) ON CONFLICT(network_id) DO UPDATE SET maintainer_sleep = excluded.maintainer_sleep')
}

export function getTargets(networkId) {
  return q.getTargets.all(networkId)
}

export function upsertTarget(networkId, target) {
  q.upsertTarget.run({
    network_id: networkId,
    label: target.label,
    threshold: target.threshold ?? null,
    batch_size: target.batch_size ?? 1,
    fluid_tag: target.fluid_tag ?? null,
    is_fluid: target.is_fluid ? 1 : 0,
    enabled: target.enabled === false ? 0 : 1
  })
}

export function getTarget(networkId, label) {
  return q.getTarget.get(networkId, label)
}

export function deleteTarget(networkId, label) {
  db.transaction(() => {
    q.deleteTarget.run(networkId, label)
    pruneGroups(networkId)
  })()
}

function pruneGroups(networkId) {
  q.dropThinGroups.run(networkId, networkId)
  q.clearOrphans.run(networkId, networkId)
}

export function getGroups(networkId) {
  return q.getGroups.all(networkId)
}

export function moveTargets(networkId, labels, before, groupId) {
  db.transaction(() => {
    const moving = new Set(labels)
    const rows = q.getTargets.all(networkId)
    const movers = rows.filter(r => moving.has(r.label))
    const rest = rows.filter(r => !moving.has(r.label))
    const at = rest.findIndex(r => r.label === before)
    rest.splice(at === -1 ? rest.length : at, 0, ...movers)
    rest.forEach((r, i) => q.setPosition.run(i + 1, networkId, r.label))
    const keep = groupId !== null && q.getGroup.get(networkId, groupId) ? groupId : null
    for (const r of movers) q.setGroup.run(keep, networkId, r.label)
    pruneGroups(networkId)
  })()
}

export function createGroup(networkId, labels) {
  db.transaction(() => {
    const rows = q.getTargets.all(networkId).filter(r => labels.includes(r.label))
    const existing = rows.map(r => r.group_id).find(id => id !== null)
    const id = q.nextGroupId.get(networkId).id
    const name = (existing && q.getGroup.get(networkId, existing)?.name) || `Group ${id}`
    q.insertGroup.run(networkId, id, name)
    for (const r of rows) q.setGroup.run(id, networkId, r.label)
    pruneGroups(networkId)
  })()
}

export function renameGroup(networkId, id, name) {
  q.renameGroup.run(name, networkId, id)
}

export function deleteGroup(networkId, id) {
  db.transaction(() => {
    q.deleteGroup.run(networkId, id)
    pruneGroups(networkId)
  })()
}

export function replaceLayout(networkId, order, groups) {
  db.transaction(() => {
    const rank = new Map(order.map((label, i) => [label, i]))
    const rows = q.getTargets.all(networkId)
    rows.sort((a, b) => (rank.get(a.label) ?? Infinity) - (rank.get(b.label) ?? Infinity))
    rows.forEach((r, i) => {
      q.setPosition.run(i + 1, networkId, r.label)
      q.setGroup.run(null, networkId, r.label)
    })
    q.deleteAllGroups.run(networkId)
    groups.forEach((g, i) => {
      q.insertGroup.run(networkId, i + 1, g.name)
      for (const label of g.labels) q.setGroup.run(i + 1, networkId, label)
    })
    pruneGroups(networkId)
  })()
}

let auditWrites = 0

export function audit(networkId, user, action, entry = {}) {
  q.insertAudit.run({
    network_id: networkId,
    at: Date.now(),
    user,
    action,
    label: entry.label ?? null,
    field: entry.field ?? null,
    old_value: entry.old_value == null ? null : String(entry.old_value),
    new_value: entry.new_value == null ? null : String(entry.new_value)
  })
  if (++auditWrites % 500 === 0) q.pruneAudit.run()
}

export function getAudit(networkId, beforeId, limit) {
  return q.getAudit.all(networkId, beforeId, limit)
}

q.pruneAudit.run()

export function replaceTargets(networkId, targets) {
  db.transaction(() => {
    q.deleteAllTargets.run(networkId)
    q.deleteAllGroups.run(networkId)
    for (const t of targets) {
      q.upsertTarget.run({
        network_id: networkId,
        label: t.label,
        threshold: t.threshold ?? null,
        batch_size: t.batch_size ?? 1,
        fluid_tag: t.fluid_tag ?? null,
        is_fluid: t.is_fluid ? 1 : 0,
        enabled: t.enabled === false ? 0 : 1
      })
    }
  })()
}

export function getStock(networkId) {
  return q.getStock.all(networkId)
}

export function getNetworks() {
  return q.getNetworks.all().map(r => r.network_id)
}

export function updateStock(networkId, stock) {
  db.transaction(() => {
    for (const [label, count] of Object.entries(stock)) {
      q.upsertStock.run(networkId, label, count)
    }
  })()
}

export function getSettings(networkId) {
  return q.getSettings.get(networkId) ?? { maintainer_sleep: 10 }
}

export function setSettings(networkId, settings) {
  q.setSettings.run(networkId, settings.maintainer_sleep)
}

