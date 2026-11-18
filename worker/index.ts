export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  DEV_MODE?: string
  ADMIN_EMAILS?: string
}

type ProductInput = {
  item_code?: unknown
  item_description?: unknown
  description?: unknown
  grammage?: unknown
  pack_size?: unknown
  brand?: unknown
  category?: unknown
  remarks?: unknown
  lpbt_price_case?: unknown
  effective_date?: unknown
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })

const clean = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim()

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 })

function toCents(value: unknown): number {
  const text = clean(value)
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw badRequest(`Invalid monetary value: ${text || "(empty)"}`)
  }
  const [whole, fraction = ""] = text.split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(cents)) throw badRequest("Monetary value is too large")
  return cents
}

function parsePackSize(value: unknown): number {
  const text = clean(value)
  const packSize = Number(text)
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(packSize)) {
    throw badRequest("Pack size must be a positive whole number")
  }
  return packSize
}

const toPesos = (cents: number | null | undefined) =>
  cents == null ? null : cents / 100

const lpatCents = (lpbtCents: number) =>
  Math.round((lpbtCents * 112) / 100)

function getAdmin(request: Request, env: Env): string | null {
  if (env.DEV_MODE === "true") return "development-admin"
  const email = request.headers
    .get("cf-access-authenticated-user-email")
    ?.trim()
    .toLowerCase()
  const allowed = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (!email || !allowed.includes(email)) return null
  return email
}

function requireAdmin(request: Request, env: Env): string {
  const admin = getAdmin(request, env)
  if (!admin) throw Object.assign(new Error("Administrator access required"), { status: 403 })
  return admin
}

function productWithPrice(row: Record<string, any> | null) {
  if (!row) return null
  const product = { ...row }
  delete product.barcode
  return {
    ...product,
    lpbt_price_case: toPesos(row.lpbt_price_case),
    lpbt_price_pcs: toPesos(row.lpbt_price_pcs),
    lpat_price_case: toPesos(row.lpat_price_case),
    lpat_price_pcs: toPesos(row.lpat_price_pcs),
  }
}

async function getCurrentProduct(db: D1Database, id: number) {
  const row = await db.prepare(`
    SELECT p.*,
      b.batch_id, b.effective_date, b.lpbt_price_case, b.lpbt_price_pcs,
      b.lpat_price_case, b.lpat_price_pcs, b.remarks AS batch_remarks
    FROM products p
    LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
    WHERE p.id = ?
  `).bind(id).first<Record<string, any>>()
  return productWithPrice(row)
}

