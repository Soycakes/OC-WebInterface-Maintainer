import Database from 'better-sqlite3'

const db = new Database('data.db')

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    threshold INTEGER,
    batch_size INTEGER NOT NULL DEFAULT 1,
    fluid_tag TEXT,
    is_fluid INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS stock (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS catalog (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (network_id, label)
  );
`)

const queries = {
  getTargets: db.prepare('SELECT * FROM targets WHERE network_id = ?'),
  upsertStock: db.prepare(
    'INSERT INTO stock (network_id, label, count) VALUES (?, ?, ?) ON CONFLICT(network_id, label) DO UPDATE SET count = excluded.count'
  ),
  upsertCatalog: db.prepare(
    'INSERT OR IGNORE INTO catalog (network_id, label) VALUES (?, ?)'
  )
}

export function getTargets(networkId) {
  return queries.getTargets.all(networkId)
}

export function updateStock(networkId, stock) {
  const run = db.transaction(() => {
    for (const [label, count] of Object.entries(stock)) {
      queries.upsertStock.run(networkId, label, count)
    }
  })
  run()
}

export function updateCatalog(networkId, labels) {
  const run = db.transaction(() => {
    for (const label of labels) {
      queries.upsertCatalog.run(networkId, label)
    }
  })
  run()
}
