// StockScanner web — replica el comportamiento de StockScanner.py (Tkinter)
// sobre Supabase (Postgres + Auth + Realtime). Ver supabase/schema.sql.

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const USERS = {
  admin:  { email: "admin@stockscanner.local",  label: "Admin" },
  sergio: { email: "sergio@stockscanner.local", label: "Sergio" },
  leo:    { email: "leo@stockscanner.local",    label: "Leo" },
};
const EMAIL_TO_NAME = Object.fromEntries(
  Object.values(USERS).map((u) => [u.email, u.label])
);

const state = {
  currentUserLabel: "",
  currentTab: "scanner",
  productos: [],
  movimientos: [],
  histFiltro: "todos",
  prodEditId: null,
  scanLastResult: null,
};

// ── Helpers ──────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
function formatMoney(v) {
  const n = Number(v) || 0;
  return n ? `$${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}` : "—";
}
function nowStamp() {
  return new Date().toISOString();
}
function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

// ── Login ────────────────────────────────────────────────────
let selectedUserKey = null;

$all(".user-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedUserKey = btn.dataset.user;
    $("#login-selected-user").textContent = `Usuario: ${USERS[selectedUserKey].label}`;
    $("#login-user-select").classList.add("hidden");
    $("#login-password-form").classList.remove("hidden");
    $("#login-password").value = "";
    $("#login-password").focus();
    $("#login-error").classList.add("hidden");
  });
});

$("#login-back").addEventListener("click", () => {
  $("#login-password-form").classList.add("hidden");
  $("#login-user-select").classList.remove("hidden");
  selectedUserKey = null;
});

