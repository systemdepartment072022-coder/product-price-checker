
import { useEffect, useRef, useState } from 'react'
import {
  Calculator, Check, ChevronRight, Download, Edit3, History, Package,
  Plus, Printer, RefreshCcw, Search, Upload, X, Power, Boxes,
} from 'lucide-react'

type Product = {
  id: number
  item_code: string
  barcode?: string
  item_description: string
  grammage?: string
  pack_size?: string | number
  brand?: string
  category?: string
  is_active?: number
  updated_at?: string
  batch_id?: string
  lpbt_price_case?: number
  lpbt_price_pcs?: number
  lpat_price_case?: number
  lpat_price_pcs?: number
  effective_date?: string
  remarks?: string
}

type Batch = Product & {
  batch_db_id?: number
  lpbt_price_case: number
  lpbt_price_pcs: number
  lpat_price_case: number
  lpat_price_pcs: number
  is_current: number
  expiration_date?: string
  created_at?: string
}

const php = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
})

const money = (pesos?: number) => php.format(pesos || 0)

const api = async (path: string, options?: RequestInit) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options?.headers,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || 'Request failed')
  }

  return data
}

function highlight(text: string, query: string) {
  if (!query) return text

  const index = text.toLowerCase().indexOf(query.toLowerCase())

  if (index < 0) return text

  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

const emptyForm = {
  item_code: '',
  barcode: '',
  item_description: '',
  grammage: '',
  pack_size: '',
  brand: '',
  category: '',
  lpbt_price_case: '',
  lpbt_price_pcs: '',
  effective_date: new Date().toISOString().slice(0, 10),
  remarks: '',
}

// =====================================================
// DISCOUNT CALCULATOR
// =====================================================

function CalculatorPanel({ product }: { product: Product }) {
  const [discount, setDiscount] = useState('')
  const [caseQty, setCaseQty] = useState('')
  const [pcsQty, setPcsQty] = useState('')

  const n = (x: string) => Math.max(0, Number(x || 0))
  const percent = Math.min(100, n(discount))

  const caseBase = product.lpat_price_case || 0
  const pcsBase = product.lpat_price_pcs || 0

  const caseNet = Math.max(0, caseBase * (1 - percent / 100))
  const pcsNet = Math.max(0, pcsBase * (1 - percent / 100))

  const caseTotal = caseNet * n(caseQty)
  const pcsTotal = pcsNet * n(pcsQty)

  const grand = caseTotal + pcsTotal
  const original = caseBase * n(caseQty) + pcsBase * n(pcsQty)

  const reset = () => {
    setDiscount('')
    setCaseQty('')
    setPcsQty('')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `Product: ${product.item_description}
Discount: ${percent}%
Case: ${n(caseQty)} x ${money(caseNet)} = ${money(caseTotal)}
Pcs: ${n(pcsQty)} x ${money(pcsNet)} = ${money(pcsTotal)}
Grand Total: ${money(grand)}
Savings: ${money(Math.max(0, original - grand))}`
      )

      alert('Calculation copied successfully.')
    } catch {
      alert('Unable to copy. Please check browser clipboard permissions.')
    }
  }

  return (
    <section className="calculator" aria-label="Discount calculator">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Selected product</span>
          <h2>{product.item_description}</h2>
        </div>
        <Calculator size={28} />
      </div>

      <div className="calc-grid">
        <label>
          Discount percentage (%)
          <div className="input-suffix">
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="0"
            />
            <span>%</span>
          </div>
        </label>

        <label>
          Quantity case
          <input
            type="number"
            min="0"
            step="1"
            value={caseQty}
            onChange={(e) => setCaseQty(e.target.value)}
            placeholder="0"
          />
        </label>

        <label>
          Quantity pcs
          <input
            type="number"
            min="0"
            step="1"
            value={pcsQty}
            onChange={(e) => setPcsQty(e.target.value)}
            placeholder="0"
          />
        </label>
      </div>

      <div className="result-grid">
        <div>
          <span>LPAT case</span>
          <strong>{money(caseBase)}</strong>
        </div>
        <div>
          <span>LPAT pcs</span>
          <strong>{money(pcsBase)}</strong>
        </div>
        <div>
          <span>Discounted case</span>
          <strong>{money(caseNet)}</strong>
        </div>
        <div>
          <span>Discounted pcs</span>
          <strong>{money(pcsNet)}</strong>
        </div>
        <div>
          <span>Case total</span>
          <strong>{money(caseTotal)}</strong>
        </div>
        <div>
          <span>Pcs total</span>
          <strong>{money(pcsTotal)}</strong>
        </div>
      </div>

      <div className="grand-total">
        <div>
          <span>Grand total</span>
          <strong>{money(grand)}</strong>
        </div>
        <div>
          <span>Savings</span>
          <strong>{money(Math.max(0, original - grand))}</strong>
        </div>
      </div>

      <div className="actions">
        <button className="btn secondary" onClick={reset}>
          <RefreshCcw size={17} /> Reset
        </button>

        <button className="btn secondary" onClick={copy}>
          <Check size={17} /> Copy result
        </button>

        <button className="btn" onClick={() => window.print()}>
          <Printer size={17} /> Print
        </button>
      </div>
    </section>
  )
}

