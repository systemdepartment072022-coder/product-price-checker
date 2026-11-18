CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL,
  barcode TEXT,
  item_description TEXT NOT NULL,
  grammage TEXT,
  pack_size INTEGER,
  brand TEXT,
  category TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  date_added TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  date_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  remarks TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_item_code ON products(item_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE INDEX IF NOT EXISTS idx_products_description ON products(item_description);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS price_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  lpbt_price_case INTEGER NOT NULL,
  lpbt_price_pcs INTEGER NOT NULL,
  lpat_price_case INTEGER NOT NULL,
  lpat_price_pcs INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  expiration_date TEXT,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  remarks TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_batch ON price_batches(product_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_batches_effective ON price_batches(effective_date);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  batch_id TEXT,
  action TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  modified_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
