
export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  DEV_MODE?: string
  ADMIN_EMAILS?: string
}

type ProductInput = {
  item_code?: unknown
  barcode?: unknown
  item_description?: unknown
  description?: unknown
  grammage?: unknown
  pack_size?: unknown
  brand?: unknown
  category?: unknown
  remarks?: unknown
  lpbt_price_case?: unknown
  lpbt_price_pcs?: unknown
  effective_date?: unknown
}

type BatchItemInput = {
  product_id: number
  lpbt_price_case: unknown
  lpbt_price_pcs: unknown
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
    throw badRequest(
      `Invalid monetary value: ${text || "(empty)"}`
    )
  }

  const [whole, fraction = ""] = text.split(".")

  const cents =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"))

  if (!Number.isSafeInteger(cents)) {
    throw badRequest("Monetary value is too large")
  }

  return cents
}

const toPesos = (
  cents: number | null | undefined
) => cents == null ? null : cents / 100

function lpatCents(lpbtCents: number): number {
  return Math.round(lpbtCents * 112 / 100)
}

function getAdmin(
  request: Request,
  env: Env
): string | null {
  if (env.DEV_MODE === "true") {
    return "development-admin"
  }

  const email = request.headers
    .get("cf-access-authenticated-user-email")
    ?.trim()
    .toLowerCase()

  const allowed = (env.ADMIN_EMAILS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)

  if (!email || !allowed.includes(email)) {
    return null
  }

  return email
}

function requireAdmin(
  request: Request,
  env: Env
): string {
  const admin = getAdmin(request, env)

  if (!admin) {
    throw Object.assign(
      new Error("Administrator access required"),
      { status: 403 }
    )
  }

  return admin
}