$("#login-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedUserKey) return;
  const password = $("#login-password").value;
  const errEl = $("#login-error");
  const statusEl = $("#login-status");
  errEl.classList.add("hidden");
  statusEl.classList.remove("hidden");
  $("#login-submit").disabled = true;

  const { error } = await sb.auth.signInWithPassword({
    email: USERS[selectedUserKey].email,
    password,
  });

  statusEl.classList.add("hidden");
  $("#login-submit").disabled = false;

  if (error) {
    errEl.textContent = "Usuario o contraseña incorrectos.";
    errEl.classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((event, session) => {
  if (session) {
    onLoggedIn(session);
  } else {
    onLoggedOut();
  }
});

let realtimeChannel = null;

async function onLoggedIn(session) {
  state.currentUserLabel = EMAIL_TO_NAME[session.user.email] || session.user.email;
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#logged-in-as").textContent = `Conectado: ${state.currentUserLabel}`;

  await loadProductos();
  await loadMovimientos();
  showTab("scanner");
  refreshAlertBadge();
  subscribeRealtime();
}

function onLoggedOut() {
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#login-password-form").classList.add("hidden");
  $("#login-user-select").classList.remove("hidden");
  selectedUserKey = null;
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

function subscribeRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = sb
    .channel("stock-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "productos" }, onRemoteChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "movimientos" }, onRemoteChange)
    .subscribe();
}

async function onRemoteChange() {
  await loadProductos();
  await loadMovimientos();
  refreshAlertBadge();
  // re-renderiza la pestaña activa para reflejar el cambio al instante
  renderCurrentTab();
}

// ── Data loading ─────────────────────────────────────────────
async function loadProductos() {
  const { data, error } = await sb.from("productos").select("*").order("nombre");
  if (!error) state.productos = data || [];
}

async function loadMovimientos() {
  const { data, error } = await sb
    .from("movimientos")
    .select("*")
    .order("id", { ascending: false })
    .limit(200);
  if (!error) state.movimientos = data || [];
}

function normalizarCodigo(codigo) {
  return (codigo || "").trim().toLowerCase();
}

function productoPorCodigo(codigo) {
  const buscado = normalizarCodigo(codigo);
  return state.productos.find((p) => normalizarCodigo(p.codigo) === buscado);
}

// ── Nav / tabs ───────────────────────────────────────────────
$all(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

function showTab(key) {
  state.currentTab = key;
  $all(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === key));
  renderCurrentTab();
}

function renderCurrentTab() {
  const renderers = {
    scanner: renderScanner,
    stock: renderStock,
    historial: renderHistorial,
    productos: renderProductos,
    alertas: renderAlertas,
  };
  renderers[state.currentTab]?.();
}

function refreshAlertBadge() {
  const count = state.productos.filter((p) => p.stock <= p.stock_min).length;
  const label = $("#nav-alertas .nav-main");
  label.textContent = count > 0 ? `⚠  Alertas  (${count})` : "⚠  Alertas";
}

// ── ESCANEAR ─────────────────────────────────────────────────
function renderScanner() {
  const content = $("#content");
  content.innerHTML = `
    <h2 class="tab-title">◉  Escanear Producto</h2>
    <div class="scan-card">
      <label>CÓDIGO DE BARRAS</label>
      <div class="scan-entry-row">
        <input id="scan-input" autofocus />
        <button class="btn-buscar" id="scan-buscar-btn">Buscar  ⏎</button>
      </div>
      <p class="scan-hint">Apuntá el lector al código — el resultado aparece abajo automáticamente</p>
    </div>
    <div class="tipo-row">
      <label class="field-label">TIPO DE MOVIMIENTO:</label>
      <label class="tipo-opt entrada"><input type="radio" name="tipo" value="entrada" checked /> ▲ ENTRADA</label>
      <label class="tipo-opt salida"><input type="radio" name="tipo" value="salida" /> ▼ SALIDA</label>
      <label class="tipo-opt ajuste"><input type="radio" name="tipo" value="ajuste" /> ◎ AJUSTE</label>
    </div>
    <div class="qty-row">
      <label class="field-label">CANTIDAD:</label>
      <input type="number" id="qty-input" value="1" min="1" />
      <label class="field-label">NOTA:</label>
      <input type="text" id="nota-input" />
    </div>
    <div class="result-frame" id="scan-result-frame">
      <div class="placeholder">Esperando escaneo...</div>
    </div>
  `;

  const input = $("#scan-input");
  input.focus();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") processScan();
  });
  $("#scan-buscar-btn").addEventListener("click", processScan);
}

function processScan() {
  const input = $("#scan-input");
  const codigo = input.value.trim();
  if (!codigo) return;
  input.value = "";

  const prod = productoPorCodigo(codigo);
  const frame = $("#scan-result-frame");

  if (prod) {
    showScanResult(frame, prod, codigo);
  } else {
    showScanUnknown(frame, codigo);
  }
}

function currentTipoQtyNota() {
  const tipo = $('input[name="tipo"]:checked').value;
  const qty = Math.max(1, parseInt($("#qty-input").value, 10) || 1);
  const nota = $("#nota-input").value.trim();
  return { tipo, qty, nota };
}

function showScanResult(frame, prod, codigo) {
  const { tipo, qty, nota } = currentTipoQtyNota();
  const color = tipo === "entrada" ? "var(--green)" : tipo === "salida" ? "var(--red)" : "var(--yellow)";

  const stockPrev = prod.stock;
  let stockPost;
  if (tipo === "entrada") stockPost = stockPrev + qty;
  else if (tipo === "salida") stockPost = Math.max(0, stockPrev - qty);
  else stockPost = qty; // ajuste: valor absoluto, no delta

  const stkColor = stockPrev > prod.stock_min ? "var(--green)" : stockPrev > 0 ? "var(--yellow)" : "var(--red)";

  frame.innerHTML = `
    <div class="scan-result-card">
      <div class="scan-result-left">
        <div class="nombre">${escapeHtml(prod.nombre)}</div>
        <div class="meta">Código: ${escapeHtml(prod.codigo)}   Categoría: ${escapeHtml(prod.categoria || "—")}</div>
      </div>
      <div class="scan-result-right">
        <div class="lbl">STOCK ACTUAL</div>
        <div class="val" style="color:${stkColor}">${stockPrev}</div>
      </div>
    </div>
    <div class="scan-mv-frame">
      <span class="mv-label" style="color:${color}">Movimiento: ${tipo.toUpperCase()}  ${qty} unidad${qty > 1 ? "es" : ""}</span>
      <span class="mv-arrow">${stockPrev}  →  ${stockPost}</span>
      ${nota ? `<span style="color:var(--fg2)">Nota: ${escapeHtml(nota)}</span>` : ""}
    </div>
    <div class="btn-row">
      <button class="btn-confirm" id="btn-confirmar" style="background:${color}">✓  CONFIRMAR ${tipo.toUpperCase()}</button>
      <button class="btn-cancel" id="btn-cancelar">✕  Cancelar</button>
    </div>
  `;

  $("#btn-confirmar").addEventListener("click", () =>
    confirmarMovimiento(prod, prod.codigo, tipo, qty, nota, stockPrev, stockPost, frame)
  );
  $("#btn-cancelar").addEventListener("click", () => {
    frame.innerHTML = '<div class="placeholder">Esperando escaneo...</div>';
  });
}

async function confirmarMovimiento(prod, codigo, tipo, qty, nota, stockPrev, stockPost, frame) {
  const btn = $("#btn-confirmar");
  if (btn) btn.disabled = true;

  const { error: updErr } = await sb.from("productos").update({ stock: stockPost }).eq("codigo", codigo);
  if (updErr) {
    alert(`No se pudo guardar el movimiento.\n\nDetalle: ${updErr.message}`);
    if (btn) btn.disabled = false;
    return;
  }
  const { error: insErr } = await sb.from("movimientos").insert({
    codigo,
    tipo,
    cantidad: qty,
    stock_prev: stockPrev,
    stock_post: stockPost,
    nota,
    usuario: state.currentUserLabel,
    fecha: nowStamp(),
  });
  if (insErr) {
    alert(`El stock se actualizó pero no se pudo registrar el movimiento.\n\nDetalle: ${insErr.message}`);
  }

  $("#nota-input") && ($("#nota-input").value = "");
  $("#qty-input") && ($("#qty-input").value = "1");

  frame.innerHTML = `
    <div class="scan-result-card" style="display:block;text-align:center;padding:20px">
      <span style="color:var(--green);font-size:14px;font-weight:bold">
        ✓  ${escapeHtml(prod.nombre)}  —  ${tipo.toUpperCase()} de ${qty} unidades registrada
      </span>
    </div>
    <p style="text-align:center;color:var(--fg2)">Stock: ${stockPrev} → ${stockPost}</p>
  `;

  await loadProductos();
  await loadMovimientos();
  refreshAlertBadge();
  $("#scan-input")?.focus();
}

function showScanUnknown(frame, codigo) {
  frame.innerHTML = `
    <div class="unknown-card">
      <h3>⚠  Código no encontrado en el sistema</h3>
      <p class="codigo">Código escaneado: ${escapeHtml(codigo)}</p>
      <p>Primero tenés que agregar este producto en ＋ Productos</p>
      <button class="btn-buscar" id="btn-ir-productos">＋  Ir a Agregar Producto</button>
    </div>
  `;
  $("#btn-ir-productos").addEventListener("click", () => {
    showTab("productos");
    setTimeout(() => {
      const codigoInput = $("#prod-codigo");
      if (codigoInput) {
        codigoInput.value = codigo;
        $("#prod-nombre")?.focus();
      }
    }, 0);
  });
}

// ── INVENTARIO ───────────────────────────────────────────────
function renderStock() {
  const content = $("#content");
  content.innerHTML = `
    <h2 class="tab-title">☰  Inventario</h2>
    <div class="toolbar">
      <span>Buscar:</span>
      <input type="text" id="stock-search" />
      <div class="spacer"></div>
      <button class="btn-tool" id="stock-export">↑↓  Exportar CSV</button>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Código</th><th>Nombre</th><th>Categoría</th>
          <th class="center">Stock</th><th class="center">Mín.</th>
          <th class="center">Precio</th><th class="center">Estado</th><th class="center">Acciones</th>
        </tr>
      </thead>
      <tbody id="stock-tbody"></tbody>
    </table>
  `;
  $("#stock-search").addEventListener("input", renderStockRows);
  $("#stock-export").addEventListener("click", exportCsv);
  renderStockRows();
}

function renderStockRows() {
  const q = ($("#stock-search")?.value || "").trim().toLowerCase();
  const tbody = $("#stock-tbody");
  const rows = [...state.productos]
    .filter((p) => !q || p.nombre.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  tbody.innerHTML = rows
    .map((p) => {
      const estado = p.stock > p.stock_min ? "ok" : p.stock > 0 ? "low" : "empty";
      const estadoLabel = estado === "ok" ? "✓  OK" : estado === "low" ? "⚠  Bajo" : "✕  Sin stock";
      return `
        <tr class="estado-${estado}">
          <td>${escapeHtml(p.codigo)}</td>
          <td>${escapeHtml(p.nombre)}</td>
          <td>${escapeHtml(p.categoria || "—")}</td>
          <td class="center">${p.stock}</td>
          <td class="center">${p.stock_min}</td>
          <td class="center">${formatMoney(p.precio)}</td>
          <td class="center">${estadoLabel}</td>
          <td class="actions center">
            <button class="icon-btn" data-action="edit-stock" data-id="${p.id}" title="Editar stock">✎ Stock</button>
            <button class="icon-btn" data-action="edit-producto" data-id="${p.id}" title="Editar producto">⚙</button>
          </td>
        </tr>`;
    })
    .join("");

  $all('[data-action="edit-stock"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => openEditStockModal(btn.dataset.id))
  );
  $all('[data-action="edit-producto"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => {
      showTab("productos");
      setTimeout(() => loadProductoInForm(btn.dataset.id), 0);
    })
  );
}

