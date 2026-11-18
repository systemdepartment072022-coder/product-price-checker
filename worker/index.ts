export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEV_MODE?: string;
  ADMIN_EMAILS?: string;
}

type ProductInput = {
  item_code?: unknown;
  item_description?: unknown;
  description?: unknown;
  grammage?: unknown;
  pack_size?: unknown;
  brand?: unknown;
  category?: unknown;
  remarks?: unknown;
  lpbt_price_case?: unknown;
  effective_date?: unknown;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (value: unknown) =>
  typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

function toCents(value: unknown): number {
  const text = clean(value);
  if (text === "") return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw badRequest(`Invalid monetary value: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount)) throw badRequest("Monetary value is too large");
  return amount;
}

function requiredCents(value: unknown, label: string): number {
  if (clean(value) === "") throw badRequest(`${label} is required`);
  return toCents(value);
}

function parsePackSize(value: unknown): number {
  const text = clean(value);
  const packSize = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(packSize)) {
    throw badRequest("Pack size must be a positive whole number");
  }
  return packSize;
}

const toPesos = (cents: number | null | undefined) => cents == null ? null : cents / 100;
const lpatCents = (lpbtCents: number) => Math.round((lpbtCents * 112) / 100);

async function registerCatalogValue(db: D1Database, type: "brand" | "category", value: string) {
  if (value) {
    await db.prepare("INSERT OR IGNORE INTO catalog_values (type, value) VALUES (?, ?)")
      .bind(type, value).run();
  }
}

function getAdmin(request: Request, env: Env): string | null {
  // Never enable this bypass on a publicly accessible production Worker.
  if (env.DEV_MODE === "true") return "development-admin";
  const email = request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase();
  const allowed = (env.ADMIN_EMAILS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email)) return null;
  return email;
}

function requireAdmin(request: Request, env: Env): string {
  const user = getAdmin(request, env);
  if (!user) throw Object.assign(new Error("Administrator access required"), { status: 403 });
  return user;
}

function productWithPrice(row: Record<string, any> | null) {
  if (!row) return null;
  const product = { ...row };
  delete product.barcode;
  return {
    ...product,
    item_description: row.description,
    batch_id: row.batch_code ?? null,
    lpbt_price_case: toPesos(row.lpbt_case_cents),
    lpbt_price_pcs: toPesos(row.lpbt_pcs_cents),
    lpat_price_case: toPesos(row.lpat_case_cents),
    lpat_price_pcs: toPesos(row.lpat_pcs_cents),
  };
}

async function getCurrentProduct(db: D1Database, id: number) {
  const row = await db.prepare(`
    SELECT p.*, pb.batch_code, pb.effective_date,
      pbi.lpbt_case_cents, pbi.lpbt_pcs_cents,
      pbi.lpat_case_cents, pbi.lpat_pcs_cents,
      pbi.id AS price_record_id
    FROM products p
    LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
    LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
    WHERE p.id = ?
  `).bind(id).first<Record<string, any>>();
  return productWithPrice(row);
}

async function logActivity(db: D1Database, admin: string, action: string, entityType: string, entityId: number | null, details: unknown) {
  await db.prepare(`
    INSERT INTO activity_logs (admin_email, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).bind(admin, action, entityType, entityId, JSON.stringify(details ?? {})).run();
}

function makeBatchCode() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `BATCH-${date}-${suffix}`;
}

async function createBatch(
  db: D1Database,
  admin: string,
  effectiveDate: string,
  items: Array<{ productId: number; caseCents: number }>,
  notes = "",
) {
  if (!effectiveDate) throw badRequest("Effective date is required");
  if (!Array.isArray(items) || items.length === 0) throw badRequest("At least one product is required");
  const seen = new Set<number>();
  const validatedItems: Array<{ productId: number; caseCents: number; pcsCents: number }> = [];
  for (const item of items) {
    if (!Number.isInteger(item.productId) || item.productId <= 0) throw badRequest("Every batch item must have a valid product ID");
    if (seen.has(item.productId)) throw badRequest(`Product ${item.productId} appears more than once in this batch`);
    seen.add(item.productId);
    const product = await db.prepare("SELECT id, pack_size FROM products WHERE id = ? AND is_active = 1")
      .bind(item.productId).first<{ id: number; pack_size: string | number | null }>();
    if (!product) throw new Error(`Active product ${item.productId} was not found`);
    const packSize = parsePackSize(product.pack_size);
    validatedItems.push({ ...item, pcsCents: Math.round(item.caseCents / packSize) });
  }

  const batchCode = makeBatchCode();
  const batchInsert = await db.prepare(`
    INSERT INTO price_batches (batch_code, batch_name, effective_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(batchCode, batchCode, effectiveDate, notes || null, admin).run();
  const batchId = Number(batchInsert.meta.last_row_id);
  const statements: D1PreparedStatement[] = [];
  for (const item of validatedItems) {
    statements.push(db.prepare(`UPDATE price_batch_items SET is_current = 0 WHERE product_id = ? AND is_current = 1`).bind(item.productId));
    statements.push(db.prepare(`
      INSERT INTO price_batch_items
        (batch_id, product_id, lpbt_case_cents, lpbt_pcs_cents, lpat_case_cents, lpat_pcs_cents, is_current)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(batchId, item.productId, item.caseCents, item.pcsCents, lpatCents(item.caseCents), lpatCents(item.pcsCents)));
    statements.push(db.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = ?").bind(item.productId));
  }
  statements.push(db.prepare(`
    INSERT INTO activity_logs (admin_email, action, entity_type, entity_id, details)
    VALUES (?, 'price_batch_created', 'price_batch', ?, ?)
  `).bind(admin, batchId, JSON.stringify({ batch_code: batchCode, item_count: items.length })));
  await db.batch(statements);
  return { id: batchId, batch_code: batchCode, effective_date: effectiveDate, item_count: items.length };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

      // PUBLIC API: active products only. No product details or history endpoints are public.
      if (method === "GET" && path === "/api/products/search") {
        const q = clean(url.searchParams.get("q")).toLowerCase();
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 12)));
        const offset = (page - 1) * limit;
        if (!q) return json({ items: [], total: 0, page, limit });
        const term = `%${q}%`;
        const where = `p.is_active = 1 AND (
          LOWER(p.item_code) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(COALESCE(p.grammage, '')) LIKE ? OR
          LOWER(COALESCE(p.pack_size, '')) LIKE ? OR LOWER(COALESCE(p.brand, '')) LIKE ? OR
          LOWER(COALESCE(p.category, '')) LIKE ?)`;
        const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM products p WHERE ${where}`)
          .bind(term, term, term, term, term, term).first<{ count: number }>();
        const result = await env.DB.prepare(`
          SELECT p.*, pb.batch_code, pb.effective_date,
            pbi.lpbt_case_cents, pbi.lpbt_pcs_cents, pbi.lpat_case_cents, pbi.lpat_pcs_cents
          FROM products p
          LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
          LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
          WHERE ${where}
          ORDER BY p.description COLLATE NOCASE LIMIT ? OFFSET ?
        `).bind(term, term, term, term, term, term, limit, offset).all<Record<string, any>>();
        return json({ items: (result.results || []).map(productWithPrice), total: count?.count || 0, page, limit });
      }

      // All routes below this point are administrator-only and match Access /api/admin/*.
      if (!path.startsWith("/api/admin/")) return json({ error: "API endpoint not found" }, 404);
      const admin = requireAdmin(request, env);

      if (method === "GET" && path === "/api/admin/lookups") {
        const result = await env.DB.prepare("SELECT type, value FROM catalog_values ORDER BY type, value COLLATE NOCASE")
          .all<{ type: string; value: string }>();
        const values = { brands: [] as string[], categories: [] as string[] };
        for (const row of result.results || []) {
          if (row.type === "brand") values.brands.push(row.value);
          if (row.type === "category") values.categories.push(row.value);
        }
        return json(values);
      }

      if (method === "POST" && path === "/api/admin/lookups") {
        const body = await request.json() as { type?: string; value?: unknown };
        const type = body.type;
        const value = clean(body.value);
        if (type !== "brand" && type !== "category") return json({ error: "Lookup type must be brand or category" }, 400);
        if (!value || value.length > 100) return json({ error: "Lookup value must be between 1 and 100 characters" }, 400);
        const inserted = await env.DB.prepare("INSERT OR IGNORE INTO catalog_values (type, value) VALUES (?, ?)")
          .bind(type, value).run();
        if (!inserted.meta.changes) return json({ error: `That ${type} already exists` }, 409);
        await logActivity(env.DB, admin, `${type}_created`, type, Number(inserted.meta.last_row_id), { value });
        return json({ type, value }, 201);
      }

      if (method === "DELETE" && path === "/api/admin/lookups") {
        const body = await request.json() as { type?: string; value?: unknown };
        const type = body.type;
        const value = clean(body.value);
        if (type !== "brand" && type !== "category") return json({ error: "Lookup type must be brand or category" }, 400);
        if (!value) return json({ error: "Lookup value is required" }, 400);
        const column = type === "brand" ? "brand" : "category";
        const used = await env.DB.prepare(`SELECT COUNT(*) AS count FROM products WHERE LOWER(TRIM(COALESCE(${column}, ''))) = LOWER(?)`)
          .bind(value).first<{ count: number }>();
        if (used?.count) return json({ error: `This ${type} is assigned to ${used.count} product(s) and cannot be removed` }, 409);
        const deleted = await env.DB.prepare("DELETE FROM catalog_values WHERE type = ? AND value = ? COLLATE NOCASE")
          .bind(type, value).run();
        if (!deleted.meta.changes) return json({ error: `${type} not found` }, 404);
        await logActivity(env.DB, admin, `${type}_deleted`, type, null, { value });
        return json({ type, value });
      }

      if (method === "GET" && path === "/api/admin/products") {
        const q = clean(url.searchParams.get("q")).toLowerCase();
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
        const offset = (page - 1) * limit;
        const term = `%${q}%`;
        const where = q ? `(LOWER(p.item_code) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?)` : "1=1";
        const binds = q ? [term, term, term] : [];
        const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM products p WHERE ${where}`).bind(...binds).first<{ count: number }>();
        const result = await env.DB.prepare(`
          SELECT p.*, pb.batch_code, pb.effective_date,
            pbi.lpbt_case_cents, pbi.lpbt_pcs_cents, pbi.lpat_case_cents, pbi.lpat_pcs_cents
          FROM products p
          LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id AND pbi.is_current = 1
          LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
          WHERE ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
        `).bind(...binds, limit, offset).all<Record<string, any>>();
        return json({ items: (result.results || []).map(productWithPrice), total: count?.count || 0, page, limit });
      }

      const productIdMatch = path.match(/^\/api\/admin\/products\/(\d+)$/);
      const historyMatch = path.match(/^\/api\/admin\/products\/(\d+)\/history$/);
      const statusMatch = path.match(/^\/api\/admin\/products\/(\d+)\/status$/);

      if (method === "GET" && productIdMatch) {
        const product = await getCurrentProduct(env.DB, Number(productIdMatch[1]));
        return product ? json(product) : json({ error: "Product not found" }, 404);
      }

      if (method === "GET" && historyMatch) {
        const productId = Number(historyMatch[1]);
        const result = await env.DB.prepare(`
          SELECT pb.id AS batch_db_id, pb.batch_code AS batch_id, pb.effective_date, pb.notes, pb.created_by, pb.created_at,
            pbi.lpbt_case_cents, pbi.lpbt_pcs_cents, pbi.lpat_case_cents, pbi.lpat_pcs_cents, pbi.is_current
          FROM price_batch_items pbi JOIN price_batches pb ON pb.id = pbi.batch_id
          WHERE pbi.product_id = ? ORDER BY pb.effective_date DESC, pb.id DESC
        `).bind(productId).all<Record<string, any>>();
        return json((result.results || []).map(row => ({
          ...row,
          lpbt_price_case: toPesos(row.lpbt_case_cents), lpbt_price_pcs: toPesos(row.lpbt_pcs_cents),
          lpat_price_case: toPesos(row.lpat_case_cents), lpat_price_pcs: toPesos(row.lpat_pcs_cents),
        })));
      }

      if (method === "POST" && path === "/api/admin/products") {
        const body = await request.json() as ProductInput;
        const itemCode = clean(body.item_code);
        const description = clean(body.item_description ?? body.description);
        if (!itemCode || !description) return json({ error: "Item code and item description are required" }, 400);
        const caseCents = requiredCents(body.lpbt_price_case, "LPBT case price");
        const packSize = parsePackSize(body.pack_size);
        const effectiveDate = clean(body.effective_date);
        if (!effectiveDate) return json({ error: "Effective date is required when adding prices" }, 400);
        const brand = clean(body.brand);
        const category = clean(body.category);
        await registerCatalogValue(env.DB, "brand", brand);
        await registerCatalogValue(env.DB, "category", category);
        const created = await env.DB.prepare(`
          INSERT INTO products (item_code, description, grammage, pack_size, brand, category)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(itemCode, description, clean(body.grammage) || null, packSize,
          brand || null, category || null).run();
        const productId = Number(created.meta.last_row_id);
        await logActivity(env.DB, admin, "product_created", "product", productId, body);
        const batch = await createBatch(env.DB, admin, effectiveDate, [{ productId, caseCents }]);
        return json({ product: await getCurrentProduct(env.DB, productId), batch }, 201);
      }

      if (method === "PUT" && productIdMatch) {
        const id = Number(productIdMatch[1]);
        const body = await request.json() as ProductInput;
        const itemCode = clean(body.item_code);
        const description = clean(body.item_description ?? body.description);
        if (!itemCode || !description) return json({ error: "Item code and item description are required" }, 400);
        const packSize = parsePackSize(body.pack_size);
        const brand = clean(body.brand);
        const category = clean(body.category);
        await registerCatalogValue(env.DB, "brand", brand);
        await registerCatalogValue(env.DB, "category", category);
        const updated = await env.DB.prepare(`
          UPDATE products SET item_code = ?, description = ?, grammage = ?, pack_size = ?,
            brand = ?, category = ?, updated_at = datetime('now') WHERE id = ?
        `).bind(itemCode, description, clean(body.grammage) || null, packSize,
          brand || null, category || null, id).run();
        if (!updated.meta.changes) return json({ error: "Product not found" }, 404);
        const currentPrice = await env.DB.prepare(`
          SELECT pbi.id, pbi.lpbt_case_cents
          FROM price_batch_items pbi
          WHERE pbi.product_id = ? AND pbi.is_current = 1
        `).bind(id).first<{ id: number; lpbt_case_cents: number }>();
        if (currentPrice) {
          const pcsCents = Math.round(currentPrice.lpbt_case_cents / packSize);
          await env.DB.prepare(`
            UPDATE price_batch_items
            SET lpbt_pcs_cents = ?, lpat_pcs_cents = ?
            WHERE id = ?
          `).bind(pcsCents, lpatCents(pcsCents), currentPrice.id).run();
        }
        await logActivity(env.DB, admin, "product_updated", "product", id, body);
        return json(await getCurrentProduct(env.DB, id));
      }

      if (method === "PATCH" && statusMatch) {
        const id = Number(statusMatch[1]);
        const body = await request.json() as { is_active?: boolean };
        if (typeof body.is_active !== "boolean") return json({ error: "is_active must be true or false" }, 400);
        const updated = await env.DB.prepare("UPDATE products SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(body.is_active ? 1 : 0, id).run();
        if (!updated.meta.changes) return json({ error: "Product not found" }, 404);
        await logActivity(env.DB, admin, "product_status_changed", "product", id, { is_active: body.is_active });
        return json(await getCurrentProduct(env.DB, id));
      }

      if (method === "POST" && path === "/api/admin/batches") {
        const body = await request.json() as {
          effective_date?: string; notes?: string;
          items?: Array<{ product_id: number; lpbt_price_case: unknown }>;
        };
        const items = (body.items || []).map(item => ({
          productId: Number(item.product_id), caseCents: requiredCents(item.lpbt_price_case, "LPBT case price"),
        }));
        const result = await createBatch(env.DB, admin, clean(body.effective_date), items, clean(body.notes));
        return json(result, 201);
      }

      if (method === "POST" && historyMatch) {
        const productId = Number(historyMatch[1]);
        const body = await request.json() as { effective_date?: string; lpbt_price_case?: unknown; remarks?: string };
        const result = await createBatch(env.DB, admin, clean(body.effective_date), [{
          productId, caseCents: requiredCents(body.lpbt_price_case, "LPBT case price"),
        }], clean(body.remarks));
        return json({ ...result, product: await getCurrentProduct(env.DB, productId) }, 201);
      }

      if (method === "POST" && path === "/api/admin/import") {
        const body = await request.json() as { rows?: ProductInput[] };
        if (!Array.isArray(body.rows)) return json({ error: "CSV rows are required" }, 400);
        const summary = { imported: 0, skipped: 0, errors: [] as string[] };
        for (let index = 0; index < body.rows.length; index++) {
          const row = body.rows[index];
          try {
            const itemCode = clean(row.item_code);
            const description = clean(row.item_description ?? row.description);
            if (!itemCode || !description) throw new Error("Item code and description are required");
            const caseCents = requiredCents(row.lpbt_price_case, "LPBT case price");
            let product = await env.DB.prepare("SELECT id FROM products WHERE item_code = ?").bind(itemCode).first<{ id: number }>();
            if (!product) {
              const packSize = parsePackSize(row.pack_size);
              const inserted = await env.DB.prepare(`
                INSERT INTO products (item_code, description, grammage, pack_size, brand, category)
                VALUES (?, ?, ?, ?, ?, ?)
              `).bind(itemCode, description, clean(row.grammage) || null, packSize,
                clean(row.brand) || null, clean(row.category) || null).run();
              product = { id: Number(inserted.meta.last_row_id) };
            }
            const effectiveDate = clean(row.effective_date) || new Date().toISOString().slice(0, 10);
            await registerCatalogValue(env.DB, "brand", clean(row.brand));
            await registerCatalogValue(env.DB, "category", clean(row.category));
            await createBatch(env.DB, admin, effectiveDate, [{ productId: product.id, caseCents }], clean(row.remarks));
            summary.imported++;
          } catch (error) {
            summary.skipped++;
            summary.errors.push(`Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid row"}`);
          }
        }
        await logActivity(env.DB, admin, "csv_import", "products", null, summary);
        return json(summary);
      }

      if (method === "GET" && path === "/api/admin/export") {
        const includeInactive = url.searchParams.get("inactive") === "true";
        const result = await env.DB.prepare(`
          SELECT p.item_code, p.description AS item_description, p.grammage, p.pack_size,
            p.brand, p.category, p.is_active, pb.batch_code AS batch_id, pb.effective_date,
            pbi.lpbt_case_cents, pbi.lpbt_pcs_cents, pbi.lpat_case_cents, pbi.lpat_pcs_cents, pbi.is_current
          FROM products p LEFT JOIN price_batch_items pbi ON pbi.product_id = p.id
          LEFT JOIN price_batches pb ON pb.id = pbi.batch_id
          ${includeInactive ? "" : "WHERE p.is_active = 1"}
          ORDER BY p.item_code, pb.effective_date DESC, pb.id DESC
        `).all<Record<string, any>>();
        const headers = ["item_code", "item_description", "grammage", "pack_size", "brand", "category", "is_active", "batch_id", "effective_date", "lpbt_price_case", "lpbt_price_pcs", "lpat_price_case", "lpat_price_pcs", "is_current"];
        const escapeCsv = (value: unknown) => {
          const text = value == null ? "" : String(value);
          return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        };
        const rows = (result.results || []).map(row => [row.item_code, row.item_description, row.grammage, row.pack_size,
          row.brand, row.category, row.is_active, row.batch_id, row.effective_date, toPesos(row.lpbt_case_cents),
          toPesos(row.lpbt_pcs_cents), toPesos(row.lpat_case_cents), toPesos(row.lpat_pcs_cents), row.is_current].map(escapeCsv).join(","));
        return new Response([headers.join(","), ...rows].join("\n"), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="products.csv"', "cache-control": "no-store" },
        });
      }

      return json({ error: "API endpoint not found" }, 404);
    } catch (error) {
      const status = (error as { status?: number }).status || 500;
      return json({ error: error instanceof Error ? error.message : "Internal server error" }, status);
    }
  },
};
