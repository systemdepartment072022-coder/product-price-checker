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
Set that override in the ignored `.dev.vars` file before starting `worker:dev`:

```dotenv
DEV_MODE=true
```

For local login testing instead, set `DEV_MODE=false`, `ADMIN_EMAILS`, `ADMIN_PASSWORD_HASH`, and `SESSION_SECRET` in `.dev.vars`.

## Data design

- Amounts are stored as integer centavos.
- LPAT is calculated as `LPBT * 1.12`, rounded to the nearest centavo.
- LPBT per-piece price is calculated from LPBT per-case price divided by pack size, rounded to the nearest centavo.
- Price revisions create batch history and mark only one batch as current.
- Deactivated products remain in D1 and disappear from public search.
- Administrators can permanently delete products and their associated price history.
- Batch IDs are generated automatically. Brand and category choices are maintained in Product Management.

## Authentication

Production admin login uses the Worker secrets `ADMIN_PASSWORD_HASH` and `SESSION_SECRET`. The password hash is PBKDF2-HMAC-SHA-256 (600,000 iterations); the source generator prompts without echoing the password:

```bash
npm run admin:hash
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
```

Paste only the generated hash value into the `ADMIN_PASSWORD_HASH` prompt. Generate a random session secret with Node and enter it at the next prompt:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `DEV_MODE="false"` and configure `ADMIN_EMAILS` with a comma-separated administrator allowlist in Cloudflare Worker Variables (the current value is in `wrangler.toml`):

```toml
[vars]
DEV_MODE = "false"
ADMIN_EMAILS = "admin@example.com,manager@example.com"
```

Apply the authentication migration before deploying:

```bash
npx wrangler d1 migrations apply product-price-checker-db --remote
npm run deploy
```

The password is never stored in the frontend or D1. D1 stores revocable session-token hashes and short-lived hashed login-attempt identifiers. Admin sessions use an HttpOnly, Secure, SameSite=Strict cookie, expire after 30 minutes idle or 12 hours absolute, and are invalidated on logout or when the password hash changes. All admin API routes validate the session; public product search remains available. The Worker serves the frontend and API on the same origin. If you move the frontend to a separate host, proxy it through the Worker or add an exact-origin CORS configuration before deploying there.

The generated password hash is shared by all addresses in `ADMIN_EMAILS`. Use an email-specific credential table if administrators need separate passwords.

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