function exportCsv() {
  const header = ["Código", "Nombre", "Categoría", "Stock", "Stock Mínimo", "Precio"];
  const lines = [header.join(",")];
  [...state.productos]
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .forEach((p) => {
      const row = [p.codigo, p.nombre, p.categoria || "", p.stock, p.stock_min, p.precio || 0].map((v) =>
        `"${String(v).replace(/"/g, '""')}"`
      );
      lines.push(row.join(","));
    });
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  a.href = url;
  a.download = `stock_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Modal: editar stock manual ───────────────────────────────
let editStockProdId = null;

function openEditStockModal(id) {
  const p = state.productos.find((x) => String(x.id) === String(id));
  if (!p) return;
  editStockProdId = p.id;
  $("#edit-stock-producto").textContent = `${p.nombre} (${p.codigo})`;
  $("#edit-stock-actual").textContent = `Stock actual: ${p.stock}`;
  $("#edit-stock-nuevo").value = p.stock;
  $("#edit-stock-motivo").value = "";
  $("#edit-stock-modal").classList.remove("hidden");
}

$("#edit-stock-cancel").addEventListener("click", () => {
  $("#edit-stock-modal").classList.add("hidden");
  editStockProdId = null;
});

$("#edit-stock-confirm").addEventListener("click", async () => {
  const p = state.productos.find((x) => x.id === editStockProdId);
  if (!p) return;
  const nuevo = parseInt($("#edit-stock-nuevo").value, 10);
  if (Number.isNaN(nuevo) || nuevo < 0) {
    alert("Ingresá un stock válido (0 o mayor).");
    return;
  }
  const motivo = $("#edit-stock-motivo").value.trim();
  const stockPrev = p.stock;

  const { error: updErr } = await sb.from("productos").update({ stock: nuevo }).eq("codigo", p.codigo);
  if (updErr) {
    alert(`No se pudo guardar.\n\nDetalle: ${updErr.message}`);
    return;
  }
  await sb.from("movimientos").insert({
    codigo: p.codigo,
    tipo: "ajuste",
    cantidad: nuevo,
    stock_prev: stockPrev,
    stock_post: nuevo,
    nota: motivo || "Edición manual de stock",
    usuario: state.currentUserLabel,
    fecha: nowStamp(),
  });

  $("#edit-stock-modal").classList.add("hidden");
  editStockProdId = null;
  await loadProductos();
  await loadMovimientos();
  refreshAlertBadge();
  renderCurrentTab();
});

// ── HISTORIAL ────────────────────────────────────────────────
function renderHistorial() {
  const content = $("#content");
  content.innerHTML = `
    <h2 class="tab-title">⏱  Historial de Movimientos</h2>
    <div class="hist-filters">
      <label><input type="radio" name="hist-filtro" value="todos" checked /> Todos</label>
      <label><input type="radio" name="hist-filtro" value="entrada" /> Entradas</label>
      <label><input type="radio" name="hist-filtro" value="salida" /> Salidas</label>
      <label><input type="radio" name="hist-filtro" value="ajuste" /> Ajustes</label>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Fecha</th><th>Código</th><th>Producto</th><th class="center">Tipo</th>
          <th class="center">Cant.</th><th class="center">Antes</th><th class="center">Después</th>
          <th>Usuario</th><th>Nota</th>
        </tr>
      </thead>
      <tbody id="hist-tbody"></tbody>
    </table>
  `;
  $all('input[name="hist-filtro"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.histFiltro = e.target.value;
      renderHistRows();
    })
  );
  renderHistRows();
}

function renderHistRows() {
  const tbody = $("#hist-tbody");
  const filtro = state.histFiltro;
  const rows = state.movimientos.filter((m) => filtro === "todos" || m.tipo === filtro);

  tbody.innerHTML = rows
    .map((m) => {
      const prod = productoPorCodigo(m.codigo);
      const nombre = prod ? prod.nombre : "—";
      return `
        <tr class="tipo-${m.tipo}">
          <td>${escapeHtml(m.fecha || "")}</td>
          <td>${escapeHtml(m.codigo)}</td>
          <td>${escapeHtml(nombre)}</td>
          <td class="tipo-cell center">${m.tipo.toUpperCase()}</td>
          <td class="center">${m.cantidad}</td>
          <td class="center">${m.stock_prev ?? "—"}</td>
          <td class="center">${m.stock_post ?? "—"}</td>
          <td>${escapeHtml(m.usuario || "—")}</td>
          <td>${escapeHtml(m.nota || "")}</td>
        </tr>`;
    })
    .join("");
}

// ── PRODUCTOS ────────────────────────────────────────────────
function renderProductos() {
  const content = $("#content");
  content.innerHTML = `
    <h2 class="tab-title">＋  Productos</h2>
    <div class="productos-layout">
      <div class="prod-form">
        <h3>NUEVO / EDITAR PRODUCTO</h3>
        <label class="required">Código de Barras *</label>
        <input id="prod-codigo" />
        <label class="required">Nombre / Descripción *</label>
        <input id="prod-nombre" />
        <label>Categoría</label>
        <input id="prod-categoria" />
        <label>Precio Unitario ($)</label>
        <input id="prod-precio" type="number" step="0.01" />
        <label>Stock Inicial</label>
        <input id="prod-stock" type="number" value="0" />
        <label>Stock Mínimo (alerta)</label>
        <input id="prod-stock-min" type="number" value="5" />
        <p class="hint">* campos obligatorios</p>
        <button class="btn-accent" id="prod-guardar">＋  Guardar Producto</button>
        <button class="btn-secondary" id="prod-limpiar">✕  Limpiar</button>
      </div>
      <div class="prod-list">
        <h3>CATÁLOGO  (✎ para editar)</h3>
        <table class="data-table">
          <thead>
            <tr><th>Código</th><th>Nombre</th><th>Categoría</th><th class="center">Stock</th><th class="center">Precio</th><th class="center">Acciones</th></tr>
          </thead>
          <tbody id="prod-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  $("#prod-guardar").addEventListener("click", guardarProducto);
  $("#prod-limpiar").addEventListener("click", limpiarProdForm);
  renderProdRows();
}

