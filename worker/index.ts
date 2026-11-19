export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  DEV_MODE?: string
  ADMIN_EMAILS?: string
  ADMIN_PASSWORD_HASH?: string
  SESSION_SECRET?: string
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

const json = (data: unknown, status = 200, extraHeaders?: HeadersInit) => {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(data), { status, headers })
}

const clean = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim()

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 })

const unauthorized = (message: string) =>
  Object.assign(new Error(message), { status: 401 })

const forbidden = (message: string) =>
  Object.assign(new Error(message), { status: 403 })

const tooManyRequests = (message: string) =>
  Object.assign(new Error(message), { status: 429 })

const serviceUnavailable = (message: string) =>
  Object.assign(new Error(message), { status: 503 })

const sessionCookieName = "__Host-ppc_admin"
const sessionLifetimeSeconds = 12 * 60 * 60
const idleTimeoutMinutes = 30
const textEncoder = new TextEncoder()

function getAdminEmails(env: Env) {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function isAllowedAdmin(email: string, env: Env) {
  return getAdminEmails(env).includes(email.toLowerCase())
}

function assertSameOrigin(request: Request, env: Env) {
  if (env.DEV_MODE === "true") return
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw forbidden("Request origin is not allowed")
  }
}

function decodeBase64(value: string) {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function verifyAdminPassword(password: string, encodedHash: string) {
  const [algorithm, iterationText, saltText, expectedText, ...extra] = encodedHash.split("$")
  const iterations = Number(iterationText)
  if (
    algorithm !== "pbkdf2_sha256" ||
    extra.length ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 100_000
  ) {
    throw serviceUnavailable("Admin password hash is not configured correctly")
  }

  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = decodeBase64(saltText)
    expected = decodeBase64(expectedText)
  } catch {
    throw serviceUnavailable("Admin password hash is not configured correctly")
  }
  if (salt.length < 16 || expected.length !== 32) {
    throw serviceUnavailable("Admin password hash is not configured correctly")
  }

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations,
    hash: "SHA-256",
  }, passwordKey, 256))

  let difference = 0
  for (let index = 0; index < derived.length; index++) {
    difference |= derived[index] ^ expected[index]
  }
  return difference === 0
}

async function hmacHex(value: string, secret: string) {
  if (secret.length < 32) {
    throw serviceUnavailable("Session secret is not configured correctly")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)))
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function base64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function getSessionToken(request: Request) {
  const cookieHeader = request.headers.get("cookie") || ""
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...parts] = cookie.trim().split("=")
    if (name === sessionCookieName) return parts.join("=") || null
  }
  return null
}

function sessionCookie(token: string) {
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}`
}

function clearSessionCookie() {
  return `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

async function getAdminSession(request: Request, env: Env) {
  if (env.DEV_MODE === "true") {
    return { email: "development-admin", tokenHash: null as string | null }
  }

  const token = getSessionToken(request)
  if (!token) return null
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH) {
    throw serviceUnavailable("Admin authentication is not configured")
  }

  const tokenHash = await hmacHex(token, env.SESSION_SECRET)
  const credentialFingerprint = await hmacHex(env.ADMIN_PASSWORD_HASH, env.SESSION_SECRET)
  const session = await env.DB.prepare(`
    SELECT admin_email
    FROM admin_sessions
    WHERE token_hash = ?
      AND credential_fingerprint = ?
      AND expires_at > datetime('now')
      AND last_seen_at > datetime('now', ?)
  `).bind(
    tokenHash,
    credentialFingerprint,
    `-${idleTimeoutMinutes} minutes`
  ).first<{ admin_email: string }>()

  if (!session) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run()
    return null
  }

  await env.DB.prepare(`
    UPDATE admin_sessions
    SET last_seen_at = datetime('now')
    WHERE token_hash = ?
  `).bind(tokenHash).run()

  return { email: session.admin_email, tokenHash }
}

async function requireAdmin(request: Request, env: Env): Promise<string> {
  const session = await getAdminSession(request, env)
  if (!session) throw unauthorized("Administrator login required")
  if (session.email !== "development-admin" && !isAllowedAdmin(session.email, env)) {
    throw forbidden("Administrator access is not allowed")
  }
  return session.email
}