async function logActivity(
  db: D1Database,
  admin: string,
  action: string,
  entityType: string,
  entityId: number | null,
  details: unknown
) {
  await db.prepare(`
    INSERT INTO activity_logs (
      admin_email,
      action,
      entity_type,
      entity_id,
      details
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    admin,
    action,
    entityType,
    entityId,
    JSON.stringify(details ?? {})
  ).run()
}

function makeBatchCode(): string {
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "")

  const suffix = crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 8)
    .toUpperCase()

  return `BATCH-${date}-${suffix}`
}

function productWithPrice(
  row: Record<string, any> | null
) {
  if (!row) return null

  return {
    ...row,
    item_description: row.description,
    lpbt_price_case: toPesos(row.lpbt_case_cents),
    lpbt_price_pcs: toPesos(row.lpbt_pcs_cents),
    lpat_price_case: toPesos(row.lpat_case_cents),
    lpat_price_pcs: toPesos(row.lpat_pcs_cents),
  }
}

const CURRENT_PRICE_SELECT = `
  SELECT
    p.*,
    pb.id AS batch_db_id,
    pb.batch_code AS batch_id,
    pb.effective_date,
    pbi.lpbt_case_cents,
    pbi.lpbt_pcs_cents,
    pbi.lpat_case_cents,
    pbi.lpat_pcs_cents,
    pbi.is_current
  FROM products p
  LEFT JOIN price_batch_items pbi
    ON pbi.product_id = p.id
    AND pbi.is_current = 1
  LEFT JOIN price_batches pb
    ON pb.id = pbi.batch_id
`

async function getCurrentProduct(
  db: D1Database,
  id: number
) {
  const row = await db.prepare(`
    ${CURRENT_PRICE_SELECT}
    WHERE p.id = ?
  `).bind(id).first<Record<string, any>>()

  return productWithPrice(row)
}

async function registerCatalog(
  db: D1Database,
  type: "brand" | "category",
  value: unknown
) {
  const text = clean(value)

  if (!text) return

  await db.prepare(`
    INSERT OR IGNORE INTO catalog_values (type, value)
    VALUES (?, ?)
  `).bind(type, text).run()
}

async function createPriceBatch(
  db: D1Database,
  admin: string,
  effectiveDate: string,
  notes: string,
  items: BatchItemInput[]
) {
  if (!effectiveDate) {
    throw badRequest("Effective date is required")
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("At least one product is required")
  }

  const preparedItems: Array<{
    productId: number
    caseCents: number
    pcsCents: number
  }> = []

  const seen = new Set<number>()

  // Validate every item before creating the batch.
  for (const item of items) {
    const productId = Number(item.product_id)

    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0
    ) {
      throw badRequest("Invalid product ID")
    }

    if (seen.has(productId)) {
      throw badRequest(
        "A product cannot appear twice in one batch"
      )
    }

    seen.add(productId)

    const product = await db.prepare(`
      SELECT id
      FROM products
      WHERE id = ? AND is_active = 1
    `).bind(productId).first()

    if (!product) {
      throw badRequest(
        `Active product ${productId} was not found`
      )
    }

    preparedItems.push({
      productId,
      caseCents: toCents(item.lpbt_price_case),
      pcsCents: toCents(item.lpbt_price_pcs),
    })
  }

  // Create one batch header.
  const batchCode = makeBatchCode()

  const batchResult = await db.prepare(`
    INSERT INTO price_batches (
      batch_code,
      batch_name,
      effective_date,
      notes,
      created_by
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    batchCode,
    batchCode,
    effectiveDate,
    notes || null,
    admin
  ).run()

  const batchDbId = Number(batchResult.meta.last_row_id)

  if (
    !Number.isSafeInteger(batchDbId) ||
    batchDbId <= 0
  ) {
    throw new Error("Could not create price batch")
  }

  // Add all products to the same batch.
  const statements: D1PreparedStatement[] = []

  for (const item of preparedItems) {
    statements.push(
      db.prepare(`
        UPDATE price_batch_items
        SET is_current = 0
        WHERE product_id = ? AND is_current = 1
      `).bind(item.productId)
    )

    statements.push(
      db.prepare(`
        INSERT INTO price_batch_items (
          batch_id,
          product_id,
          lpbt_case_cents,
          lpbt_pcs_cents,
          lpat_case_cents,
          lpat_pcs_cents,
          is_current
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(
        batchDbId,
        item.productId,
        item.caseCents,
        item.pcsCents,
        lpatCents(item.caseCents),
        lpatCents(item.pcsCents)
      )
    )

    statements.push(
      db.prepare(`
        UPDATE products
        SET updated_at = datetime('now')
        WHERE id = ?
      `).bind(item.productId)
    )
  }

  await db.batch(statements)

  await logActivity(
    db,
    admin,
    "price_batch_created",
    "price_batch",
    batchDbId,
    {
      batch_code: batchCode,
      effective_date: effectiveDate,
      item_count: preparedItems.length,
    }
  )

  return {
    id: batchDbId,
    batch_code: batchCode,
    item_count: preparedItems.length,
  }
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    try {

      // ================================================
      // PUBLIC PRODUCT SEARCH
      // ================================================

      if (
        method === "GET" &&
        path === "/api/products/search"
      ) {
        const q = clean(
          url.searchParams.get("q")
        ).toLowerCase()

        const page = Math.max(
          1,
          Number(url.searchParams.get("page") || 1)
        )

        const limit = Math.min(
          50,
          Math.max(
            1,
            Number(url.searchParams.get("limit") || 12)
          )
        )

        const offset = (page - 1) * limit

        if (!q) {
          return json({
            items: [],
            total: 0,
            page,
            limit,
          })
        }

        const term = `%${q}%`

        const where = `
          p.is_active = 1
          AND (
            LOWER(p.item_code) LIKE ?
            OR LOWER(COALESCE(p.barcode,'')) LIKE ?
            OR LOWER(p.description) LIKE ?
            OR LOWER(COALESCE(p.grammage,'')) LIKE ?
            OR LOWER(COALESCE(p.pack_size,'')) LIKE ?
            OR LOWER(COALESCE(p.brand,'')) LIKE ?
            OR LOWER(COALESCE(p.category,'')) LIKE ?
          )
        `

        const binds = [
          term,
          term,
          term,
          term,
          term,
          term,
          term,
        ]

        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM products p
          WHERE ${where}
        `).bind(...binds)
          .first<{ count: number }>()

        const result = await env.DB.prepare(`
          ${CURRENT_PRICE_SELECT}
          WHERE ${where}
          ORDER BY p.description COLLATE NOCASE
          LIMIT ? OFFSET ?
        `).bind(
          ...binds,
          limit,
          offset
        ).all<Record<string, any>>()

        return json({
          items: (result.results || [])
            .map(productWithPrice),
          total: count?.count || 0,
          page,
          limit,
        })
      }

      // ================================================
      // ADMIN ROUTES
      // ================================================

      if (!path.startsWith("/api/admin/")) {
        return json({
          error: "API endpoint not found",
        }, 404)
      }

      const admin = requireAdmin(request, env)

      // ================================================
      // BRAND / CATEGORY LOOKUPS
      // ================================================

      if (
        method === "GET" &&
        path === "/api/admin/lookups"
      ) {
        const result = await env.DB.prepare(`
          SELECT type, value
          FROM catalog_values
          ORDER BY type, value COLLATE NOCASE
        `).all<{ type: string; value: string }>()

        const values = {
          brands: [] as string[],
          categories: [] as string[],
        }

        for (const row of result.results || []) {
          if (row.type === "brand") {
            values.brands.push(row.value)
          }

          if (row.type === "category") {
            values.categories.push(row.value)
          }
        }

        return json(values)
      }

      if (
        method === "POST" &&
        path === "/api/admin/lookups"
      ) {
        const body = await request.json() as {
          type?: string
          value?: unknown
        }

        const type = body.type
        const value = clean(body.value)

        if (
          type !== "brand" &&
          type !== "category"
        ) {
          throw badRequest(
            "Lookup type must be brand or category"
          )
        }

        if (!value || value.length > 100) {
          throw badRequest(
            "Lookup value must be between 1 and 100 characters"
          )
        }

        const inserted = await env.DB.prepare(`
          INSERT OR IGNORE INTO catalog_values (type, value)
          VALUES (?, ?)
        `).bind(type, value).run()

        if (!inserted.meta.changes) {
          return json({
            error: `That ${type} already exists`,
          }, 409)
        }

        await logActivity(
          env.DB,
          admin,
          `${type}_created`,
          "catalog_value",
          Number(inserted.meta.last_row_id),
          { value }
        )

        return json({ type, value }, 201)
      }

      if (
        method === "DELETE" &&
        path === "/api/admin/lookups"
      ) {
        const body = await request.json() as {
          type?: string
          value?: unknown
        }

        const type = body.type
        const value = clean(body.value)

        if (
          type !== "brand" &&
          type !== "category"
        ) {
          throw badRequest(
            "Lookup type must be brand or category"
          )
        }

        if (!value) {
          throw badRequest("Lookup value is required")
        }

        const column =
          type === "brand" ? "brand" : "category"

        const used = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM products
          WHERE LOWER(TRIM(COALESCE(${column},''))) = LOWER(?)
        `).bind(value)
          .first<{ count: number }>()

        if (used?.count) {
          return json({
            error:
              `This ${type} is assigned to ${used.count} product(s) and cannot be removed`,
          }, 409)
        }

        const deleted = await env.DB.prepare(`
          DELETE FROM catalog_values
          WHERE type = ? AND value = ? COLLATE NOCASE
        `).bind(type, value).run()

        if (!deleted.meta.changes) {
          return json({
            error: `${type} not found`,
          }, 404)
        }

        await logActivity(
          env.DB,
          admin,
          `${type}_deleted`,
          "catalog_value",
          null,
          { value }
        )

        return json({ type, value })
      }

      // ================================================
      // ADMIN PRODUCT LIST
      // ================================================

      if (
        method === "GET" &&
        path === "/api/admin/products"
      ) {
        const q = clean(
          url.searchParams.get("q")
        ).toLowerCase()

        const limit = Math.min(
          50,
          Math.max(
            1,
            Number(url.searchParams.get("limit") || 20)
          )
        )

        const page = Math.max(
          1,
          Number(url.searchParams.get("page") || 1)
        )

        const offset = (page - 1) * limit
        const term = `%${q}%`

        const where = q
          ? `(
              LOWER(p.item_code) LIKE ?
              OR LOWER(p.description) LIKE ?
              OR LOWER(COALESCE(p.barcode,'')) LIKE ?
              OR LOWER(COALESCE(p.brand,'')) LIKE ?
            )`
          : "1=1"

        const binds = q
          ? [term, term, term, term]
          : []

        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM products p
          WHERE ${where}
        `).bind(...binds)
          .first<{ count: number }>()

        const result = await env.DB.prepare(`
          ${CURRENT_PRICE_SELECT}
          WHERE ${where}
          ORDER BY p.updated_at DESC
          LIMIT ? OFFSET ?
        `).bind(
          ...binds,
          limit,
          offset
        ).all<Record<string, any>>()

        return json({
          items: (result.results || [])
            .map(productWithPrice),
          total: count?.count || 0,
          page,
          limit,
        })
      }

      // ================================================
      // PRODUCT ROUTE MATCHING
      // ================================================

      const productMatch = path.match(
        /^\/api\/admin\/products\/(\d+)$/
      )

      const historyMatch = path.match(
        /^\/api\/admin\/products\/(\d+)\/history$/
      )

      const statusMatch = path.match(
        /^\/api\/admin\/products\/(\d+)\/status$/
      )

      // ================================================
      // PRODUCT PRICE HISTORY
      // ================================================

      if (
        method === "GET" &&
        historyMatch
      ) {
        const id = Number(historyMatch[1])

        const result = await env.DB.prepare(`
          SELECT
            pbi.id AS batch_item_id,
            pb.id AS batch_db_id,
            pb.batch_code AS batch_id,
            pb.batch_name,
            pb.effective_date,
            pb.notes,
            pbi.lpbt_case_cents,
            pbi.lpbt_pcs_cents,
            pbi.lpat_case_cents,
            pbi.lpat_pcs_cents,
            pbi.is_current,
            pbi.created_at
          FROM price_batch_items pbi
          JOIN price_batches pb
            ON pb.id = pbi.batch_id
          WHERE pbi.product_id = ?
          ORDER BY pb.effective_date DESC, pb.id DESC
        `).bind(id)
          .all<Record<string, any>>()

        return json(
          (result.results || []).map(row => ({
            ...row,
            lpbt_price_case:
              toPesos(row.lpbt_case_cents),
            lpbt_price_pcs:
              toPesos(row.lpbt_pcs_cents),
            lpat_price_case:
              toPesos(row.lpat_case_cents),
            lpat_price_pcs:
              toPesos(row.lpat_pcs_cents),
          }))
        )
      }

      // ================================================
      // CREATE PRODUCT
      // ================================================

      if (
        method === "POST" &&
        path === "/api/admin/products"
      ) {
        const body = await request.json() as ProductInput

        const itemCode = clean(body.item_code)

        const description = clean(
          body.item_description ?? body.description
        )

        if (!itemCode || !description) {
          throw badRequest(
            "Item code and item description are required"
          )
        }

        const effectiveDate = clean(body.effective_date)

        if (!effectiveDate) {
          throw badRequest("Effective date is required")
        }

        const caseCents = toCents(body.lpbt_price_case)
        const pcsCents = toCents(body.lpbt_price_pcs)

        const duplicate = await env.DB.prepare(`
          SELECT id
          FROM products
          WHERE item_code = ?
        `).bind(itemCode).first()

        if (duplicate) {
          throw badRequest(
            "A product already uses this item code"
          )
        }

        const brand = clean(body.brand)
        const category = clean(body.category)

        await registerCatalog(env.DB, "brand", brand)
        await registerCatalog(env.DB, "category", category)

        const created = await env.DB.prepare(`
          INSERT INTO products (
            item_code,
            barcode,
            description,
            grammage,
            pack_size,
            brand,
            category,
            is_active
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).bind(
          itemCode,
          clean(body.barcode) || null,
          description,
          clean(body.grammage) || null,
          clean(body.pack_size) || null,
          brand || null,
          category || null
        ).run()

        const productId =
          Number(created.meta.last_row_id)

        const batch = await createPriceBatch(
          env.DB,
          admin,
          effectiveDate,
          clean(body.remarks),
          [{
            product_id: productId,
            lpbt_price_case: caseCents / 100,
            lpbt_price_pcs: pcsCents / 100,
          }]
        )

        await logActivity(
          env.DB,
          admin,
          "product_created",
          "product",
          productId,
          body
        )

        return json({
          product: await getCurrentProduct(
            env.DB,
            productId
          ),
          batch_id: batch.batch_code,
        }, 201)
      }

      // ================================================
      // EDIT PRODUCT
      // ================================================

      if (
        method === "PUT" &&
        productMatch
      ) {
        const id = Number(productMatch[1])
        const body = await request.json() as ProductInput

        const itemCode = clean(body.item_code)

        const description = clean(
          body.item_description ?? body.description
        )

        if (!itemCode || !description) {
          throw badRequest(
            "Item code and item description are required"
          )
        }

        const duplicate = await env.DB.prepare(`
          SELECT id
          FROM products
          WHERE item_code = ? AND id <> ?
        `).bind(itemCode, id).first()

        if (duplicate) {
          throw badRequest(
            "Another product already uses this item code"
          )
        }

        const brand = clean(body.brand)
        const category = clean(body.category)

        await registerCatalog(env.DB, "brand", brand)
        await registerCatalog(env.DB, "category", category)

        const updated = await env.DB.prepare(`
          UPDATE products
          SET
            item_code = ?,
            barcode = ?,
            description = ?,
            grammage = ?,
            pack_size = ?,
            brand = ?,
            category = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          itemCode,
          clean(body.barcode) || null,
          description,
          clean(body.grammage) || null,
          clean(body.pack_size) || null,
          brand || null,
          category || null,
          id
        ).run()

        if (!updated.meta.changes) {
          return json({
            error: "Product not found",
          }, 404)
        }

        await logActivity(
          env.DB,
          admin,
          "product_updated",
          "product",
          id,
          body
        )

        return json(
          await getCurrentProduct(env.DB, id)
        )
      }

      // ================================================
      // ACTIVATE / DEACTIVATE PRODUCT
      // ================================================

      if (
        method === "PATCH" &&
        statusMatch
      ) {
        const id = Number(statusMatch[1])

        const body = await request.json() as {
          is_active?: boolean
        }

        if (typeof body.is_active !== "boolean") {
          throw badRequest(
            "is_active must be true or false"
          )
        }

        const updated = await env.DB.prepare(`
          UPDATE products
          SET
            is_active = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          body.is_active ? 1 : 0,
          id
        ).run()

        if (!updated.meta.changes) {
          return json({
            error: "Product not found",
          }, 404)
        }

        await logActivity(
          env.DB,
          admin,
          "product_status_changed",
          "product",
          id,
          body
        )

        return json(
          await getCurrentProduct(env.DB, id)
        )
      }

      // ================================================
      // CREATE PRICE BATCH
      // ================================================

      if (
        method === "POST" &&
        path === "/api/admin/batches"
      ) {
        const body = await request.json() as {
          effective_date?: string
          notes?: string
          items?: BatchItemInput[]
        }

        const batch = await createPriceBatch(
          env.DB,
          admin,
          clean(body.effective_date),
          clean(body.notes),
          body.items || []
        )

        return json({
          batch_id: batch.batch_code,
          batch_db_id: batch.id,
          item_count: batch.item_count,
        }, 201)
      }

      // ================================================
      // CSV IMPORT
      // ================================================

      if (
        method === "POST" &&
        path === "/api/admin/import"
      ) {
        const body = await request.json() as {
          rows?: ProductInput[]
        }

        if (!Array.isArray(body.rows)) {
          throw badRequest("CSV rows are required")
        }

        const summary = {
          imported: 0,
          skipped: 0,
          errors: [] as string[],
        }

        for (
          let index = 0;
          index < body.rows.length;
          index++
        ) {
          const row = body.rows[index]

          try {
            const itemCode = clean(row.item_code)

            const description = clean(
              row.item_description ?? row.description
            )

            if (!itemCode || !description) {
              throw new Error(
                "Item code and description are required"
              )
            }

            const caseCents =
              toCents(row.lpbt_price_case)

            const pcsCents =
              toCents(row.lpbt_price_pcs)

            const effectiveDate =
              clean(row.effective_date) ||
              new Date().toISOString().slice(0, 10)

            const brand = clean(row.brand)
            const category = clean(row.category)

            await registerCatalog(
              env.DB,
              "brand",
              brand
            )

            await registerCatalog(
              env.DB,
              "category",
              category
            )

            let product = await env.DB.prepare(`
              SELECT id
              FROM products
              WHERE item_code = ?
            `).bind(itemCode)
              .first<{ id: number }>()

            if (!product) {
              const inserted = await env.DB.prepare(`
                INSERT INTO products (
                  item_code,
                  barcode,
                  description,
                  grammage,
                  pack_size,
                  brand,
                  category,
                  is_active
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
              `).bind(
                itemCode,
                clean(row.barcode) || null,
                description,
                clean(row.grammage) || null,
                clean(row.pack_size) || null,
                brand || null,
                category || null
              ).run()

              product = {
                id: Number(inserted.meta.last_row_id),
              }
            }

            await createPriceBatch(
              env.DB,
              admin,
              effectiveDate,
              clean(row.remarks),
              [{
                product_id: product.id,
                lpbt_price_case: caseCents / 100,
                lpbt_price_pcs: pcsCents / 100,
              }]
            )

            summary.imported++

          } catch (error) {
            summary.skipped++

            summary.errors.push(
              `Row ${index + 2}: ${
                error instanceof Error
                  ? error.message
                  : "Invalid row"
              }`
            )
          }
        }

        await logActivity(
          env.DB,
          admin,
          "csv_import",
          "product",
          null,
          summary
        )

        return json(summary)
      }

      // ================================================
      // CSV EXPORT
      // ================================================

      if (
        method === "GET" &&
        path === "/api/admin/export"
      ) {
        const includeInactive =
          url.searchParams.get("inactive") === "true"

        const result = await env.DB.prepare(`
          SELECT
            p.item_code,
            p.barcode,
            p.description AS item_description,
            p.grammage,
            p.pack_size,
            p.brand,
            p.category,
            p.is_active,
            pb.batch_code AS batch_id,
            pb.effective_date,
            pbi.lpbt_case_cents,
            pbi.lpbt_pcs_cents,
            pbi.lpat_case_cents,
            pbi.lpat_pcs_cents,
            pbi.is_current
          FROM products p
          LEFT JOIN price_batch_items pbi
            ON pbi.product_id = p.id
          LEFT JOIN price_batches pb
            ON pb.id = pbi.batch_id
          ${includeInactive ? "" : "WHERE p.is_active = 1"}
          ORDER BY
            p.item_code,
            pb.effective_date DESC,
            pb.id DESC
        `).all<Record<string, any>>()

        const headers = [
          "item_code",
          "barcode",
          "item_description",
          "grammage",
          "pack_size",
          "brand",
          "category",
          "is_active",
          "batch_id",
          "effective_date",
          "lpbt_price_case",
          "lpbt_price_pcs",
          "lpat_price_case",
          "lpat_price_pcs",
          "is_current",
        ]

        const escapeCsv = (value: unknown) => {
          const text =
            value == null ? "" : String(value)

          return /[",\n\r]/.test(text)
            ? `"${text.replaceAll('"', '""')}"`
            : text
        }

        const rows = (result.results || []).map(row => [
          row.item_code,
          row.barcode,
          row.item_description,
          row.grammage,
          row.pack_size,
          row.brand,
          row.category,
          row.is_active,
          row.batch_id,
          row.effective_date,
          toPesos(row.lpbt_case_cents),
          toPesos(row.lpbt_pcs_cents),
          toPesos(row.lpat_case_cents),
          toPesos(row.lpat_pcs_cents),
          row.is_current,
        ].map(escapeCsv).join(","))

        return new Response(
          [headers.join(","), ...rows].join("\r\n"),
          {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition":
                'attachment; filename="products.csv"',
              "cache-control": "no-store",
            },
          }
        )
      }

      return json({
        error: "API endpoint not found",
      }, 404)

    } catch (error) {
      const status =
        (error as { status?: number }).status || 500

      return json({
        error:
          error instanceof Error
            ? error.message
            : "Internal server error",
      }, status)
    }
  },
}
