CREATE TABLE IF NOT EXISTS catalog_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('brand', 'category')),
  value TEXT NOT NULL,
  UNIQUE (type, value COLLATE NOCASE)
);

INSERT OR IGNORE INTO catalog_values (type, value)
SELECT 'brand', TRIM(brand)
FROM products
WHERE brand IS NOT NULL AND TRIM(brand) <> '';

INSERT OR IGNORE INTO catalog_values (type, value)
SELECT 'category', TRIM(category)
FROM products
WHERE category IS NOT NULL AND TRIM(category) <> '';