async function enforceLoginRateLimit(db: D1Database, emailKey: string, ipKey: string) {
  const attempts = await db.prepare(`
    SELECT
      SUM(CASE WHEN email_key = ? THEN 1 ELSE 0 END) AS email_attempts,
      SUM(CASE WHEN ip_key = ? THEN 1 ELSE 0 END) AS ip_attempts
    FROM admin_login_attempts
    WHERE attempted_at >= datetime('now', '-15 minutes')
  `).bind(emailKey, ipKey).first<{
    email_attempts: number | null
    ip_attempts: number | null
  }>()

  if ((attempts?.email_attempts || 0) >= 5 || (attempts?.ip_attempts || 0) >= 30) {
    throw tooManyRequests("Too many login attempts. Please try again later.")
  }
}

async function loginAdmin(request: Request, env: Env) {
  assertSameOrigin(request, env)
  if (env.DEV_MODE === "true") {
    return json({ authenticated: true, email: "development-admin" })
  }
  if (!env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET || !getAdminEmails(env).length) {
    throw serviceUnavailable("Admin authentication is not configured")
  }

  let bodyValue: unknown
  try {
    bodyValue = await request.json()
  } catch {
    throw badRequest("Request body must be valid JSON")
  }
  if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
    throw badRequest("Request body must be a JSON object")
  }
  const body = bodyValue as { email?: unknown; password?: unknown }

  const email = clean(body.email).toLowerCase()
  const password = typeof body.password === "string" ? body.password : ""
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 1024) {
    throw badRequest("Enter a valid email address and password")
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown"
  const emailKey = await hmacHex(email, env.SESSION_SECRET)
  const ipKey = await hmacHex(ip, env.SESSION_SECRET)
  await env.DB.prepare(`
    DELETE FROM admin_login_attempts
    WHERE attempted_at < datetime('now', '-1 day')
  `).run()
  await enforceLoginRateLimit(env.DB, emailKey, ipKey)

  const passwordMatches = await verifyAdminPassword(password, env.ADMIN_PASSWORD_HASH)
  if (!isAllowedAdmin(email, env) || !passwordMatches) {
    await env.DB.prepare(`
      INSERT INTO admin_login_attempts (email_key, ip_key)
      VALUES (?, ?)
    `).bind(emailKey, ipKey).run()
    throw unauthorized("Invalid email or password")
  }

  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await hmacHex(token, env.SESSION_SECRET)
  const credentialFingerprint = await hmacHex(env.ADMIN_PASSWORD_HASH, env.SESSION_SECRET)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare(`
      DELETE FROM admin_login_attempts
      WHERE email_key = ? OR ip_key = ?
    `).bind(emailKey, ipKey),
    env.DB.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_email, credential_fingerprint, expires_at)
      VALUES (?, ?, ?, datetime('now', '+12 hours'))
    `).bind(tokenHash, email, credentialFingerprint),
  ])

  return json(
    { authenticated: true, email },
    200,
    { "set-cookie": sessionCookie(token) }
  )
}

async function logoutAdmin(request: Request, env: Env) {
  assertSameOrigin(request, env)
  const token = getSessionToken(request)
  if (token && env.SESSION_SECRET) {
    const tokenHash = await hmacHex(token, env.SESSION_SECRET)
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run()
  }
  return json(
    { authenticated: false },
    200,
    { "set-cookie": clearSessionCookie() }
  )
}

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
  const normalized = text.replace(/\.0+$/, "")
  const packSize = Number(normalized)
  if (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(packSize)) {
    throw badRequest("Pack size must be a positive whole number")
  }
  return packSize
}

const toPesos = (cents: number | null | undefined) =>
  cents == null ? null : cents / 100

const lpatCents = (lpbtCents: number) =>
  Math.round((lpbtCents * 112) / 100)

type DatabaseSchema = {
  priceLayout: "canonical" | "normalized"
  batchCodeColumn: "batch_id" | "batch_code"
  activityLayout: "canonical" | "normalized"
  productDescriptionColumn: "item_description" | "description"
  productUpdatedColumn: "date_updated" | "updated_at"
  tableColumns: Map<string, Set<string>>
}

const schemaCache = new WeakMap<object, Promise<DatabaseSchema>>()

async function getDatabaseSchema(db: D1Database): Promise<DatabaseSchema> {
  const cached = schemaCache.get(db)
  if (cached) return cached

  const promise = (async () => {
    const tableColumns = new Map<string, Set<string>>()
    for (const table of ["price_batches", "price_batch_items", "activity_logs", "products"]) {
      try {
        const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
        tableColumns.set(table, new Set((result.results || []).map((column) => column.name)))
      } catch {
        tableColumns.set(table, new Set())
      }
    }

    const batchColumns = tableColumns.get("price_batches") || new Set()
    const itemColumns = tableColumns.get("price_batch_items") || new Set()
    const activityColumns = tableColumns.get("activity_logs") || new Set()
    const productColumns = tableColumns.get("products") || new Set()

    return {
      priceLayout: itemColumns.size > 0 ? "normalized" : "canonical",
      batchCodeColumn: batchColumns.has("batch_code") ? "batch_code" : "batch_id",
      activityLayout: activityColumns.has("admin_email") ? "normalized" : "canonical",
      productDescriptionColumn: productColumns.has("description") && !productColumns.has("item_description")
        ? "description" : "item_description",
      productUpdatedColumn: productColumns.has("updated_at") && !productColumns.has("date_updated")
        ? "updated_at" : "date_updated",
      tableColumns,
    }
  })()

  schemaCache.set(db, promise)
  return promise
}

function productWithPrice(row: Record<string, any> | null) {
  if (!row) return null
  const product = { ...row }
  delete product.barcode
  return {
    ...product,
    item_description: row.item_description ?? row.description,
    lpbt_price_case: toPesos(row.lpbt_price_case),
    lpbt_price_pcs: toPesos(row.lpbt_price_pcs),
    lpat_price_case: toPesos(row.lpat_price_case),
    lpat_price_pcs: toPesos(row.lpat_price_pcs),
  }
}

async function getCurrentProduct(db: D1Database, id: number) {
  const schema = await getDatabaseSchema(db)
  let row: Record<string, any> | null

  if (schema.priceLayout === "normalized") {
    row = await db.prepare(`
      SELECT p.*,
        pb.${schema.batchCodeColumn} AS batch_id,
        pb.effective_date,
        pbi.lpbt_case_cents AS lpbt_price_case,
        pbi.lpbt_pcs_cents AS lpbt_price_pcs,
        pbi.lpat_case_cents AS lpat_price_case,
        pbi.lpat_pcs_cents AS lpat_price_pcs,
        pb.notes AS batch_remarks
      FROM products p
      LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
      LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
      WHERE p.id = ?
    `).bind(id).first<Record<string, any>>()
  } else {
    row = await db.prepare(`
      SELECT p.*,
        b.${schema.batchCodeColumn} AS batch_id,
        b.effective_date,
        b.lpbt_price_case, b.lpbt_price_pcs,
        b.lpat_price_case, b.lpat_price_pcs,
        b.remarks AS batch_remarks
      FROM products p
      LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
      WHERE p.id = ?
    `).bind(id).first<Record<string, any>>()
  }
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
  const schema = await getDatabaseSchema(db)
  if (schema.activityLayout === "normalized") {
    await db.prepare(`
      INSERT INTO activity_logs
        (admin_email, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      admin,
      action,
      productId != null ? "product" : "system",
      productId,
      JSON.stringify(details ?? {})
    ).run()
  } else {
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
  const schema = await getDatabaseSchema(db)

  if (schema.priceLayout === "normalized") {
    const batchInsert = await db.prepare(`
      INSERT INTO price_batches
        (${schema.batchCodeColumn}, batch_name, effective_date, notes, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).bind(batchId, batchId, effectiveDate, remarks || null, admin).run()
    const batchDbId = Number(batchInsert.meta.last_row_id)

    try {
      await db.batch([
        db.prepare(`
          UPDATE price_batch_items
          SET is_current = 0
          WHERE product_id = ? AND is_current = 1
        `).bind(productId),
        db.prepare(`
          INSERT INTO price_batch_items (
            batch_id, product_id,
            lpbt_case_cents, lpbt_pcs_cents,
            lpat_case_cents, lpat_pcs_cents, is_current
          )
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).bind(
          batchDbId,
          productId,
          caseCents,
          pcsCents,
          lpatCents(caseCents),
          lpatCents(pcsCents)
        ),
        db.prepare(`
          UPDATE products
          SET updated_at = datetime('now')
          WHERE id = ?
        `).bind(productId),
      ])
    } catch (error) {
      await db.prepare("DELETE FROM price_batches WHERE id = ?").bind(batchDbId).run()
      throw error
    }

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

      if (method === "POST" && path === "/api/admin/login") {
        return await loginAdmin(request, env)
      }

      if (method === "POST" && path === "/api/admin/logout") {
        return await logoutAdmin(request, env)
      }

      if (method === "GET" && path === "/api/admin/session") {
        const session = await getAdminSession(request, env)
        if (!session) {
          return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() })
        }
        if (session.email !== "development-admin" && !isAllowedAdmin(session.email, env)) {
          return json(
            { authenticated: false, error: "Administrator access is not allowed" },
            403,
            { "set-cookie": clearSessionCookie() }
          )
        }
        return json({ authenticated: true, email: session.email })
      }

      if (method === "GET" && path === "/api/products/search") {
        const q = clean(url.searchParams.get("q")).toLowerCase()
        const page = Math.max(1, Number(url.searchParams.get("page") || 1))
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 12)))
        const offset = (page - 1) * limit
        if (!q) return json({ items: [], total: 0, page, limit })
        const term = `%${q}%`
        const schema = await getDatabaseSchema(env.DB)
        const descriptionColumn = schema.productDescriptionColumn
        const where = `p.is_active = 1 AND (
          LOWER(p.item_code) LIKE ? OR
          LOWER(p.${descriptionColumn}) LIKE ? OR
          LOWER(COALESCE(p.grammage,'')) LIKE ? OR
          CAST(p.pack_size AS TEXT) LIKE ? OR
          LOWER(COALESCE(p.brand,'')) LIKE ? OR
          LOWER(COALESCE(p.category,'')) LIKE ?)`
        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count FROM products p WHERE ${where}
        `).bind(term, term, term, term, term, term).first<{ count: number }>()
        const result = schema.priceLayout === "normalized"
          ? await env.DB.prepare(`
              SELECT p.*,
                pb.${schema.batchCodeColumn} AS batch_id, pb.effective_date,
                pbi.lpbt_case_cents AS lpbt_price_case,
                pbi.lpbt_pcs_cents AS lpbt_price_pcs,
                pbi.lpat_case_cents AS lpat_price_case,
                pbi.lpat_pcs_cents AS lpat_price_pcs
              FROM products p
              LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
              LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
              WHERE ${where}
              ORDER BY p.${descriptionColumn} COLLATE NOCASE
              LIMIT ? OFFSET ?
            `).bind(term, term, term, term, term, term, limit, offset).all<Record<string, any>>()
          : await env.DB.prepare(`
              SELECT p.*,
                b.${schema.batchCodeColumn} AS batch_id, b.effective_date,
                b.lpbt_price_case, b.lpbt_price_pcs,
                b.lpat_price_case, b.lpat_price_pcs
              FROM products p
              LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
              WHERE ${where}
              ORDER BY p.${descriptionColumn} COLLATE NOCASE
              LIMIT ? OFFSET ?
            `).bind(term, term, term, term, term, term, limit, offset).all<Record<string, any>>()
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

      const admin = await requireAdmin(request, env)
      if (method !== "GET" && method !== "HEAD") assertSameOrigin(request, env)

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
        const schema = await getDatabaseSchema(env.DB)
        const descriptionColumn = schema.productDescriptionColumn
        const updatedColumn = schema.productUpdatedColumn
        const where = q
          ? `(LOWER(p.item_code) LIKE ? OR LOWER(p.${descriptionColumn}) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?)`
          : "1=1"
        const binds = q ? [term, term, term] : []
        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS count FROM products p WHERE ${where}
        `).bind(...binds).first<{ count: number }>()
        const result = schema.priceLayout === "normalized"
          ? await env.DB.prepare(`
              SELECT p.*,
                pb.${schema.batchCodeColumn} AS batch_id, pb.effective_date,
                pbi.lpbt_case_cents AS lpbt_price_case,
                pbi.lpbt_pcs_cents AS lpbt_price_pcs,
                pbi.lpat_case_cents AS lpat_price_case,
                pbi.lpat_pcs_cents AS lpat_price_pcs
              FROM products p
              LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
              LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
              WHERE ${where}
              ORDER BY p.${updatedColumn} DESC
              LIMIT ? OFFSET ?
            `).bind(...binds, limit, offset).all<Record<string, any>>()
          : await env.DB.prepare(`
              SELECT p.*,
                b.${schema.batchCodeColumn} AS batch_id, b.effective_date,
                b.lpbt_price_case, b.lpbt_price_pcs,
                b.lpat_price_case, b.lpat_price_pcs
              FROM products p
              LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
              WHERE ${where}
              ORDER BY p.${updatedColumn} DESC
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

      if (method === "DELETE" && productMatch) {
        const id = Number(productMatch[1])
        const product = await getCurrentProduct(env.DB, id)
        if (!product) throw badRequest("Product not found")

        const schema = await getDatabaseSchema(env.DB)
        const deletePriceRows = schema.priceLayout === "normalized"
          ? env.DB.prepare("DELETE FROM price_batch_items WHERE product_id = ?").bind(id)
          : env.DB.prepare("DELETE FROM price_batches WHERE product_id = ?").bind(id)
        const results = await env.DB.batch([
          deletePriceRows,
          env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id),
        ])
        if (!results[1].meta.changes) throw badRequest("Product not found")

        await logActivity(env.DB, admin, "product_deleted", id, null, product)
        return json({ id, deleted: true })
      }

      if (method === "GET" && historyMatch) {
        const productId = Number(historyMatch[1])
        const schema = await getDatabaseSchema(env.DB)
        const result = schema.priceLayout === "normalized"
          ? await env.DB.prepare(`
              SELECT pb.id AS batch_db_id, pb.${schema.batchCodeColumn} AS batch_id,
                pb.effective_date, NULL AS expiration_date,
                pbi.lpbt_case_cents AS lpbt_price_case,
                pbi.lpbt_pcs_cents AS lpbt_price_pcs,
                pbi.lpat_case_cents AS lpat_price_case,
                pbi.lpat_pcs_cents AS lpat_price_pcs,
                pbi.is_current, pb.notes AS remarks, pb.created_at
              FROM price_batch_items pbi
              JOIN price_batches pb ON pb.id = pbi.batch_id
              WHERE pbi.product_id = ?
              ORDER BY pb.effective_date DESC, pb.id DESC
            `).bind(productId).all<Record<string, any>>()
          : await env.DB.prepare(`
              SELECT id AS batch_db_id, ${schema.batchCodeColumn} AS batch_id,
                effective_date, expiration_date,
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

        const schema = await getDatabaseSchema(env.DB)
        const descriptionColumn = schema.productDescriptionColumn
        const normalizedInsert = descriptionColumn === "description"

        let created: D1Result
        if (normalizedInsert) {
          created = await env.DB.prepare(`
            INSERT INTO products (
              item_code, description, grammage, pack_size,
              brand, category
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            itemCode,
            description,
            clean(body.grammage) || null,
            packSize,
            brand || null,
            category || null
          ).run()
        } else {
          created = await env.DB.prepare(`
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
        }

        const productId = Number(created.meta.last_row_id)
        let batchId: string
        try {
          batchId = await createBatch(
            env.DB,
            admin,
            productId,
            caseCents,
            effectiveDate,
            clean(body.remarks)
          )
        } catch (error) {
          const deletePriceRows = schema.priceLayout === "normalized"
            ? env.DB.prepare("DELETE FROM price_batch_items WHERE product_id = ?").bind(productId)
            : env.DB.prepare("DELETE FROM price_batches WHERE product_id = ?").bind(productId)
          await env.DB.batch([
            deletePriceRows,
            env.DB.prepare("DELETE FROM products WHERE id = ?").bind(productId),
          ])
          throw error
        }
        await logActivity(env.DB, admin, "product_created", productId, null, body)
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
        const priceCents = body.lpbt_price_case === undefined
          ? null
          : toCents(body.lpbt_price_case)
        const effectiveDate = clean(body.effective_date)
        if (priceCents !== null && !effectiveDate) {
          throw badRequest("Effective date is required")
        }
        const duplicate = await env.DB.prepare(`
          SELECT id FROM products WHERE item_code = ? AND id <> ?
        `).bind(itemCode, id).first()
        if (duplicate) throw badRequest("Another product already uses this item code")

        const brand = clean(body.brand)
        const category = clean(body.category)
        await registerCatalog(env.DB, "brand", brand)
        await registerCatalog(env.DB, "category", category)

        const schema = await getDatabaseSchema(env.DB)
        const currentPrice = priceCents === null
          ? null
          : schema.priceLayout === "normalized"
            ? await env.DB.prepare(`
                SELECT lpbt_case_cents AS price
                FROM price_batch_items
                WHERE product_id = ? AND is_current = 1
              `).bind(id).first<{ price: number }>()
            : await env.DB.prepare(`
                SELECT lpbt_price_case AS price
                FROM price_batches
                WHERE product_id = ? AND is_current = 1
              `).bind(id).first<{ price: number }>()
        let updated: D1Result
        if (schema.productDescriptionColumn === "description") {
          updated = await env.DB.prepare(`
            UPDATE products
            SET item_code = ?, description = ?, grammage = ?,
              pack_size = ?, brand = ?, category = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).bind(
            itemCode,
            description,
            clean(body.grammage) || null,
            packSize,
            brand || null,
            category || null,
            id
          ).run()
        } else {
          updated = await env.DB.prepare(`
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
        }
        if (!updated.meta.changes) throw badRequest("Product not found")

        if (schema.priceLayout === "normalized") {
          const current = await env.DB.prepare(`
            SELECT id, lpbt_case_cents
            FROM price_batch_items
            WHERE product_id = ? AND is_current = 1
          `).bind(id).first<{ id: number; lpbt_case_cents: number }>()
          if (current) {
            const pcsCents = Math.round(current.lpbt_case_cents / packSize)
            await env.DB.prepare(`
              UPDATE price_batch_items
              SET lpbt_pcs_cents = ?, lpat_pcs_cents = ?
              WHERE id = ?
            `).bind(pcsCents, lpatCents(pcsCents), current.id).run()
          }
        } else {
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
        }

        if (priceCents !== null && currentPrice?.price !== priceCents) {
          await createBatch(
            env.DB,
            admin,
            id,
            priceCents,
            effectiveDate,
            clean(body.remarks)
          )
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
        const schema = await getDatabaseSchema(env.DB)
        const updated = schema.productUpdatedColumn === "updated_at"
          ? await env.DB.prepare(`
              UPDATE products
              SET is_active = ?, updated_at = datetime('now')
              WHERE id = ?
            `).bind(body.is_active ? 1 : 0, id).run()
          : await env.DB.prepare(`
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
              const schema = await getDatabaseSchema(env.DB)
              const inserted = schema.productDescriptionColumn === "description"
                ? await env.DB.prepare(`
                    INSERT INTO products (
                      item_code, description, grammage, pack_size,
                      brand, category
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                  `).bind(
                    itemCode,
                    description,
                    clean(row.grammage) || null,
                    packSize,
                    brand || null,
                    category || null
                  ).run()
                : await env.DB.prepare(`
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
        const schema = await getDatabaseSchema(env.DB)
        const descriptionColumn = schema.productDescriptionColumn
        const result = schema.priceLayout === "normalized"
          ? await env.DB.prepare(`
              SELECT p.item_code, p.${descriptionColumn} AS item_description,
                p.grammage, p.pack_size, p.brand, p.category, p.is_active,
                pb.${schema.batchCodeColumn} AS batch_id, pb.effective_date,
                pbi.lpbt_case_cents AS lpbt_price_case,
                pbi.lpbt_pcs_cents AS lpbt_price_pcs,
                pbi.lpat_case_cents AS lpat_price_case,
                pbi.lpat_pcs_cents AS lpat_price_pcs,
                pbi.is_current
              FROM products p
              LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id
              LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
              ${includeInactive ? "" : "WHERE p.is_active = 1"}
              ORDER BY p.item_code, pb.effective_date DESC, pb.id DESC
            `).all<Record<string, any>>()
          : await env.DB.prepare(`
              SELECT p.item_code, p.${descriptionColumn} AS item_description,
                p.grammage, p.pack_size, p.brand, p.category, p.is_active,
                b.${schema.batchCodeColumn} AS batch_id, b.effective_date,
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
