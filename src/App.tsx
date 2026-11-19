
import { useEffect, useRef, useState } from 'react'
import {
  Calculator, Check, ChevronRight, Download, Edit3, History, Package,
  Plus, Printer, RefreshCcw, Search, Upload, X, Power, Boxes, Tags, Trash2,
} from 'lucide-react'

type Product = {
  id: number
  item_code: string
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

const perPiecePrice = (casePrice: string, packSize: number) => {
  const price = Number(casePrice || 0)
  if (!Number.isFinite(price) || packSize <= 0) return '0.00'
  const caseCents = Math.round(price * 100 + Number.EPSILON)
  return (Math.round(caseCents / packSize) / 100).toFixed(2)
}

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

type ToastKind = 'success' | 'error' | 'info'

type ConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

type ConfirmRequest = ConfirmOptions & {
  resolve: (confirmed: boolean) => void
}

type ImportStatus =
  | { phase: 'reading'; fileName: string }
  | { phase: 'uploading'; fileName: string; rowCount: number }
  | { phase: 'complete'; fileName: string; imported: number; skipped: number; errors: string[] }
  | { phase: 'error'; fileName: string; message: string }

function notify(kind: ToastKind, title: string, message: string) {
  window.dispatchEvent(new CustomEvent('app-toast', {
    detail: { kind, title, message },
  }))
}

function askToConfirm(options: ConfirmOptions) {
  return new Promise<boolean>((resolve) => {
    window.dispatchEvent(new CustomEvent('app-confirm', {
      detail: { ...options, resolve },
    }))
  })
}

function ToastHost() {
  const [toasts, setToasts] = useState<Array<{ id: number; kind: ToastKind; title: string; message: string }>>([])

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: ToastKind; title: string; message: string }>).detail
      const id = Date.now() + Math.random()
      setToasts((current) => [...current, { id, ...detail }])
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, 4500)
    }

    window.addEventListener('app-toast', onToast)
    return () => window.removeEventListener('app-toast', onToast)
  }, [])

  return (
    <div className="toast-region" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div className={`toast ${toast.kind}`} key={toast.id}>
          <div className="toast-icon">
            {toast.kind === 'success' ? <Check size={18} /> : toast.kind === 'error' ? <X size={18} /> : <Package size={18} />}
          </div>
          <div>
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const activeRequest = useRef<ConfirmRequest | null>(null)
  const queuedRequests = useRef<ConfirmRequest[]>([])

  useEffect(() => {
    const onConfirm = (event: Event) => {
      const next = (event as CustomEvent<ConfirmRequest>).detail
      if (activeRequest.current) {
        queuedRequests.current.push(next)
      } else {
        activeRequest.current = next
        setRequest(next)
      }
    }

    window.addEventListener('app-confirm', onConfirm)
    return () => window.removeEventListener('app-confirm', onConfirm)
  }, [])

  if (!request) return null

  const respond = (confirmed: boolean) => {
    request.resolve(confirmed)
    const next = queuedRequests.current.shift() || null
    activeRequest.current = next
    setRequest(next)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && respond(false)}
    >
      <section
        className="modal small confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">Please confirm</span>
            <h2 id="confirm-title">{request.title}</h2>
          </div>
        </div>
        <p id="confirm-message" className="confirm-message">{request.message}</p>
        <div className="modal-actions">
          <button className="btn secondary" onClick={() => respond(false)}>
            Cancel
          </button>
          <button
            className={`btn${request.danger ? ' danger' : ''}`}
            onClick={() => respond(true)}
            autoFocus
          >
            {request.confirmLabel || 'Confirm'}
          </button>
        </div>
      </section>
    </div>
  )
}