function limpiarProdForm() {
  state.prodEditId = null;
  $("#prod-codigo").value = "";
  $("#prod-nombre").value = "";
  $("#prod-categoria").value = "";
  $("#prod-precio").value = "";
  $("#prod-stock").value = "0";
  $("#prod-stock-min").value = "5";
  $("#prod-guardar").textContent = "＋  Guardar Producto";
}

function loadProductoInForm(id) {
  const p = state.productos.find((x) => String(x.id) === String(id));
  if (!p) return;
  state.prodEditId = p.id;
  $("#prod-codigo").value = p.codigo;
  $("#prod-nombre").value = p.nombre;
  $("#prod-categoria").value = p.categoria || "";
  $("#prod-precio").value = p.precio || "";
  $("#prod-stock").value = p.stock;
  $("#prod-stock-min").value = p.stock_min;
  $("#prod-guardar").textContent = "✎  Actualizar Producto";
}

async function guardarProducto() {
  const codigo = $("#prod-codigo").value.trim();
  const nombre = $("#prod-nombre").value.trim();
  if (!codigo || !nombre) {
    alert("Código y Nombre son obligatorios.");
    return;
  }
  const existente = productoPorCodigo(codigo);
  if (existente && existente.id !== state.prodEditId) {
    alert(`El código '${codigo}' ya existe como '${existente.codigo}' (${existente.nombre}).`);
    return;
  }

  const precio = parseFloat($("#prod-precio").value || "0");
  const stock = parseInt($("#prod-stock").value || "0", 10);
  const stockMin = parseInt($("#prod-stock-min").value || "5", 10);
  const categoria = $("#prod-categoria").value.trim();

  const payload = { codigo, nombre, categoria, precio, stock, stock_min: stockMin };

  let error;
  if (state.prodEditId) {
    ({ error } = await sb.from("productos").update(payload).eq("id", state.prodEditId));
  } else {
    payload.creado = nowStamp();
    ({ error } = await sb.from("productos").insert(payload));
  }

  if (error) {
    if (error.code === "23505") {
      alert(`El código '${codigo}' ya existe.`);
    } else {
      alert(`No se pudo guardar.\n\nDetalle: ${error.message}`);
    }
    return;
  }

  alert(state.prodEditId ? `Producto actualizado:\n${nombre}` : `Producto guardado:\n${nombre}`);
  limpiarProdForm();
  await loadProductos();
  refreshAlertBadge();
  renderProdRows();
}

