export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  DEV_MODE?: string
  ADMIN_EMAILS?: string
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const cents = (value: unknown) => {
  if (typeof value === 'number') return Math.round(value * 100)
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Invalid monetary value: ${text}`)
  const [whole, fraction = ''] = text.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

const lpat = (lpbt: number) => Math.round((lpbt * 112) / 100)
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''

function getUser(request: Request, env: Env) {
  if (env.DEV_MODE === 'true') return 'development-admin'
  const email = request.headers.get('CF-Access-Authenticated-User-Email')
  const allowed = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  if (!email || (allowed.length && !allowed.includes(email.toLowerCase()))) return null
  return email
}

function requireAdmin(request: Request, env: Env) {
  const user = getUser(request, env)
  if (!user) throw Object.assign(new Error('Administrator access required'), { status: 403 })
  return user
}

async function currentProduct(db: D1Database, id: number) {
  return db.prepare(`
    SELECT p.*, b.id AS batch_db_id, b.batch_id, b.lpbt_price_case, b.lpbt_price_pcs,
      b.lpat_price_case, b.lpat_price_pcs, b.effective_date, b.expiration_date,
      b.remarks AS batch_remarks
    FROM products p
    LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
    WHERE p.id = ?
  `).bind(id).first()
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname
        const method = request.method

        if (method === 'GET' && path === '/api/products/search') {
          const q = clean(url.searchParams.get('q'))
          const page = Math.max(1, Number(url.searchParams.get('page') || 1))
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 12)))
          const offset = (page - 1) * limit
          if (!q) return json({ items: [], total: 0, page, limit })
          const term = `%${q.toLowerCase()}%`
          const count = await env.DB.prepare(`
            SELECT COUNT(*) AS count FROM products p
            WHERE p.is_active = 1 AND (
              LOWER(p.item_code) LIKE ? OR LOWER(COALESCE(p.barcode,'')) LIKE ? OR
              LOWER(p.item_description) LIKE ? OR LOWER(COALESCE(p.grammage,'')) LIKE ? OR
              CAST(p.pack_size AS TEXT) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ? OR
              LOWER(COALESCE(p.category,'')) LIKE ?
            )`).bind(term, term, term, term, term, term, term).first<{ count: number }>()
          const { results } = await env.DB.prepare(`
            SELECT p.*, b.batch_id, b.lpbt_price_case, b.lpbt_price_pcs,
              b.lpat_price_case, b.lpat_price_pcs, b.effective_date, b.expiration_date
            FROM products p
            LEFT JOIN price_batches b ON b.product_id = p.id AND b.is_current = 1
            WHERE p.is_active = 1 AND (
              LOWER(p.item_code) LIKE ? OR LOWER(COALESCE(p.barcode,'')) LIKE ? OR
              LOWER(p.item_description) LIKE ? OR LOWER(COALESCE(p.grammage,'')) LIKE ? OR
              CAST(p.pack_size AS TEXT) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ? OR
              LOWER(COALESCE(p.category,'')) LIKE ?
            )
            ORDER BY p.item_description ASC LIMIT ? OFFSET ?
          `).bind(term, term, term, term, term, term, term, limit, offset).all()
          return json({ items: results, total: count?.count || 0, page, limit })
        }

        const idMatch = path.match(/^\/api\/products\/(\d+)$/)
        if (method === 'GET' && idMatch) {
          const product = await currentProduct(env.DB, Number(idMatch[1]))
          if (!product) return json({ error: 'Product not found' }, 404)
          return json(product)
        }

        const batchMatch = path.match(/^\/api\/products\/(\d+)\/(?:batches|history)$/)
        if (method === 'GET' && batchMatch) {
          const { results } = await env.DB.prepare(`
            SELECT pb.*, p.item_code, p.item_description
            FROM price_batches pb JOIN products p ON p.id = pb.product_id
            WHERE pb.product_id = ? ORDER BY pb.effective_date DESC, pb.id DESC
          `).bind(Number(batchMatch[1])).all()
          return json(results)
        }

        if (method === 'GET' && path === '/api/admin/products') {
          requireAdmin(request, env)
          const q = clean(url.searchParams.get('q')).toLowerCase()
          const page = Math.max(1, Number(url.searchParams.get('page') || 1))
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)))
          const offset = (page - 1) * limit
          const term = `%${q}%`
          const count = await env.DB.prepare(`
            SELECT COUNT(*) count FROM products p
            WHERE ? = '' OR LOWER(p.item_code) LIKE ? OR LOWER(COALESCE(p.barcode,'')) LIKE ? OR
              LOWER(p.item_description) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?
          `).bind(q, term, term, term, term).first<{ count: number }>()
          const { results } = await env.DB.prepare(`
            SELECT p.*, b.batch_id, b.lpbt_price_case, b.lpbt_price_pcs,
              b.lpat_price_case, b.lpat_price_pcs, b.effective_date
            FROM products p LEFT JOIN price_batches b ON b.product_id=p.id AND b.is_current=1
            WHERE ? = '' OR LOWER(p.item_code) LIKE ? OR LOWER(COALESCE(p.barcode,'')) LIKE ? OR
              LOWER(p.item_description) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?
            ORDER BY p.date_updated DESC LIMIT ? OFFSET ?
          `).bind(q, term, term, term, term, limit, offset).all()
          return json({ items: results, total: count?.count || 0, page, limit })
        }

        if (method === 'POST' && path === '/api/products') {
          const user = requireAdmin(request, env)
          const body = await request.json() as Record<string, unknown>
          const itemCode = clean(body.item_code)
          const description = clean(body.item_description)
          if (!itemCode || !description) return json({ error: 'Item code and item description are required' }, 400)
          if (body.barcode !== undefined && body.barcode !== null && !/^\d*$/.test(clean(body.barcode))) {
            return json({ error: 'Barcode must contain numbers only' }, 400)
          }
          const casePrice = cents(body.lpbt_price_case)
          const pcsPrice = cents(body.lpbt_price_pcs)
          if (casePrice < 0 || pcsPrice < 0) return json({ error: 'Prices cannot be negative' }, 400)
          const batchId = clean(body.batch_id) || `BATCH-${Date.now()}`
          const effectiveDate = clean(body.effective_date)
          if (!effectiveDate) return json({ error: 'Effective date is required' }, 400)

          const duplicate = await env.DB.prepare(
            'SELECT id FROM products WHERE item_code=? OR (barcode IS NOT NULL AND barcode=?)'
          ).bind(itemCode, clean(body.barcode)).first()
          if (duplicate) return json({ error: 'A product already exists with this item code or barcode' }, 409)

          const created = await env.DB.prepare(`
            INSERT INTO products (item_code,barcode,item_description,grammage,pack_size,brand,category,remarks)
            VALUES (?,?,?,?,?,?,?,?)
          `).bind(itemCode, clean(body.barcode) || null, description, clean(body.grammage) || null,
            body.pack_size ? Number(body.pack_size) : null, clean(body.brand) || null,
            clean(body.category) || null, clean(body.remarks) || null).run()
          const productId = created.meta.last_row_id as number
          await env.DB.prepare(`
            INSERT INTO price_batches
              (product_id,batch_id,lpbt_price_case,lpbt_price_pcs,lpat_price_case,lpat_price_pcs,effective_date,is_current,remarks,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).bind(productId, batchId, casePrice, pcsPrice, lpat(casePrice), lpat(pcsPrice),
            effectiveDate, 1, clean(body.remarks) || null, user).run()
          await env.DB.prepare(
            'INSERT INTO activity_logs (product_id,action,previous_value,new_value,modified_by) VALUES (?,?,?,?,?)'
          ).bind(productId, 'product_created', null, JSON.stringify(body), user).run()
          return json(await currentProduct(env.DB, productId), 201)
        }

        if (method === 'PUT' && idMatch) {
          const user = requireAdmin(request, env)
          const body = await request.json() as Record<string, unknown>
          const id = Number(idMatch[1])
          if (body.barcode !== undefined && body.barcode !== null && !/^\d*$/.test(clean(body.barcode))) {
            return json({ error: 'Barcode must contain numbers only' }, 400)
          }
          await env.DB.prepare(`
            UPDATE products SET item_code=?,barcode=?,item_description=?,grammage=?,pack_size=?,
              brand=?,category=?,remarks=?,date_updated=strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE id=?
          `).bind(clean(body.item_code), clean(body.barcode) || null, clean(body.item_description),
            clean(body.grammage) || null, body.pack_size ? Number(body.pack_size) : null,
            clean(body.brand) || null, clean(body.category) || null, clean(body.remarks) || null, id).run()
          await env.DB.prepare(
            'INSERT INTO activity_logs (product_id,action,new_value,modified_by) VALUES (?,?,?,?)'
          ).bind(id, 'product_updated', JSON.stringify(body), user).run()
          return json(await currentProduct(env.DB, id))
        }

        const statusMatch = path.match(/^\/api\/products\/(\d+)\/status$/)
        if (method === 'PATCH' && statusMatch) {
          const user = requireAdmin(request, env)
          const body = await request.json() as { is_active: boolean }
          const id = Number(statusMatch[1])
          await env.DB.prepare(
            "UPDATE products SET is_active=?,date_updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
          ).bind(body.is_active ? 1 : 0, id).run()
          await env.DB.prepare(
            'INSERT INTO activity_logs (product_id,action,new_value,modified_by) VALUES (?,?,?,?)'
          ).bind(id, 'status_changed', body.is_active ? 'active' : 'inactive', user).run()
          return json(await currentProduct(env.DB, id))
        }

        if (method === 'POST' && batchMatch) {
          const user = requireAdmin(request, env)
          const id = Number(batchMatch[1])
          const body = await request.json() as Record<string, unknown>
          const batchId = clean(body.batch_id)
          const effectiveDate = clean(body.effective_date)
          if (!batchId || !effectiveDate) return json({ error: 'Batch ID and effective date are required' }, 400)
          const casePrice = cents(body.lpbt_price_case)
          const pcsPrice = cents(body.lpbt_price_pcs)
          await env.DB.batch([
            env.DB.prepare('UPDATE price_batches SET is_current=0, expiration_date=CASE WHEN expiration_date IS NULL THEN ? ELSE expiration_date END WHERE product_id=? AND is_current=1').bind(effectiveDate, id),
            env.DB.prepare(`
              INSERT INTO price_batches
              (product_id,batch_id,lpbt_price_case,lpbt_price_pcs,lpat_price_case,lpat_price_pcs,effective_date,is_current,remarks,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?)
            `).bind(id, batchId, casePrice, pcsPrice, lpat(casePrice), lpat(pcsPrice), effectiveDate, 1, clean(body.remarks) || null, user),
            env.DB.prepare("UPDATE products SET date_updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").bind(id),
            env.DB.prepare('INSERT INTO activity_logs (product_id,batch_id,action,new_value,modified_by) VALUES (?,?,?,?,?)').bind(id, batchId, 'batch_created', JSON.stringify(body), user),
          ])
          return json(await currentProduct(env.DB, id), 201)
        }

        if (method === 'POST' && path === '/api/admin/import') {
          requireAdmin(request, env)
          const body = await request.json() as { rows?: Record<string, unknown>[] }
          if (!Array.isArray(body.rows)) return json({ error: 'CSV rows are required' }, 400)
          const summary = { imported: 0, skipped: 0, errors: [] as string[] }
          for (let i = 0; i < body.rows.length; i++) {
            const row = body.rows[i]
            try {
              const itemCode = clean(row.item_code)
              const description = clean(row.item_description)
              if (!itemCode || !description) throw new Error('Item code and item description are required')
              const barcode = clean(row.barcode)
              if (barcode && !/^\d+$/.test(barcode)) throw new Error('Barcode must contain numbers only')
              const casePrice = cents(row.lpbt_price_case)
              const pcsPrice = cents(row.lpbt_price_pcs)
              let product = await env.DB.prepare('SELECT id FROM products WHERE item_code=? OR (barcode IS NOT NULL AND barcode=?)')
                .bind(itemCode, barcode).first<{ id: number }>()
              if (!product) {
                const created = await env.DB.prepare(`
                  INSERT INTO products (item_code,barcode,item_description,grammage,pack_size,brand,category,remarks)
                  VALUES (?,?,?,?,?,?,?,?)
                `).bind(itemCode, barcode || null, description, clean(row.grammage) || null,
                  row.pack_size ? Number(row.pack_size) : null, clean(row.brand) || null,
                  clean(row.category) || null, clean(row.remarks) || null).run()
                product = { id: created.meta.last_row_id as number }
              }
              const batchId = clean(row.batch_id) || `IMPORT-${Date.now()}-${i}`
              await env.DB.prepare('UPDATE price_batches SET is_current=0 WHERE product_id=? AND is_current=1').bind(product.id).run()
              await env.DB.prepare(`
                INSERT INTO price_batches
                  (product_id,batch_id,lpbt_price_case,lpbt_price_pcs,lpat_price_case,lpat_price_pcs,effective_date,is_current,remarks)
                VALUES (?,?,?,?,?,?,?,?,?)
              `).bind(product.id, batchId, casePrice, pcsPrice, lpat(casePrice), lpat(pcsPrice),
                clean(row.effective_date) || new Date().toISOString().slice(0, 10), 1, clean(row.remarks) || null).run()
              summary.imported++
            } catch (error) {
              summary.skipped++
              summary.errors.push(`Row ${i + 2}: ${error instanceof Error ? error.message : 'Invalid row'}`)
            }
          }
          return json(summary)
        }

        if (method === 'GET' && path === '/api/admin/export') {
          requireAdmin(request, env)
          const includeInactive = url.searchParams.get('inactive') === 'true'
          let query = `
            SELECT p.*, b.batch_id,b.lpbt_price_case,b.lpbt_price_pcs,b.lpat_price_case,b.lpat_price_pcs,
              b.effective_date,b.expiration_date,b.is_current,b.remarks AS batch_remarks
            FROM products p LEFT JOIN price_batches b ON b.product_id=p.id
          `
          if (!includeInactive) query += ' WHERE p.is_active=1'
          query += ' ORDER BY p.item_code,b.effective_date DESC,b.id DESC'
          const { results } = await env.DB.prepare(query).all()
          const escape = (value: unknown) => {
            const text = value == null ? '' : String(value)
            return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
          }
          const headers = ['item_code','barcode','item_description','grammage','pack_size','brand','category','is_active',
            'batch_id','lpbt_price_case','lpbt_price_pcs','lpat_price_case','lpat_price_pcs','effective_date','expiration_date','is_current']
          const rows = (results || []).map((row: Record<string, unknown>) => headers.map((key) => escape(row[key])).join(','))
          const csv = [headers.join(','), ...rows].join('\n')
          return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="products.csv"' } })
        }
      }
      return env.ASSETS.fetch(request)
    } catch (error) {
      const status = (error as { status?: number }).status || 500
      return json({ error: error instanceof Error ? error.message : 'Internal server error' }, status)
    }
  },
}