function ImportStatusModal({
  status,
  onClose,
}: {
  status: ImportStatus
  onClose: () => void
}) {
  const busy = status.phase === 'reading' || status.phase === 'uploading'
  const title = busy
    ? 'Importing CSV'
    : status.phase === 'error'
      ? 'Import failed'
      : status.skipped
        ? 'Import completed with skipped rows'
        : 'Import complete'

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal small import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        aria-live="polite"
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">Product import</span>
            <h2 id="import-title">{title}</h2>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close import status">
            <X />
          </button>
        </div>

        <p className="import-file">{status.fileName}</p>

        {busy ? (
          <div className="import-progress">
            <p>
              <span className="spinner dark" />
              {status.phase === 'reading'
                ? 'Reading the CSV file...'
                : `Importing ${status.rowCount} row(s). Please keep this window open.`}
            </p>
            <div className="progress-track" role="progressbar" aria-label="Import in progress">
              <div className="progress-bar" />
            </div>
          </div>
        ) : status.phase === 'error' ? (
          <div className="error">{status.message}</div>
        ) : (
          <>
            <div className="import-summary">
              <div>
                <span>Imported</span>
                <strong>{status.imported}</strong>
              </div>
              <div>
                <span>Skipped</span>
                <strong>{status.skipped}</strong>
              </div>
            </div>
            {status.errors.length > 0 && (
              <ul className="import-errors">
                {status.errors.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="modal-actions">
          {!busy && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </section>
    </div>
  )
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
  item_description: '',
  grammage: '',
  pack_size: '',
  brand: '',
  category: '',
  lpbt_price_case: '',
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

  const caseBase = product.lpbt_price_case || 0
  const pcsBase = product.lpbt_price_pcs || 0

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

      notify('success', 'Calculation copied', 'The result was copied to the clipboard.')
    } catch {
      notify('error', 'Copy failed', 'Please check browser clipboard permissions.')
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
          <span>LPBT case</span>
          <strong>{money(caseBase)}</strong>
        </div>
        <div>
          <span>LPBT pcs</span>
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
    let active = true
    window.clearTimeout(timer.current)

    if (selected) {
      setSuggestions([])
      setOpen(false)
      setLoading(false)
      return () => {
        active = false
      }
    }

    if (!query.trim()) {
      setSuggestions([])
      setOpen(false)
      setLoading(false)
      return () => {
        active = false
      }
    }

    setLoading(true)

    timer.current = window.setTimeout(async () => {
      try {
        const data = await api(
          `/api/products/search?q=${encodeURIComponent(query.trim())}&limit=8`
        )

        if (!active) return
        setSuggestions(data.items || [])
        setOpen(true)
      } catch {
        if (!active) return
        setSuggestions([])
        setOpen(true)
      } finally {
        if (active) setLoading(false)
      }
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timer.current)
    }
  }, [query, selected])

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
        <p>Search by item code, description, brand or category.</p>

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
  brands,
  categories,
  onClose,
  onSaved,
}: {
  product?: Product | null
  brands: string[]
  categories: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(
    product
      ? {
          item_code: product.item_code || '',
          item_description: product.item_description || '',
          grammage: product.grammage || '',
          pack_size: String(product.pack_size || ''),
          brand: product.brand || '',
          category: product.category || '',
          lpbt_price_case: product.lpbt_price_case == null ? '' : String(product.lpbt_price_case),
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

  const packSize = Number(form.pack_size)
  const lpbtPcs = perPiecePrice(form.lpbt_price_case, packSize)

  const submit = async () => {
    setError('')

    if (!form.item_code.trim() || !form.item_description.trim()) {
      const message = 'Item code and item description are required.'
      setError(message)
      notify('error', 'Missing required fields', message)
      return
    }

    if (!Number.isInteger(packSize) || packSize <= 0) {
      const message = 'Pack size must be a positive whole number.'
      setError(message)
      notify('error', 'Invalid pack size', message)
      return
    }

    if (
      form.lpbt_price_case === '' ||
      !Number.isFinite(Number(form.lpbt_price_case)) ||
      Number(form.lpbt_price_case) < 0
    ) {
      const message = 'Please enter a valid LPBT case price.'
      setError(message)
      notify('error', 'Invalid price', message)
      return
    }

    setSaving(true)

    try {
      if (product) {
        await api(`/api/admin/products/${product.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            ...form,
            pack_size: String(packSize),
            lpbt_price_case: String(Number(form.lpbt_price_case)),
          }),
        })
      } else {
        await api('/api/admin/products', {
          method: 'POST',
          body: JSON.stringify({
            item_code: form.item_code,
            item_description: form.item_description,
            grammage: form.grammage,
            pack_size: String(packSize),
            brand: form.brand,
            category: form.category,
            lpbt_price_case: String(form.lpbt_price_case),
            effective_date: form.effective_date,
            remarks: form.remarks,
          }),
        })
      }

      notify('success', product ? 'Product updated' : 'Product created',
        product ? 'Product information was saved successfully.' : 'The product and its initial price batch were saved.')
      onSaved()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to save'
      setError(message)
      notify('error', 'Save failed', message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal product-modal">
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
            { key: 'item_description', label: 'Item description', required: true },
            { key: 'grammage', label: 'Grammage', required: false },
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
          <label>
            Pack size (pcs per case)
            <input
              type="number"
              min="1"
              step="1"
              required
                aria-invalid={!form.pack_size || packSize <= 0 || !Number.isInteger(packSize)}
              value={form.pack_size}
              onChange={(e) => set('pack_size', e.target.value)}
            />
          </label>
          <label>
            Brand
            <select value={form.brand} onChange={(e) => set('brand', e.target.value)}>
              <option value="">Select a brand</option>
              {form.brand && !brands.includes(form.brand) && <option value={form.brand}>{form.brand}</option>}
              {brands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
            </select>
          </label>
          <label>
            Category
            <select value={form.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Select a category</option>
              {form.category && !categories.includes(form.category) && <option value={form.category}>{form.category}</option>}
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
        </div>

        <div className="divider" />

        <div className="form-grid">
          <label>
            LPBT price per case (₱)
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={form.lpbt_price_case}
              onChange={(e) => set('lpbt_price_case', e.target.value)}
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

        {product && <p className="form-note">Price changes create a new batch using this effective date; price history is preserved.</p>}

        <div className="preview-prices">
          <div>
            <span>LPBT per case</span>
            <strong>₱{Number(form.lpbt_price_case || 0).toFixed(2)}</strong>
          </div>
          <div>
            <span>LPBT per piece (automatic)</span>
            <strong>₱{lpbtPcs}</strong>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>

          <button className="btn" onClick={submit} disabled={saving} aria-busy={saving}>
            {saving && <span className="spinner" />}
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
    effective_date: new Date().toISOString().slice(0, 10),
    remarks: '',
  })

  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key: string, value: string) => {
    setForm((old) => ({ ...old, [key]: value }))
  }

  const packSize = Number(product.pack_size)
  const lpbtPcs = perPiecePrice(form.lpbt_price_case, packSize)

  const submit = async () => {
    if (
      form.lpbt_price_case === '' ||
      !Number.isFinite(Number(form.lpbt_price_case)) ||
      Number(form.lpbt_price_case) < 0
    ) {
      const message = 'Please enter a valid LPBT case price.'
      setError(message)
      notify('error', 'Invalid price', message)
      return
    }

    if (!Number.isInteger(packSize) || packSize <= 0) {
      const message = 'Set a positive whole-number pack size for this product before adding prices.'
      setError(message)
      notify('error', 'Invalid pack size', message)
      return
    }

    if (!await askToConfirm({
      title: 'Replace the current price batch?',
      message: 'A new batch will become current. Previous price history will be preserved.',
      confirmLabel: 'Save new batch',
    })) {
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
            },
          ],
        }),
      })

      notify('success', 'Price batch saved', 'The new price batch was created and is now current.')
      onSaved()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to save batch'
      setError(message)
      notify('error', 'Batch save failed', message)
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
            <span>LPBT case</span>
            <strong>₱{Number(form.lpbt_price_case || 0).toFixed(2)}</strong>
          </div>
          <div>
            <span>LPBT pcs (automatic)</span>
            <strong>₱{lpbtPcs}</strong>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>

          <button className="btn" onClick={submit} disabled={saving} aria-busy={saving}>
            {saving && <span className="spinner" />}
            {saving ? 'Saving...' : 'Save batch'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CatalogSection({
  type,
  values,
  onChanged,
}: {
  type: 'brand' | 'category'
  values: string[]
  onChanged: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const label = type === 'brand' ? 'Brand' : 'Category'

  const add = async () => {
    setError('')
    setSaving(true)
    try {
      await api('/api/admin/lookups', {
        method: 'POST',
        body: JSON.stringify({ type, value }),
      })
      setValue('')
      notify('success', `${label} added`, `"${value.trim()}" is now available in the dropdown.`)
      await onChanged()
    } catch (e) {
      const message = e instanceof Error ? e.message : `Unable to add ${label.toLowerCase()}`
      setError(message)
      notify('error', `Could not add ${label.toLowerCase()}`, message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: string) => {
    if (!await askToConfirm({
      title: `Remove ${label.toLowerCase()}?`,
      message: `"${item}" will be removed from the available ${label.toLowerCase()} list.`,
      confirmLabel: 'Remove',
      danger: true,
    })) return
    setError('')
    try {
      await api('/api/admin/lookups', {
        method: 'DELETE',
        body: JSON.stringify({ type, value: item }),
      })
      notify('success', `${label} removed`, `"${item}" was removed from the list.`)
      await onChanged()
    } catch (e) {
      const message = e instanceof Error ? e.message : `Unable to remove ${label.toLowerCase()}`
      setError(message)
      notify('error', `Could not remove ${label.toLowerCase()}`, message)
    }
  }

  return (
    <section className="catalog-section">
      <h3>{label}s</h3>
      <div className="catalog-add">
        <input
          aria-label={`New ${label.toLowerCase()}`}
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Add ${label.toLowerCase()}`}
        />
        <button className="btn" onClick={add} disabled={saving || !value.trim()} aria-busy={saving}>
          {saving ? <span className="spinner" /> : <Plus size={16} />}
          {saving ? 'Saving...' : 'Add'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <ul className="catalog-list">
        {values.map((item) => (
          <li key={item}>
            <span>{item}</span>
            <button type="button" onClick={() => remove(item)} aria-label={`Remove ${item}`}>
              <X size={16} />
            </button>
          </li>
        ))}
        {!values.length && <li className="catalog-empty">No {label.toLowerCase()}s added.</li>}
      </ul>
    </section>
  )
}

function CatalogManager({
  brands,
  categories,
  onClose,
  onChanged,
}: {
  brands: string[]
  categories: string[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">Product lists</span>
            <h2>Manage brands and categories</h2>
          </div>
          <button onClick={onClose} aria-label="Close list maintenance">
            <X />
          </button>
        </div>
        <div className="catalog-grid">
          <CatalogSection type="brand" values={brands} onChanged={onChanged} />
          <CatalogSection type="category" values={categories} onChanged={onChanged} />
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
  const [catalog, setCatalog] = useState<{ brands: string[]; categories: string[] }>({ brands: [], categories: [] })
  const [manageCatalog, setManageCatalog] = useState(false)

  const [history, setHistory] = useState<{
    product: Product
    batches: Batch[]
  } | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const [exporting, setExporting] = useState(false)

  const loadCatalog = async () => {
    const data = await api('/api/admin/lookups')
    setCatalog({
      brands: Array.isArray(data.brands) ? data.brands : [],
      categories: Array.isArray(data.categories) ? data.categories : [],
    })
    setCatalogError('')
  }

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
    loadCatalog().catch((e) => {
      setCatalogError(e instanceof Error ? e.message : 'Unable to load brand and category lists')
    })
  }, [])

  useEffect(() => {
    const id = window.setTimeout(load, 300)
    return () => window.clearTimeout(id)
  }, [query])

  // Activate / deactivate product
  const toggleStatus = async (p: Product) => {
    const action = p.is_active ? 'Deactivate' : 'Activate'
    if (!await askToConfirm({
      title: `${action} product?`,
      message: `${p.item_description} will be ${p.is_active ? 'hidden from' : 'available in'} public search.`,
      confirmLabel: action,
      danger: Boolean(p.is_active),
    })) {
      return
    }

    try {
      await api(`/api/admin/products/${p.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_active: !p.is_active,
        }),
      })

      notify('success', p.is_active ? 'Product deactivated' : 'Product activated',
        `${p.item_description} is now ${p.is_active ? 'inactive' : 'active'}.`)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to update product status'
      notify('error', 'Status update failed', message)
    }
  }

  const deleteProduct = async (p: Product) => {
    if (!await askToConfirm({
      title: 'Delete product permanently?',
      message: `${p.item_description} and its price history will be permanently deleted.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    })) {
      return
    }

    try {
      await api(`/api/admin/products/${p.id}`, { method: 'DELETE' })
      notify('success', 'Product deleted', `${p.item_description} was permanently deleted.`)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to delete product'
      notify('error', 'Delete failed', message)
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
      const message = e instanceof Error ? e.message : 'Unable to load price history'
      notify('error', 'Could not load history', message)
    }
  }

  // Import CSV
  const importCsv = async (file: File) => {
    setImporting(true)
    setImportStatus({ phase: 'reading', fileName: file.name })
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

      setImportStatus({ phase: 'uploading', fileName: file.name, rowCount: rows.length })
      const summary = await api('/api/admin/import', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      })

      setImportStatus({
        phase: 'complete',
        fileName: file.name,
        imported: Number(summary.imported) || 0,
        skipped: Number(summary.skipped) || 0,
        errors: Array.isArray(summary.errors)
          ? summary.errors.filter((message: unknown): message is string => typeof message === 'string')
          : [],
      })

      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Import failed'
      setImportStatus({ phase: 'error', fileName: file.name, message })
    } finally {
      setImporting(false)
    }
  }

  // Export CSV
  const exportCsv = async () => {
    setExporting(true)
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
      notify('success', 'Export downloaded', 'The product CSV export was created successfully.')
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Export failed'
      notify('error', 'Export failed', message)
    } finally {
      setExporting(false)
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
          <button className="btn secondary" onClick={() => setManageCatalog(true)}>
            <Tags size={17} /> Manage lists
          </button>

          <label className={`btn secondary upload ${importing ? 'disabled-action' : ''}`} aria-busy={importing}>
            {importing ? <span className="spinner dark" /> : <Upload size={17} />}
            {importing ? 'Importing...' : 'Import'}

            <input
              type="file"
              accept=".csv,text/csv"
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0]

                if (file) {
                  importCsv(file)
                  e.target.value = ''
                }
              }}
            />
          </label>

          <button className="btn secondary" onClick={exportCsv} disabled={exporting} aria-busy={exporting}>
            {exporting ? <span className="spinner dark" /> : <Download size={17} />}
            {exporting ? 'Exporting...' : 'Export'}
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
      {catalogError && <div className="error">{catalogError}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Brand</th>
              <th>Batch</th>
              <th>LPBT case</th>
              <th>LPBT pcs</th>
              <th>Status</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="loading-row">
                  <span className="table-loader"><span className="spinner dark" /> Loading products...</span>
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
                    {p.lpbt_price_case != null
                      ? money(p.lpbt_price_case)
                      : '—'}
                  </td>

                  <td>
                    {p.lpbt_price_pcs != null
                      ? money(p.lpbt_price_pcs)
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

                      <button
                        title="Delete permanently"
                        aria-label={`Delete ${p.item_description}`}
                        onClick={() => deleteProduct(p)}
                      >
                        <Trash2 size={16} />
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
          brands={catalog.brands}
          categories={catalog.categories}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            load()
          }}
        />
      )}

      {manageCatalog && (
        <CatalogManager
          brands={catalog.brands}
          categories={catalog.categories}
          onClose={() => setManageCatalog(false)}
          onChanged={loadCatalog}
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

      {importStatus && (
        <ImportStatusModal
          status={importStatus}
          onClose={() => setImportStatus(null)}
        />
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

      <ToastHost />
      <ConfirmHost />

      <footer>
        <span>Product Price Checker</span>
        <span>Prices in Philippine Peso · Asia/Manila</span>
      </footer>
    </>
  )
}