function renderProdRows() {
  const tbody = $("#prod-tbody");
  tbody.innerHTML = [...state.productos]
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(
      (p) => `
        <tr>
          <td>${escapeHtml(p.codigo)}</td>
          <td>${escapeHtml(p.nombre)}</td>
          <td>${escapeHtml(p.categoria || "—")}</td>
          <td class="center">${p.stock}</td>
          <td class="center">${formatMoney(p.precio)}</td>
          <td class="actions center">
            <button class="icon-btn" data-action="edit" data-id="${p.id}">✎</button>
            <button class="icon-btn danger" data-action="delete" data-id="${p.id}">✕</button>
          </td>
        </tr>`
    )
    .join("");

  $all('[data-action="edit"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => loadProductoInForm(btn.dataset.id))
  );
  $all('[data-action="delete"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => eliminarProducto(btn.dataset.id))
  );
}

async function eliminarProducto(id) {
  const p = state.productos.find((x) => String(x.id) === String(id));
  if (!p) return;
  if (!confirm(`¿Eliminar '${p.nombre}'?`)) return;
  const { error } = await sb.from("productos").delete().eq("id", id);
  if (error) {
    alert(`No se pudo eliminar.\n\nDetalle: ${error.message}`);
    return;
  }
  await loadProductos();
  refreshAlertBadge();
  renderProdRows();
}

