# Product Price Checker

A mobile-responsive React application for product search, Philippine Peso discount calculations, product administration, price batch history, CSV import/export, and Cloudflare D1 storage.

## Local setup

```bash
npm install
npx wrangler login
npx wrangler d1 create product-price-checker-db
```

Copy the database ID printed by Wrangler into `wrangler.toml`, then migrate:

```bash
npx wrangler d1 migrations apply product-price-checker-db --local
npm run worker:dev
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. Local development uses `DEV_MODE=true` and allows administrative API calls.

## Data design

- Amounts are stored as integer centavos.
- LPAT is calculated as `LPBT * 1.12`, rounded to the nearest centavo.
- LPBT per-piece price is calculated from LPBT per-case price divided by pack size, rounded to the nearest centavo.
- Price revisions create batch history and mark only one batch as current.
- Deactivated products remain in D1 and disappear from public search.
- Administrators can permanently delete products and their associated price history.
- Batch IDs are generated automatically. Brand and category choices are maintained in Product Management.

## Authentication

Set `DEV_MODE="false"` and configure `ADMIN_EMAILS` with a comma-separated administrator allowlist for production:

```toml
[vars]
DEV_MODE = "false"
ADMIN_EMAILS = "admin@example.com,manager@example.com"
```

Administrative API endpoints require the Cloudflare Access `CF-Access-Authenticated-User-Email` header and an allowed email. Public search and product detail endpoints remain accessible.

## Cloudflare deployment

```bash
npx wrangler d1 migrations apply product-price-checker-db
npm run deploy
```

Make sure the `database_id` in `wrangler.toml` matches your Cloudflare D1 database. Migration `0003_catalog_values.sql` creates and seeds the brand/category lists.

## CSV template

`sample-import.csv` demonstrates the supported import columns:

`item_code,item_description,grammage,pack_size,brand,category,lpbt_price_case,effective_date,remarks`

Barcode and generated batch ID are not import fields. LPBT per-piece price is calculated from the case price and pack size.
