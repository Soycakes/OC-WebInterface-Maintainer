const AUDIT_CAP = 30000

export function openDatabase(storage) {
  const sql = storage.sql
  const all = (query, ...args) => sql.exec(query, ...args).toArray()
  const first = (query, ...args) => all(query, ...args)[0]
  const run = (query, ...args) => { all(query, ...args) }
  const transaction = fn => storage.transactionSync(fn)

  sql.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      network_id TEXT NOT NULL,
      label TEXT NOT NULL,
      threshold INTEGER,
      batch_size INTEGER NOT NULL DEFAULT 1,
      fluid_tag TEXT,
      is_fluid INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      group_id INTEGER,
      emitter TEXT,
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
    CREATE TABLE IF NOT EXISTS pending_audit (
      key TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      label TEXT,
      before TEXT,
      users TEXT NOT NULL,
      at INTEGER NOT NULL,
      due INTEGER NOT NULL
    );
  `)

  const getTargets = networkId => all('SELECT * FROM targets WHERE network_id = ? ORDER BY position ASC, rowid ASC', networkId)
  const getTarget = (networkId, label) => first('SELECT * FROM targets WHERE network_id = ? AND label = ?', networkId, label)
  const getGroup = (networkId, id) => first('SELECT id, name FROM groups WHERE network_id = ? AND id = ?', networkId, id)
  const setPosition = (networkId, label, position) => run('UPDATE targets SET position = ? WHERE network_id = ? AND label = ?', position, networkId, label)
  const setGroup = (networkId, label, groupId) => run('UPDATE targets SET group_id = ? WHERE network_id = ? AND label = ?', groupId, networkId, label)
  const insertGroup = (networkId, id, name) => run('INSERT INTO groups (network_id, id, name) VALUES (?, ?, ?)', networkId, id, name)

  function pruneGroups(networkId) {
    run(`
      DELETE FROM groups WHERE network_id = ? AND id NOT IN (
        SELECT group_id FROM targets WHERE network_id = ? AND group_id IS NOT NULL
        GROUP BY group_id HAVING COUNT(*) >= 2
      )
    `, networkId, networkId)
    run(`
      UPDATE targets SET group_id = NULL WHERE network_id = ? AND group_id IS NOT NULL
        AND group_id NOT IN (SELECT id FROM groups WHERE network_id = ?)
    `, networkId, networkId)
  }

  function upsertTarget(networkId, target) {
    run(`
      INSERT INTO targets (network_id, label, threshold, batch_size, fluid_tag, is_fluid, enabled, emitter, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM targets WHERE network_id = ?))
      ON CONFLICT(network_id, label) DO UPDATE SET
        threshold = excluded.threshold,
        batch_size = excluded.batch_size,
        fluid_tag = excluded.fluid_tag,
        is_fluid = excluded.is_fluid,
        enabled = excluded.enabled
    `,
      networkId, target.label, target.threshold ?? null, target.batch_size ?? 1, target.fluid_tag ?? null,
      target.is_fluid ? 1 : 0, target.enabled === false ? 0 : 1, target.emitter ?? null, networkId)
  }

  return {
    getTargets,
    getTarget,
    upsertTarget,

    setEmitter(networkId, label, emitter) {
      run('UPDATE targets SET emitter = ? WHERE network_id = ? AND label = ?', emitter, networkId, label)
    },

    renameTarget(networkId, label, newLabel, isFluid) {
      run('UPDATE targets SET label = ?, is_fluid = ? WHERE network_id = ? AND label = ?', newLabel, isFluid ? 1 : 0, networkId, label)
    },

    setEnabled(networkId, labels, enabled) {
      transaction(() => {
        for (const label of labels) run('UPDATE targets SET enabled = ? WHERE network_id = ? AND label = ?', enabled ? 1 : 0, networkId, label)
      })
    },

    deleteTarget(networkId, label) {
      transaction(() => {
        run('DELETE FROM targets WHERE network_id = ? AND label = ?', networkId, label)
        pruneGroups(networkId)
      })
    },

    replaceTargets(networkId, targets) {
      transaction(() => {
        run('DELETE FROM targets WHERE network_id = ?', networkId)
        run('DELETE FROM groups WHERE network_id = ?', networkId)
        for (const t of targets) upsertTarget(networkId, t)
      })
    },

    getGroups(networkId) {
      return all('SELECT id, name FROM groups WHERE network_id = ? ORDER BY id', networkId)
    },

    moveTargets(networkId, labels, before, groupId) {
      transaction(() => {
        const moving = new Set(labels)
        const rows = getTargets(networkId)
        const movers = rows.filter(r => moving.has(r.label))
        const rest = rows.filter(r => !moving.has(r.label))
        const at = rest.findIndex(r => r.label === before)
        rest.splice(at === -1 ? rest.length : at, 0, ...movers)
        rest.forEach((r, i) => setPosition(networkId, r.label, i + 1))
        const keep = groupId !== null && getGroup(networkId, groupId) ? groupId : null
        for (const r of movers) setGroup(networkId, r.label, keep)
        pruneGroups(networkId)
      })
    },

    createGroup(networkId, labels) {
      transaction(() => {
        const rows = getTargets(networkId).filter(r => labels.includes(r.label))
        const existing = rows.map(r => r.group_id).find(id => id !== null)
        const id = first('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM groups WHERE network_id = ?', networkId).id
        const name = (existing && getGroup(networkId, existing)?.name) || `Group ${id}`
        insertGroup(networkId, id, name)
        for (const r of rows) setGroup(networkId, r.label, id)
        pruneGroups(networkId)
      })
    },

    renameGroup(networkId, id, name) {
      run('UPDATE groups SET name = ? WHERE network_id = ? AND id = ?', name, networkId, id)
    },

    deleteGroup(networkId, id) {
      transaction(() => {
        run('DELETE FROM groups WHERE network_id = ? AND id = ?', networkId, id)
        pruneGroups(networkId)
      })
    },

    replaceLayout(networkId, order, groups) {
      transaction(() => {
        const rank = new Map(order.map((label, i) => [label, i]))
        const rows = getTargets(networkId)
        rows.sort((a, b) => (rank.get(a.label) ?? Infinity) - (rank.get(b.label) ?? Infinity))
        rows.forEach((r, i) => {
          setPosition(networkId, r.label, i + 1)
          setGroup(networkId, r.label, null)
        })
        run('DELETE FROM groups WHERE network_id = ?', networkId)
        groups.forEach((g, i) => {
          insertGroup(networkId, i + 1, g.name)
          for (const label of g.labels) setGroup(networkId, label, i + 1)
        })
        pruneGroups(networkId)
      })
    },

    audit(networkId, user, action, entry = {}) {
      const text = value => value == null ? null : String(value)
      run(`
        INSERT INTO audit (network_id, at, user, action, label, field, old_value, new_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, networkId, entry.at ?? Date.now(), user, action, entry.label ?? null, entry.field ?? null, text(entry.old_value), text(entry.new_value))
      run('DELETE FROM audit WHERE id <= last_insert_rowid() - ?', AUDIT_CAP)
    },

    getAudit(networkId, beforeId, limit) {
      return all('SELECT * FROM audit WHERE network_id = ? AND id < ? ORDER BY id DESC LIMIT ?', networkId, beforeId, limit)
    },

    getPendingAudit(key) {
      return first('SELECT * FROM pending_audit WHERE key = ?', key)
    },

    savePendingAudit(entry) {
      run(`
        INSERT INTO pending_audit (key, network_id, label, before, users, at, due) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET users = excluded.users, at = excluded.at, due = excluded.due
      `, entry.key, entry.network_id, entry.label, entry.before, entry.users, entry.at, entry.due)
    },

    deletePendingAudit(key) {
      run('DELETE FROM pending_audit WHERE key = ?', key)
    },

    pendingAuditKeys(networkId, dueBy) {
      return all('SELECT key FROM pending_audit WHERE (? IS NULL OR network_id = ?) AND due <= ?', networkId, networkId, dueBy).map(r => r.key)
    },

    nextAuditDue() {
      return first('SELECT MIN(due) AS due FROM pending_audit').due
    },

    getNetworks() {
      return all('SELECT network_id FROM targets UNION SELECT network_id FROM settings').map(r => r.network_id)
    },

    getSettings(networkId) {
      return first('SELECT maintainer_sleep FROM settings WHERE network_id = ?', networkId) ?? { maintainer_sleep: 10 }
    },

    setSettings(networkId, settings) {
      run(`
        INSERT INTO settings (network_id, maintainer_sleep) VALUES (?, ?)
        ON CONFLICT(network_id) DO UPDATE SET maintainer_sleep = excluded.maintainer_sleep
      `, networkId, settings.maintainer_sleep)
    }
  }
}