// =====================================================
// PUBLIC PRODUCT SEARCH
// =====================================================

function SearchPage() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Product[]>([])
  const [selected, setSelected] = useState<Product | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.clearTimeout(timer.current)

    if (!query.trim()) {
      setSuggestions([])
      setOpen(false)
      setLoading(false)
      return
    }

    setLoading(true)

    timer.current = window.setTimeout(async () => {
      try {
        const data = await api(
          `/api/products/search?q=${encodeURIComponent(query.trim())}&limit=8`
        )

        setSuggestions(data.items || [])
        setOpen(true)
      } catch {
        setSuggestions([])
        setOpen(true)
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => window.clearTimeout(timer.current)
  }, [query])

  const choose = (product: Product) => {
    setSelected(product)
    setQuery(product.item_description)
    setOpen(false)
  }

  return (
    <main className="container">
      <div className="search-hero">
        <span className="eyebrow">Quick lookup</span>
        <h1>Find product prices</h1>
        <p>Search by item code, barcode, description, brand or category.</p>

        <div className="search-wrap">
          <Search size={22} />

          <input
            aria-label="Search products"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
            }}
            placeholder="Start typing to search..."
            autoComplete="off"
          />

          {query && (
            <button
              className="clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                setSelected(null)
                setOpen(false)
              }}
            >
              <X size={20} />
            </button>
          )}

          {open && (
            <div className="suggestions">
              {loading ? (
                <div className="suggestion-empty">Searching...</div>
              ) : suggestions.length ? (
                suggestions.map((p) => (
                  <button key={p.id} onClick={() => choose(p)}>
                    <div className="suggestion-icon">
                      <Package size={18} />
                    </div>

                    <div>
                      <strong>{highlight(p.item_description, query)}</strong>
                      <span>
                        {highlight(p.item_code, query)} · {p.brand || 'No brand'}
                      </span>
                    </div>

                    <ChevronRight size={18} />
                  </button>
                ))
              ) : (
                <div className="suggestion-empty">No product found.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {selected ? (
        <div className="product-layout">
          <section className="product-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Product details</span>
                <h2>{selected.item_description}</h2>
              </div>
              <Package size={28} />
            </div>

            <div className="detail-grid">
              {[
                ['Item code', selected.item_code],
                ['Barcode', selected.barcode || '—'],
                ['Grammage', selected.grammage || '—'],
                ['Pack size', selected.pack_size || '—'],
                ['Brand', selected.brand || '—'],
                ['Category', selected.category || '—'],
                ['Batch ID', selected.batch_id || '—'],
                ['Effective date', selected.effective_date || '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>

            <div className="price-grid">
              <div>
                <span>LPBT case</span>
                <strong>{money(selected.lpbt_price_case)}</strong>
              </div>
              <div>
                <span>LPBT pcs</span>
                <strong>{money(selected.lpbt_price_pcs)}</strong>
              </div>
              <div className="featured">
                <span>LPAT case</span>
                <strong>{money(selected.lpat_price_case)}</strong>
              </div>
              <div className="featured">
                <span>LPAT pcs</span>
                <strong>{money(selected.lpat_price_pcs)}</strong>
              </div>
            </div>
          </section>

          <CalculatorPanel product={selected} />
        </div>
      ) : (
        <div className="empty-state">
          <Boxes size={44} />
          <h2>Ready to check a price</h2>
          <p>Select a matching product to view prices and calculate totals.</p>
        </div>
      )}
    </main>
  )
}

// =====================================================
// PRODUCT FORM
// =====================================================

function ProductForm({
  product,
  onClose,
  onSaved,
}: {
  product?: Product | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(
    product
      ? {
          item_code: product.item_code || '',
          barcode: product.barcode || '',
          item_description: product.item_description || '',
          grammage: product.grammage || '',
          pack_size: String(product.pack_size || ''),
          brand: product.brand || '',
          category: product.category || '',
          lpbt_price_case: '',
          lpbt_price_pcs: '',
          effective_date: new Date().toISOString().slice(0, 10),
          remarks: product.remarks || '',
        }
      : emptyForm
  )

  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key: string, value: string) => {
    setForm((old) => ({ ...old, [key]: value }))
  }

  const lpatCase = (Number(form.lpbt_price_case || 0) * 1.12).toFixed(2)
  const lpatPcs = (Number(form.lpbt_price_pcs || 0) * 1.12).toFixed(2)

  const submit = async () => {
    setError('')

    if (!form.item_code.trim() || !form.item_description.trim()) {
      setError('Item code and item description are required.')
      return
    }

    if (!product && (
      form.lpbt_price_case === '' ||
      form.lpbt_price_pcs === '' ||
      Number(form.lpbt_price_case) < 0 ||
      Number(form.lpbt_price_pcs) < 0
    )) {
      setError('Please enter valid LPBT case and pcs prices.')
      return
    }

    setSaving(true)

    try {
      if (product) {
        await api(`/api/admin/products/${product.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        })
      } else {
        await api('/api/admin/products', {
          method: 'POST',
          body: JSON.stringify(form),
        })
      }

      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">
              {product ? 'Edit product' : 'New registration'}
            </span>
            <h2>{product ? 'Update product' : 'Add product'}</h2>
          </div>

          <button onClick={onClose}>
            <X />
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="form-grid">
          {([
            { key: 'item_code', label: 'Item code', required: true },
            { key: 'barcode', label: 'Barcode', required: false },
            { key: 'item_description', label: 'Item description', required: true },
            { key: 'grammage', label: 'Grammage', required: false },
            { key: 'pack_size', label: 'Pack size', required: false },
            { key: 'brand', label: 'Brand', required: false },
            { key: 'category', label: 'Category', required: false },
            { key: 'remarks', label: 'Remarks', required: false },
          ] as const).map(({ key, label, required }) => (
            <label key={key}>
              {label}
              <input
                required={required}
                value={(form as Record<string, string>)[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </label>
          ))}
        </div>

        {!product && (
          <>
            <div className="divider" />

            <div className="form-grid">
              <label>
                LPBT price case (₱)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.lpbt_price_case}
                  onChange={(e) => set('lpbt_price_case', e.target.value)}
                />
              </label>

              <label>
                LPBT price pcs (₱)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.lpbt_price_pcs}
                  onChange={(e) => set('lpbt_price_pcs', e.target.value)}
                />
              </label>

              <label>
                Effective date
                <input
                  type="date"
                  value={form.effective_date}
                  onChange={(e) => set('effective_date', e.target.value)}
                />
              </label>
            </div>

            <div className="preview-prices">
              <div>
                <span>LPAT case</span>
                <strong>₱{lpatCase}</strong>
              </div>
              <div>
                <span>LPAT pcs</span>
                <strong>₱{lpatPcs}</strong>
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>

          <button className="btn" onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : product ? 'Save changes' : 'Create product'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// PRICE BATCH MODAL
// =====================================================

function BatchModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    lpbt_price_case: '',
    lpbt_price_pcs: '',
    effective_date: new Date().toISOString().slice(0, 10),
    remarks: '',
  })

  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key: string, value: string) => {
    setForm((old) => ({ ...old, [key]: value }))
  }

  const submit = async () => {
    if (
      form.lpbt_price_case === '' ||
      form.lpbt_price_pcs === '' ||
      Number(form.lpbt_price_case) < 0 ||
      Number(form.lpbt_price_pcs) < 0
    ) {
      setError('Please enter valid LPBT case and pcs prices.')
      return
    }

    if (
      !window.confirm(
        'Replace the current price batch? Previous price history will be preserved.'
      )
    ) {
      return
    }

    setError('')
    setSaving(true)

    try {
      await api('/api/admin/batches', {
        method: 'POST',
        body: JSON.stringify({
          effective_date: form.effective_date,
          notes: form.remarks,
          items: [
            {
              product_id: product.id,
              lpbt_price_case: Number(form.lpbt_price_case),
              lpbt_price_pcs: Number(form.lpbt_price_pcs),
            },
          ],
        }),
      })

      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save batch')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal small">
        <div className="modal-head">
          <div>
            <span className="eyebrow">Price batch</span>
            <h2>Add new prices</h2>
            <small>Batch ID will be generated automatically.</small>
          </div>

          <button onClick={onClose}>
            <X />
          </button>
        </div>

        <p>{product.item_code} - {product.item_description}</p>

        {error && <div className="error">{error}</div>}

        <div className="form-grid">
          <label>
            Effective date
            <input
              type="date"
              value={form.effective_date}
              onChange={(e) => set('effective_date', e.target.value)}
            />
          </label>

          <label>
            LPBT case (₱)
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.lpbt_price_case}
              onChange={(e) => set('lpbt_price_case', e.target.value)}
            />
          </label>

          <label>
            LPBT pcs (₱)
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.lpbt_price_pcs}
              onChange={(e) => set('lpbt_price_pcs', e.target.value)}
            />
          </label>
        </div>

        <label>
          Remarks
          <textarea
            value={form.remarks}
            onChange={(e) => set('remarks', e.target.value)}
          />
        </label>

        <div className="preview-prices">
          <div>
            <span>LPAT case</span>
            <strong>
              ₱{(Number(form.lpbt_price_case || 0) * 1.12).toFixed(2)}
            </strong>
          </div>

          <div>
            <span>LPAT pcs</span>
            <strong>
              ₱{(Number(form.lpbt_price_pcs || 0) * 1.12).toFixed(2)}
            </strong>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>

          <button className="btn" onClick={submit} disabled={saving}>
            {saving ? 'Saving...' : 'Save batch'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// ADMIN PRODUCT MANAGEMENT
// =====================================================

function AdminPage() {
  const [items, setItems] = useState<Product[]>([])
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<Product | 'new' | null>(null)
  const [batch, setBatch] = useState<Product | null>(null)

  const [history, setHistory] = useState<{
    product: Product
    batches: Batch[]
  } | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')

    try {
      const data = await api(
        `/api/admin/products?q=${encodeURIComponent(query)}&limit=50`
      )

      setItems(data.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load products')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const id = window.setTimeout(load, 300)
    return () => window.clearTimeout(id)
  }, [query])

  // Activate / deactivate product
  const toggleStatus = async (p: Product) => {
    if (
      !window.confirm(
        `${p.is_active ? 'Deactivate' : 'Activate'} ${p.item_description}?`
      )
    ) {
      return
    }

    try {
      await api(`/api/admin/products/${p.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: !p.is_active,
        }),
      })

      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Unable to update product status')
    }
  }

  // View product price history
  const viewHistory = async (p: Product) => {
    try {
      const batches = await api(`/api/admin/products/${p.id}/history`)
      setHistory({
        product: p,
        batches: Array.isArray(batches) ? batches : batches.items || [],
      })
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Unable to load price history')
    }
  }

  // Import CSV
  const importCsv = async (file: File) => {
    try {
      const text = await file.text()

      const lines = text.split(/\r?\n/).filter(Boolean)

      const headers =
        lines.shift()?.split(',').map((x) => x.trim()) || []

      const rows = lines.map((line) => {
        const values = line.split(',').map((x) => x.trim())

        return Object.fromEntries(
          headers.map((header, i) => [header, values[i] || ''])
        )
      })

      const summary = await api('/api/admin/import', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      })

      alert(
        `Imported ${summary.imported} row(s). Skipped ${summary.skipped}.`
      )

      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Import failed')
    }
  }

  // Export CSV
  const exportCsv = async () => {
    try {
      const response = await fetch('/api/admin/export?inactive=true')

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Export failed')
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = url
      a.download = 'product-prices.csv'
      a.click()

      URL.revokeObjectURL(url)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Export failed')
    }
  }

  return (
    <main className="container admin">
      <div className="admin-head">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Product management</h1>
        </div>

        <div className="actions">
          <label className="btn secondary upload">
            <Upload size={17} /> Import

            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0]

                if (file) {
                  importCsv(file)
                  e.target.value = ''
                }
              }}
            />
          </label>

          <button className="btn secondary" onClick={exportCsv}>
            <Download size={17} /> Export
          </button>

          <button className="btn" onClick={() => setForm('new')}>
            <Plus size={17} /> Add product
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="table-search">
          <Search size={18} />

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products..."
          />
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Brand</th>
              <th>Batch</th>
              <th>LPAT case</th>
              <th>LPAT pcs</th>
              <th>Status</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="loading-row">
                  Loading products...
                </td>
              </tr>
            ) : (
              items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.item_code}</strong>
                    <span>{p.item_description}</span>
                  </td>

                  <td>{p.brand || '—'}</td>
                  <td>{p.batch_id || '—'}</td>

                  <td>
                    {p.lpat_price_case != null
                      ? money(p.lpat_price_case)
                      : '—'}
                  </td>

                  <td>
                    {p.lpat_price_pcs != null
                      ? money(p.lpat_price_pcs)
                      : '—'}
                  </td>

                  <td>
                    <span
                      className={`status ${
                        p.is_active ? 'active' : 'inactive'
                      }`}
                    >
                      {p.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>

                  <td>{p.updated_at?.slice(0, 10) || '—'}</td>

                  <td>
                    <div className="row-actions">
                      <button
                        title="Edit"
                        onClick={() => setForm(p)}
                      >
                        <Edit3 size={16} />
                      </button>

                      <button
                        title="Add batch"
                        onClick={() => setBatch(p)}
                      >
                        <Plus size={16} />
                      </button>

                      <button
                        title="History"
                        onClick={() => viewHistory(p)}
                      >
                        <History size={16} />
                      </button>

                      <button
                        title={p.is_active ? 'Deactivate' : 'Activate'}
                        onClick={() => toggleStatus(p)}
                      >
                        <Power size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && !items.length && (
        <div className="empty-state">
          <Package size={40} />
          <h2>No products found</h2>
        </div>
      )}

      {(form === 'new' || form) && (
        <ProductForm
          product={form === 'new' ? null : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            load()
          }}
        />
      )}

      {batch && (
        <BatchModal
          product={batch}
          onClose={() => setBatch(null)}
          onSaved={() => {
            setBatch(null)
            load()
          }}
        />
      )}

      {history && (
        <div className="modal-backdrop">
          <div className="modal history-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">
                  {history.product.item_code}
                </span>
                <h2>Price history</h2>
              </div>

              <button onClick={() => setHistory(null)}>
                <X />
              </button>
            </div>

            <p className="history-name">
              {history.product.item_description}
            </p>

            <div className="history-list">
              {history.batches.map((b) => (
                <div className="history-item" key={b.id}>
                  <div>
                    <strong>{b.batch_id || 'Batch'}</strong>

                    <span
                      className={`status ${
                        b.is_current ? 'active' : 'inactive'
                      }`}
                    >
                      {b.is_current ? 'Current' : 'Historical'}
                    </span>
                  </div>

                  <dl>
                    <dt>LPBT Case</dt>
                    <dd>{money(b.lpbt_price_case)}</dd>

                    <dt>LPBT Pcs</dt>
                    <dd>{money(b.lpbt_price_pcs)}</dd>

                    <dt>LPAT Case</dt>
                    <dd>{money(b.lpat_price_case)}</dd>

                    <dt>LPAT Pcs</dt>
                    <dd>{money(b.lpat_price_pcs)}</dd>

                    <dt>Effective</dt>
                    <dd>{b.effective_date || '—'}</dd>
                  </dl>
                </div>
              ))}

              {!history.batches.length && (
                <p>No price history available.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

// =====================================================
// MAIN APP
// =====================================================

export default function App() {
  const [page, setPage] = useState<'search' | 'admin'>('search')
  const [menu, setMenu] = useState(false)

  return (
    <>
      <header>
        <div className="nav">
          <button
            className="brand"
            onClick={() => setPage('search')}
          >
            <span className="logo">
              <Package size={23} />
            </span>

            <span>
              Product Price <b>Checker</b>
            </span>
          </button>

          <nav className={menu ? 'open' : ''}>
            <button
              className={page === 'search' ? 'active' : ''}
              onClick={() => {
                setPage('search')
                setMenu(false)
              }}
            >
              <Search size={17} /> Price Search
            </button>

            <button
              className={page === 'admin' ? 'active' : ''}
              onClick={() => {
                setPage('admin')
                setMenu(false)
              }}
            >
              <Boxes size={17} /> Product Management
            </button>
          </nav>

          <button
            className="menu"
            onClick={() => setMenu(!menu)}
            aria-label="Navigation menu"
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </header>

      {page === 'search' ? <SearchPage /> : <AdminPage />}

      <footer>
        <span>Product Price Checker</span>
        <span>Prices in Philippine Peso · Asia/Manila</span>
      </footer>
    </>
  )
}