async function logActivity(
  db: D1Database,
  admin: string,
  action: string,
  productId: number | null,
  batchId: string | null,
  details: unknown
) {
  await db.prepare(`
    INSERT INTO activity_logs
      (product_id, batch_id, action, new_value, modified_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    productId,
    batchId,
    action,
    JSON.stringify(details ?? {}),
    admin
  ).run()
}

function makeBatchCode() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()
  return `BATCH-${date}-${suffix}`
}

async function createBatch(
  db: D1Database,
  admin: string,
  productId: number,
  caseCents: number,
  effectiveDate: string,
  remarks = ""
) {
  if (!effectiveDate) throw badRequest("Effective date is required")

  const product = await db.prepare(`
    SELECT id, pack_size
    FROM products
    WHERE id = ? AND is_active = 1
  `).bind(productId).first<{ id: number; pack_size: number | string | null }>()

  if (!product) throw badRequest("Active product was not found")

  const packSize = parsePackSize(product.pack_size)
  const pcsCents = Math.round(caseCents / packSize)
  const batchId = makeBatchCode()

  await db.batch([
    db.prepare(`
      UPDATE price_batches
      SET is_current = 0,
        expiration_date = CASE
          WHEN expiration_date IS NULL THEN ? ELSE expiration_date
        END
      WHERE product_id = ? AND is_current = 1
    `).bind(effectiveDate, productId),
    db.prepare(`
      INSERT INTO price_batches (
        product_id, batch_id, lpbt_price_case, lpbt_price_pcs,
        lpat_price_case, lpat_price_pcs, effective_date,
        is_current, remarks, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      productId,
      batchId,
      caseCents,
      pcsCents,
      lpatCents(caseCents),
      lpatCents(pcsCents),
      effectiveDate,
      remarks || null,
      admin
    ),
    db.prepare(`
      UPDATE products
      SET date_updated = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).bind(productId),
  ])

  await logActivity(
    db,
    admin,
    "price_batch_created",
    productId,
    batchId,
    { effective_date: effectiveDate, lpbt_price_case: caseCents }
  )

  return batchId
}

async function registerCatalog(
  db: D1Database,
  type: "brand" | "category",
  value: unknown
) {
  const text = clean(value)
  if (!text) return
  try {
    await db.prepare(`
      INSERT OR IGNORE INTO catalog_values (type, value)
      VALUES (?, ?)
    `).bind(type, text).run()
  } catch (error) {
    if (!String(error).includes("no such table")) throw error
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    try {
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request)

      if (method === "GET" && path === "/api/products/search") {
        const q = clean(url.searchParams.get("q")).toLowerCase()
        const page = Math.max(1, Number(url.searchParams.get("page") || 1))
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 12)))
        const offset = (page - 1) * limit
        if (!q) return json({ items: [], total: 0, page, limit })
        const term = `%${q}%`
        const where = `p.is_active = 1 AND (
          LOWER(p.item_code) LIKE ? OR
          LOWER(p.item_description) LIKE ? OR
          LOWER(COALESCE(p.grammage,'')) LIKE ? OR
          CAST(p.pack_size AS TEXT) LIKE ? OR
          LOWER(COALESCE(p.brand,'')) LIKE ? OR
          LOWER(COALESCE(p.category,'')) LIKE ?)`
        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count FROM products p WHERE ${where}
        `).bind(term, term, term, term, term, term).first<{ count: number }>()
        const result = await env.DB.prepare(`
          SELECT p.*,
            b.batch_id, b.effective_date,
            b.lpbt_price_case, b.lpbt_price_pcs,
            b.lpat_price_case, b.lpat_price_pcs
          FROM products p
          LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
          WHERE ${where}
          ORDER BY p.item_description COLLATE NOCASE
          LIMIT ? OFFSET ?
        `).bind(term, term, term, term, term, term, limit, offset)
          .all<Record<string, any>>()
        return json({
          items: (result.results || []).map(productWithPrice),
          total: count?.count || 0,
          page,
          limit,
        })
      }

      if (!path.startsWith("/api/admin/")) {
        return json({ error: "API endpoint not found" }, 404)
      }

      const admin = requireAdmin(request, env)

      if (method === "GET" && path === "/api/admin/lookups") {
        try {
          const result = await env.DB.prepare(`
            SELECT type, value
            FROM catalog_values
            ORDER BY type, value COLLATE NOCASE
          `).all<{ type: string; value: string }>()
          const values = { brands: [] as string[], categories: [] as string[] }
          for (const row of result.results || []) {
            if (row.type === "brand") values.brands.push(row.value)
            if (row.type === "category") values.categories.push(row.value)
          }
          return json(values)
        } catch (error) {
          if (String(error).includes("no such table")) {
            return json({
              brands: [],
              categories: [],
              warning: "Brand/category maintenance has not been migrated yet.",
            })
          }
          throw error
        }
      }

      if (method === "POST" && path === "/api/admin/lookups") {
        const body = await request.json() as { type?: string; value?: unknown }
        const type = body.type
        const value = clean(body.value)
        if (type !== "brand" && type !== "category") {
          throw badRequest("Lookup type must be brand or category")
        }
        if (!value || value.length > 100) {
          throw badRequest("Lookup value must be between 1 and 100 characters")
        }
        let inserted: D1Result
        try {
          inserted = await env.DB.prepare(`
            INSERT OR IGNORE INTO catalog_values (type, value)
            VALUES (?, ?)
          `).bind(type, value).run()
        } catch (error) {
          if (String(error).includes("no such table")) {
            throw badRequest("Catalog maintenance is not migrated. Apply 0003_catalog_values.sql first.")
          }
          throw error
        }
        if (!inserted.meta.changes) {
          throw badRequest(`That ${type} already exists`)
        }
        await logActivity(env.DB, admin, `${type}_created`, null, null, { value })
        return json({ type, value }, 201)
      }

      if (method === "DELETE" && path === "/api/admin/lookups") {
        const body = await request.json() as { type?: string; value?: unknown }
        const type = body.type
        const value = clean(body.value)
        if (type !== "brand" && type !== "category") {
          throw badRequest("Lookup type must be brand or category")
        }
        if (!value) throw badRequest("Lookup value is required")
        const column = type === "brand" ? "brand" : "category"
        const used = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM products
          WHERE LOWER(TRIM(COALESCE(${column},''))) = LOWER(?)
        `).bind(value).first<{ count: number }>()
        if (used?.count) {
          throw badRequest(`This ${type} is assigned to ${used.count} product(s) and cannot be removed`)
        }
        let deleted: D1Result
        try {
          deleted = await env.DB.prepare(`
            DELETE FROM catalog_values
            WHERE type = ? AND value = ? COLLATE NOCASE
          `).bind(type, value).run()
        } catch (error) {
          if (String(error).includes("no such table")) {
            throw badRequest("Catalog maintenance is not migrated. Apply 0003_catalog_values.sql first.")
          }
          throw error
        }
        if (!deleted.meta.changes) throw badRequest(`${type} not found`)
        await logActivity(env.DB, admin, `${type}_deleted`, null, null, { value })
        return json({ type, value })
      }

      if (method === "GET" && path === "/api/admin/products") {
        const q = clean(url.searchParams.get("q")).toLowerCase()
        const page = Math.max(1, Number(url.searchParams.get("page") || 1))
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)))
        const offset = (page - 1) * limit
        const term = `%${q}%`
        const where = q
          ? `(LOWER(p.item_code) LIKE ? OR LOWER(p.item_description) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?)`
          : "1=1"
        const binds = q ? [term, term, term] : []
        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count FROM products p WHERE ${where}
        `).bind(...binds).first<{ count: number }>()
        const result = await env.DB.prepare(`
          SELECT p.*,
            b.batch_id, b.effective_date,
            b.lpbt_price_case, b.lpbt_price_pcs,
            b.lpat_price_case, b.lpat_price_pcs
          FROM products p
          LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
          WHERE ${where}
          ORDER BY p.date_updated DESC
          LIMIT ? OFFSET ?
        `).bind(...binds, limit, offset).all<Record<string, any>>()
        return json({
          items: (result.results || []).map(productWithPrice),
          total: count?.count || 0,
          page,
          limit,
        })
      }

      const productMatch = path.match(/^\/api\/admin\/products\/(\d+)$/)
      const historyMatch = path.match(/^\/api\/admin\/products\/(\d+)\/history$/)
      const statusMatch = path.match(/^\/api\/admin\/products\/(\d+)\/status$/)

      if (method === "GET" && productMatch) {
        const product = await getCurrentProduct(env.DB, Number(productMatch[1]))
        return product ? json(product) : json({ error: "Product not found" }, 404)
      }

      if (method === "GET" && historyMatch) {
        const productId = Number(historyMatch[1])
        const result = await env.DB.prepare(`
          SELECT id AS batch_db_id, batch_id, effective_date, expiration_date,
            lpbt_price_case, lpbt_price_pcs, lpat_price_case, lpat_price_pcs,
            is_current, remarks, created_at
          FROM price_batches
          WHERE product_id = ?
          ORDER BY effective_date DESC, id DESC
        `).bind(productId).all<Record<string, any>>()
        return json((result.results || []).map((row) => ({
          ...row,
          lpbt_price_case: toPesos(row.lpbt_price_case),
          lpbt_price_pcs: toPesos(row.lpbt_price_pcs),
          lpat_price_case: toPesos(row.lpat_price_case),
          lpat_price_pcs: toPesos(row.lpat_price_pcs),
        })))
      }

      if (method === "POST" && path === "/api/admin/products") {
        const body = await request.json() as ProductInput
        const itemCode = clean(body.item_code)
        const description = clean(body.item_description ?? body.description)
        if (!itemCode || !description) {
          throw badRequest("Item code and item description are required")
        }
        const packSize = parsePackSize(body.pack_size)
        const caseCents = toCents(body.lpbt_price_case)
        const effectiveDate = clean(body.effective_date)
        if (!effectiveDate) throw badRequest("Effective date is required")

        const duplicate = await env.DB.prepare(`
          SELECT id FROM products WHERE item_code = ?
        `).bind(itemCode).first()
        if (duplicate) throw badRequest("A product already uses this item code")

        const brand = clean(body.brand)
        const category = clean(body.category)
        await registerCatalog(env.DB, "brand", brand)
        await registerCatalog(env.DB, "category", category)

        const created = await env.DB.prepare(`
          INSERT INTO products (
            item_code, item_description, grammage, pack_size,
            brand, category, remarks
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          itemCode,
          description,
          clean(body.grammage) || null,
          packSize,
          brand || null,
          category || null,
          clean(body.remarks) || null
        ).run()

        const productId = Number(created.meta.last_row_id)
        await logActivity(env.DB, admin, "product_created", productId, null, body)
        const batchId = await createBatch(
          env.DB,
          admin,
          productId,
          caseCents,
          effectiveDate,
          clean(body.remarks)
        )
        return json({
          product: await getCurrentProduct(env.DB, productId),
          batch_id: batchId,
        }, 201)
      }

      if (method === "PUT" && productMatch) {
        const id = Number(productMatch[1])
        const body = await request.json() as ProductInput
        const itemCode = clean(body.item_code)
        const description = clean(body.item_description ?? body.description)
        if (!itemCode || !description) {
          throw badRequest("Item code and item description are required")
        }
        const packSize = parsePackSize(body.pack_size)
        const duplicate = await env.DB.prepare(`
          SELECT id FROM products WHERE item_code = ? AND id <> ?
        `).bind(itemCode, id).first()
        if (duplicate) throw badRequest("Another product already uses this item code")

        const brand = clean(body.brand)
        const category = clean(body.category)
        await registerCatalog(env.DB, "brand", brand)
        await registerCatalog(env.DB, "category", category)

        const updated = await env.DB.prepare(`
          UPDATE products
          SET item_code = ?, item_description = ?, grammage = ?,
            pack_size = ?, brand = ?, category = ?, remarks = ?,
            date_updated = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?
        `).bind(
          itemCode,
          description,
          clean(body.grammage) || null,
          packSize,
          brand || null,
          category || null,
          clean(body.remarks) || null,
          id
        ).run()
        if (!updated.meta.changes) throw badRequest("Product not found")

        const current = await env.DB.prepare(`
          SELECT id, lpbt_price_case
          FROM price_batches
          WHERE product_id = ? AND is_current = 1
        `).bind(id).first<{ id: number; lpbt_price_case: number }>()
        if (current) {
          const pcsCents = Math.round(current.lpbt_price_case / packSize)
          await env.DB.prepare(`
            UPDATE price_batches
            SET lpbt_price_pcs = ?, lpat_price_pcs = ?
            WHERE id = ?
          `).bind(pcsCents, lpatCents(pcsCents), current.id).run()
        }

        await logActivity(env.DB, admin, "product_updated", id, null, body)
        return json(await getCurrentProduct(env.DB, id))
      }

      if (method === "PATCH" && statusMatch) {
        const id = Number(statusMatch[1])
        const body = await request.json() as { is_active?: boolean }
        if (typeof body.is_active !== "boolean") {
          throw badRequest("is_active must be true or false")
        }
        const updated = await env.DB.prepare(`
          UPDATE products
          SET is_active = ?,
            date_updated = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?
        `).bind(body.is_active ? 1 : 0, id).run()
        if (!updated.meta.changes) throw badRequest("Product not found")
        await logActivity(env.DB, admin, "product_status_changed", id, null, body)
        return json(await getCurrentProduct(env.DB, id))
      }

      if (method === "POST" && path === "/api/admin/batches") {
        const body = await request.json() as {
          effective_date?: string
          notes?: string
          items?: Array<{ product_id: number; lpbt_price_case: unknown }>
        }
        if (!body.items?.length) throw badRequest("At least one product is required")
        const batchIds: string[] = []
        for (const item of body.items) {
          const productId = Number(item.product_id)
          const caseCents = toCents(item.lpbt_price_case)
          batchIds.push(await createBatch(
            env.DB,
            admin,
            productId,
            caseCents,
            clean(body.effective_date),
            clean(body.notes)
          ))
        }
        return json({ batch_ids: batchIds, item_count: batchIds.length }, 201)
      }

      if (method === "POST" && path === "/api/admin/import") {
        const body = await request.json() as { rows?: ProductInput[] }
        if (!Array.isArray(body.rows)) throw badRequest("CSV rows are required")
        const summary = { imported: 0, skipped: 0, errors: [] as string[] }

        for (let index = 0; index < body.rows.length; index++) {
          const row = body.rows[index]
          try {
            const itemCode = clean(row.item_code)
            const description = clean(row.item_description ?? row.description)
            if (!itemCode || !description) {
              throw new Error("Item code and description are required")
            }
            const packSize = parsePackSize(row.pack_size)
            const caseCents = toCents(row.lpbt_price_case)
            const effectiveDate =
              clean(row.effective_date) ||
              new Date().toISOString().slice(0, 10)
            const brand = clean(row.brand)
            const category = clean(row.category)

            await registerCatalog(env.DB, "brand", brand)
            await registerCatalog(env.DB, "category", category)

            let product = await env.DB.prepare(`
              SELECT id FROM products WHERE item_code = ?
            `).bind(itemCode).first<{ id: number }>()

            if (!product) {
              const inserted = await env.DB.prepare(`
                INSERT INTO products (
                  item_code, item_description, grammage, pack_size,
                  brand, category, remarks
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).bind(
                itemCode,
                description,
                clean(row.grammage) || null,
                packSize,
                brand || null,
                category || null,
                clean(row.remarks) || null
              ).run()
              product = { id: Number(inserted.meta.last_row_id) }
            }

            await createBatch(
              env.DB,
              admin,
              product.id,
              caseCents,
              effectiveDate,
              clean(row.remarks)
            )
            summary.imported++
          } catch (error) {
            summary.skipped++
            summary.errors.push(
              `Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid row"}`
            )
          }
        }

        await logActivity(env.DB, admin, "csv_import", null, null, summary)
        return json(summary)
      }

      if (method === "GET" && path === "/api/admin/export") {
        const includeInactive = url.searchParams.get("inactive") === "true"
        const result = await env.DB.prepare(`
          SELECT p.item_code, p.item_description, p.grammage, p.pack_size,
            p.brand, p.category, p.is_active,
            b.batch_id, b.effective_date,
            b.lpbt_price_case, b.lpbt_price_pcs,
            b.lpat_price_case, b.lpat_price_pcs, b.is_current
          FROM products p
          LEFT JOIN price_batches b ON b.product_id = p.id
          ${includeInactive ? "" : "WHERE p.is_active = 1"}
          ORDER BY p.item_code, b.effective_date DESC, b.id DESC
        `).all<Record<string, any>>()

        const headers = [
          "item_code", "item_description", "grammage", "pack_size",
          "brand", "category", "is_active", "batch_id", "effective_date",
          "lpbt_price_case", "lpbt_price_pcs", "lpat_price_case",
          "lpat_price_pcs", "is_current",
        ]
        const escapeCsv = (value: unknown) => {
          const text = value == null ? "" : String(value)
          return /[",\n]/.test(text)
            ? `"${text.replaceAll('"', '""')}"`
            : text
        }
        const rows = (result.results || []).map((row) => [
          row.item_code,
          row.item_description,
          row.grammage,
          row.pack_size,
          row.brand,
          row.category,
          row.is_active,
          row.batch_id,
          row.effective_date,
          toPesos(row.lpbt_price_case),
          toPesos(row.lpbt_price_pcs),
          toPesos(row.lpat_price_case),
          toPesos(row.lpat_price_pcs),
          row.is_current,
        ].map(escapeCsv).join(","))

        return new Response([headers.join(","), ...rows].join("\n"), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="products.csv"',
            "cache-control": "no-store",
          },
        })
      }

      return json({ error: "API endpoint not found" }, 404)
    } catch (error) {
      const status = (error as { status?: number }).status || 500
      return json({
        error: error instanceof Error ? error.message : "Internal server error",
      }, status)
    }
  },
}