// ── ALERTAS ──────────────────────────────────────────────────
function renderAlertas() {
  const content = $("#content");
  const alertas = state.productos
    .filter((p) => p.stock <= p.stock_min)
    .sort((a, b) => a.stock - b.stock);

  if (alertas.length === 0) {
    content.innerHTML = `
      <h2 class="tab-title">⚠  Alertas de Stock</h2>
      <p style="color:var(--fg2)">0 productos con stock en o bajo el mínimo</p>
      <div class="alertas-ok">✓  Todo el stock está por encima del mínimo.</div>
    `;
    return;
  }

  content.innerHTML = `
    <h2 class="tab-title">⚠  Alertas de Stock</h2>
    <p style="color:var(--fg2)">${alertas.length} producto${alertas.length !== 1 ? "s" : ""} con stock en o bajo el mínimo</p>
    <div id="alertas-list"></div>
  `;

  $("#alertas-list").innerHTML = alertas
    .map((p) => {
      const color = p.stock === 0 ? "var(--red)" : "var(--yellow)";
      const icon = p.stock === 0 ? "✕" : "⚠";
      return `
        <div class="alert-card">
          <div class="icon" style="color:${color}">${icon}</div>
          <div class="info" style="flex:1">
            <div class="nombre">${escapeHtml(p.nombre)}</div>
            <div class="meta">Código: ${escapeHtml(p.codigo)}  ·  ${escapeHtml(p.categoria || "—")}</div>
          </div>
          <div class="alert-nums">
            <div class="grp"><div class="lbl">STOCK</div><div class="val" style="color:${color}">${p.stock}</div></div>
            <div class="grp"><div class="lbl">MÍNIMO</div><div class="val" style="color:var(--fg2)">${p.stock_min}</div></div>
          </div>
        </div>`;
    })
    .join("");
}

// Nota: onAuthStateChange (arriba) ya dispara un evento INITIAL_SESSION
// al suscribirse, incluyendo la sesión persistida de una recarga de página.
