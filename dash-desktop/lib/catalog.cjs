const { hash } = require("./packs.cjs");

function clean(value, label, limit, required = false) {
  if (value == null) value = "";
  if (typeof value !== "string") throw Error("Invalid " + label + ".");
  const text = value.trim();
  if ((required && !text) || text.length > limit)
    throw Error("Enter " + label + " (up to " + limit + " characters).");
  return text;
}

function metadata(input) {
  if (!input || typeof input !== "object") throw Error("Enter dataset metadata.");
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20) throw Error("Choose up to 20 tags.");
  const parentId = clean(input.parentId, "parent snapshot", 200);
  return {
    industry: clean(input.industry || "Unclassified", "an industry", 100, true),
    family: clean(input.family, "a dataset family", 160, true),
    category: clean(input.category, "a category", 100, true),
    tags: [...new Set(tags.map(t => clean(t, "a tag", 50, true).toLowerCase()))].sort(),
    source: clean(input.source, "a source", 500),
    changeNote: clean(input.changeNote, "a change note", 1200, !!parentId),
    parentId: parentId || null,
  };
}

class Catalog {
  constructor(db, packs) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS dataset_catalog (
      dataset_id TEXT PRIMARY KEY REFERENCES datasets(id), pack TEXT NOT NULL,
      family_key TEXT NOT NULL, version TEXT NOT NULL, split TEXT NOT NULL,
      metadata TEXT NOT NULL, origin TEXT NOT NULL,
      UNIQUE(pack, family_key, version, split))`);
    db.prepare("UPDATE dataset_catalog SET metadata=json_set(metadata,'$.industry', CASE WHEN origin='bundled' AND pack='earnings' THEN 'Financial Services' WHEN origin='bundled' AND pack='support' THEN 'Cross-industry' ELSE 'Unclassified' END) WHERE json_type(metadata,'$.industry') IS NULL").run();
    const missing = db.prepare(`SELECT d.* FROM datasets d LEFT JOIN dataset_catalog c
      ON c.dataset_id=d.id WHERE c.dataset_id IS NULL ORDER BY d.rowid`).all();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const d of missing) {
        const rows = JSON.parse(d.rows);
        const bundle = packs.find(b => b.pack.id === d.pack);
        const bundled = bundle && d.id === d.pack + "-" + hash(bundle.rows);
        this.register(d.id, d.pack, rows[0], bundled ? {
          industry: bundle.pack.industry || (d.pack === "earnings" ? "Financial Services" : "Cross-industry"), family: bundle.pack.dataset, category: bundle.pack.title, tags: ["synthetic"],
          source: "Bundled with DASH", changeNote: "Initial development cases."
        } : { family: d.name, category: "Uncategorized", source: d.name }, bundled ? "bundled" : "legacy");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  register(id, pack, first, input, origin) {
    const m = metadata(input);
    const version = first.dataset_version, split = first.split;
    let key = m.family.toLowerCase();
    const same = this.db.prepare("SELECT metadata,origin FROM dataset_catalog WHERE dataset_id=?").get(id);
    if (same && (origin !== "import" || same.metadata === JSON.stringify(m))) return;
    if (same && same.origin !== "legacy")
      throw Error("These exact cases already have a catalog entry. Open the existing snapshot to see its metadata.");
    if (m.parentId) {
      const parent = this.db.prepare("SELECT pack,family_key FROM dataset_catalog WHERE dataset_id=?").get(m.parentId);
      if (m.parentId === id || parent?.pack !== pack || parent.family_key !== key)
        throw Error("Choose a parent snapshot from the same scenario and family.");
    }
    if (same && m.parentId) {
      let ancestor = m.parentId;
      const seen = new Set([id]);
      while (ancestor) {
        if (seen.has(ancestor)) throw Error("A parent link cannot form a cycle.");
        seen.add(ancestor);
        ancestor = this.get(ancestor)?.parentId;
      }
    }
    const slot = this.db.prepare("SELECT dataset_id FROM dataset_catalog WHERE pack=? AND family_key=? AND version=? AND split=?");
    const existing = slot.get(pack, key, version, split);
    if (existing && existing.dataset_id !== id) {
      if (origin !== "legacy")
        throw Error("This family already contains that version and split. Give changed cases a new dataset_version in the JSONL.");
      m.family += " · " + id.slice(-10);
      key = m.family.toLowerCase();
    }
    if (same) {
      // Once a snapshot has descendants their stored family must stay consistent.
      const child = this.db.prepare("SELECT 1 FROM dataset_catalog WHERE json_extract(metadata,'$.parentId')=? LIMIT 1").get(id);
      if (child && JSON.parse(same.metadata).family.toLowerCase() !== key)
        throw Error("This snapshot already has child versions in its family.");
    }
    this.db.prepare(`INSERT INTO dataset_catalog VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(dataset_id) DO UPDATE SET family_key=excluded.family_key,metadata=excluded.metadata,origin=excluded.origin`)
      .run(id, pack, key, version, split, JSON.stringify(m), origin);
  }
  get(id) {
    const record = this.db.prepare("SELECT metadata FROM dataset_catalog WHERE dataset_id=?").get(id);
    return record ? JSON.parse(record.metadata) : null;
  }
}
module.exports = { Catalog };
