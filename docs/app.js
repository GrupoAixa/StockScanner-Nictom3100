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
  pedidos: [],            // pedidos con sus pedido_items
  hasPedidos: false,      // existe la tabla pedidos (se corrió supabase/pedidos.sql)
  hasProdExtras: false,   // existen las columnas marca/color/... en productos
  pedFiltro: "abiertos",
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
    // TOKEN_REFRESHED (cada ~1h) no debe reiniciar la app ni cambiar de pestaña
    if (state.sessionUserId === session.user.id) return;
    state.sessionUserId = session.user.id;
    // fuera del callback de auth (supabase-js recomienda no hacer queries adentro)
    setTimeout(() => onLoggedIn(session), 0);
  } else {
    state.sessionUserId = null;
    onLoggedOut();
  }
});

let realtimeChannel = null;

async function onLoggedIn(session) {
  state.currentUserLabel = EMAIL_TO_NAME[session.user.email] || session.user.email;
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#logged-in-as").textContent = `Conectado: ${state.currentUserLabel}`;

  await detectSchema();
  await loadProductos();
  await loadMovimientos();
  await loadPedidos();
  state.popupCollapsed = false;
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
  $("#alert-popup").classList.add("hidden");
}

function subscribeRealtime() {
  if (realtimeChannel) return;
  let ch = sb
    .channel("stock-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "productos" }, onRemoteChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "movimientos" }, onRemoteChange);
  if (state.hasPedidos) {
    ch = ch
      .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, onRemoteChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "pedido_items" }, onRemoteChange);
  }
  realtimeChannel = ch.subscribe();
}

let remoteTimer = null;
function onRemoteChange() {
  // varios eventos seguidos (ej: pedido + sus items) -> una sola recarga
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(reloadFromRemote, 300);
}
async function reloadFromRemote() {
  // no re-renderizar formularios mientras alguien los está llenando
  const enForm = document.activeElement?.closest?.(".prod-form, .scan-card, .qty-row");
  await loadProductos();
  await loadMovimientos();
  await loadPedidos();
  refreshAlertBadge();
  // Escanear: no se re-renderiza (borraría un movimiento a medio confirmar)
  if (state.currentTab === "scanner") return;
  if (enForm) {
    if (state.currentTab === "productos") renderProdRows();
    return;
  }
  // re-renderiza la pestaña activa para reflejar el cambio al instante
  renderCurrentTab();
}

// ── Data loading ─────────────────────────────────────────────
async function loadProductos() {
  const { data, error } = await sb.from("productos").select("*").order("nombre");
  if (!error) state.productos = data || [];
  if (state.hasPedidos) fillDatalists();
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
    pedidos: renderPedidos,
  };
  renderers[state.currentTab]?.();
}

function refreshAlertBadge() {
  const count = state.productos.filter((p) => p.stock <= p.stock_min).length;
  const label = $("#nav-alertas .nav-main");
  label.textContent = count > 0 ? `⚠  Alertas  (${count})` : "⚠  Alertas";
  const abiertos = state.pedidos.filter((p) => p.estado === "Pedido").length;
  $("#nav-pedidos .nav-main").textContent = abiertos > 0 ? `🛒  Pedidos  (${abiertos})` : "🛒  Pedidos";
  renderAlertPopup();
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
      <button class="btn-tool" id="stock-export-pdf">⬇  Descargar PDF</button>
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
  $("#stock-export-pdf").addEventListener("click", exportPdf);
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

function exportPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

  // Orden: categoría (para agrupar visualmente) y luego nombre alfabético.
  const rows = [...state.productos].sort((a, b) => {
    const catA = (a.categoria || "").toLowerCase();
    const catB = (b.categoria || "").toLowerCase();
    if (catA !== catB) return catA.localeCompare(catB);
    return a.nombre.localeCompare(b.nombre);
  });

  const fecha = new Date().toLocaleString("es-AR");
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setTextColor(30, 30, 30);
  doc.text("StockScanner — Inventario", 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Generado: ${fecha}   ·   Total de productos: ${rows.length}`, 40, 56);

  doc.autoTable({
    startY: 70,
    head: [["Código", "Producto", "Categoría", "Cantidad"]],
    body: rows.map((p) => [p.codigo, p.nombre, p.categoria || "—", String(p.stock)]),
    styles: { fontSize: 9, cellPadding: 6, overflow: "linebreak", valign: "middle" },
    headStyles: { fillColor: [249, 115, 22], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: {
      0: { cellWidth: 85 },
      1: { cellWidth: "auto" }, // nombre completo, con salto de línea si hace falta
      2: { cellWidth: 100 },
      3: { cellWidth: 60, halign: "center" },
    },
    margin: { left: 40, right: 40 },
    tableWidth: pageWidth - 80,
    didDrawPage: () => {
      const pageCount = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(
        `Página ${doc.internal.getCurrentPageInfo().pageNumber} de ${pageCount}`,
        pageWidth - 90,
        doc.internal.pageSize.getHeight() - 20
      );
    },
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  doc.save(`inventario_${stamp}.pdf`);
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
        <div class="prod-extras ${state.hasProdExtras ? "" : "hidden"}">
          <h3 style="margin-top:16px">DATOS PARA PEDIDOS</h3>
          <label>Marca</label>
          <input id="prod-marca" />
          <label>Color</label>
          <input id="prod-color" />
          <label>Medida / Espesor</label>
          <input id="prod-medida" placeholder="Ej: 18mm, 2,75x1,83, 35mm" />
          <label>Proveedor habitual</label>
          <input id="prod-proveedor" list="ped-prov-list" />
          <label>Unidad</label>
          <select id="prod-unidad">${UNIDADES.map((u) => `<option>${u}</option>`).join("")}</select>
          <label>Cantidad a pedir al llegar al mínimo</label>
          <input id="prod-cant-repo" type="number" min="0" value="0" />
          <p class="hint">0 = la calcula sola (lleva el stock al doble del mínimo).</p>
        </div>
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
  if (state.hasProdExtras) {
    ["marca", "color", "medida", "proveedor"].forEach((k) => {
      $(`#prod-${k}`).value = "";
      $(`#prod-${k}`).placeholder = k === "medida" ? "Ej: 18mm, 2,75x1,83, 35mm" : "";
    });
    $("#prod-unidad").value = "Unidades";
    $("#prod-cant-repo").value = "0";
  }
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
  if (state.hasProdExtras) {
    const auto = inferirDatos(p.nombre);
    $("#prod-marca").value = p.marca || "";
    $("#prod-color").value = p.color || "";
    $("#prod-medida").value = p.medida || "";
    $("#prod-proveedor").value = p.proveedor || "";
    $("#prod-unidad").value = p.unidad || "Unidades";
    $("#prod-cant-repo").value = p.cant_reposicion || 0;
    // sugerencias detectadas en el nombre (si el campo queda vacío se guardan al actualizar)
    $("#prod-marca").placeholder = auto.marca ? `Detectado: ${auto.marca}` : "";
    $("#prod-color").placeholder = auto.color ? `Detectado: ${auto.color}` : "";
    $("#prod-medida").placeholder = auto.medida ? `Detectado: ${auto.medida}` : "Ej: 18mm, 2,75x1,83, 35mm";
  }
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
  if (state.hasProdExtras) {
    const auto = inferirDatos(nombre);
    // si el campo quedó vacío, se guarda lo detectado en el nombre
    payload.marca = $("#prod-marca").value.trim() || auto.marca;
    payload.color = $("#prod-color").value.trim() || auto.color;
    payload.medida = $("#prod-medida").value.trim() || auto.medida;
    payload.proveedor = $("#prod-proveedor").value.trim();
    payload.unidad = $("#prod-unidad").value;
    payload.cant_reposicion = Math.max(0, parseInt($("#prod-cant-repo").value || "0", 10) || 0);
  }

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

  const sinPedido = alertas.filter((p) => !pedidoAbiertoDe(p.codigo));
  content.innerHTML = `
    <h2 class="tab-title">⚠  Alertas de Stock</h2>
    <div class="toolbar">
      <span style="color:var(--fg2)">${alertas.length} producto${alertas.length !== 1 ? "s" : ""} con stock en o bajo el mínimo${state.hasPedidos ? ` · ${sinPedido.length} sin pedir` : ""}</span>
      <div class="spacer"></div>
      ${state.hasPedidos && sinPedido.length > 1 ? `<button class="btn-accent btn-inline" id="alertas-pedir-todos">🛒  Pedir los ${sinPedido.length} juntos</button>` : ""}
    </div>
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
          <div class="alert-action">${alertActionHtml(p)}</div>
        </div>`;
    })
    .join("");

  $all("[data-pedir]", $("#alertas-list")).forEach((b) =>
    b.addEventListener("click", () => abrirPedidoDesdeAlerta([b.dataset.pedir]))
  );
  $("#alertas-pedir-todos")?.addEventListener("click", () =>
    abrirPedidoDesdeAlerta(sinPedido.map((p) => p.codigo))
  );
}

function alertActionHtml(p) {
  if (!state.hasPedidos) return "";
  const ped = pedidoAbiertoDe(p.codigo);
  if (ped) return `<span class="badge badge-blue" title="Ya hay un pedido en curso">🛒 Pedido #${ped.id} en curso</span>`;
  return `<button class="btn-accent btn-sm" data-pedir="${escapeHtml(p.codigo)}">🛒 Pedir</button>`;
}

// ══════════════════════════════════════════════════════════════
// PEDIDOS — alerta de stock mínimo → orden de pedido → mail
// (módulo unificado con Aixa Pedidos; tablas en supabase/pedidos.sql)
// ══════════════════════════════════════════════════════════════

const DESTINATARIOS_PEDIDO = ["sergio@grupoaixa.com.ar", "leo@grupoaixa.com.ar"];
const UNIDADES = ["Unidades", "Metros", "Metros cuadrados", "Kg", "Litros", "Cajas", "Paquetes", "Placas", "Rollos", "Juegos"];
const CATEGORIAS_PEDIDO = ["Herraje", "Placa de Melamina", "Aluminio", "Estructura", "Silla", "Tornillería", "Insumos de taller", "Otro"];

// Colores y marcas frecuentes en carpintería / amoblamiento — se detectan en el nombre del insumo.
// (ordenados: los compuestos primero para que "gris grafito" gane sobre "gris")
const COLORES = [
  "gris grafito", "gris humo", "gris perla", "blanco tundra", "roble natural", "roble dakar", "nogal terracota",
  "acero inoxidable", "blanco", "negro", "grafito", "gris", "roble", "nogal", "cerezo", "haya", "wengue",
  "plateado", "plata", "dorado", "cromado", "niquelado", "niquel", "bronce", "inox", "champagne", "natural",
  "rojo", "azul", "verde", "amarillo", "naranja", "violeta", "rosa", "marron", "beige", "crema", "arena",
  "almendra", "chocolate", "tabaco", "caoba", "olmo", "fresno", "cedro", "peral", "teka", "teca", "lino",
  "seda", "topacio", "venecia", "carvalo", "transparente", "cristal", "aluminio",
];
const MARCAS = [
  "Blum", "Hettich", "Häfele", "Hafele", "Grass", "Salice", "Titus", "Ducasse", "Currao", "Hamaca",
  "Faplac", "Egger", "Masisa", "Sadepan", "Arauco", "Rehau", "Fischer", "Würth", "Wurth", "Tramontina",
  "Bosch", "Stanley", "Kekol", "Fortex", "Tork", "Henkel", "Pattex", "Unipega", "3M",
];

function sinAcentos(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function titulo(s) {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// Detecta marca / color / medida a partir de cómo está escrito el nombre del insumo.
function inferirDatos(nombre) {
  const n = ` ${sinAcentos(nombre).replace(/[^a-z0-9.,x×"]+/g, " ")} `;
  const color = COLORES.find((c) => n.includes(` ${c} `)) || "";
  const marca = MARCAS.find((m) => n.includes(` ${sinAcentos(m)} `)) || "";
  // medidas: "18mm", "45 cm", "1 Lts" o dimensiones "2,75x1,83" / "4x40 mm" (pueden ser varias)
  const medidas = [
    ...(nombre || "").matchAll(
      /\d+(?:[.,]\d+)?(?:\s?[x×]\s?\d+(?:[.,]\d+)?){1,2}(?:\s?(?:mm|cm|mts|mt|m)(?![a-z]))?|\d+(?:[.,]\d+)?\s?(?:mm|cm|mts|mt|m|kg|grs|gr|lts|lt|l|pulg|")(?![a-z])/gi
    ),
  ].map((m) => m[0].trim());
  return { color: color ? titulo(color) : "", marca, medida: medidas.join(" ") };
}

async function detectSchema() {
  const [a, b] = await Promise.all([
    sb.from("pedidos").select("id").limit(1),
    sb.from("productos").select("marca,cant_reposicion").limit(1),
  ]);
  state.hasPedidos = !a.error;
  state.hasProdExtras = !b.error;
  if (!state.hasPedidos) console.warn("[pedidos] Falta ejecutar supabase/pedidos.sql:", a.error?.message);
}

async function loadPedidos() {
  if (!state.hasPedidos) return;
  // todos los abiertos (para no perder alertas) + los últimos 300 cerrados
  const [abiertos, cerrados] = await Promise.all([
    sb.from("pedidos").select("*, pedido_items(*)").eq("estado", "Pedido").order("id", { ascending: false }),
    sb.from("pedidos").select("*, pedido_items(*)").neq("estado", "Pedido").order("id", { ascending: false }).limit(300),
  ]);
  if (abiertos.error || cerrados.error) return;
  state.pedidos = [...abiertos.data, ...cerrados.data].sort((a, b) => b.id - a.id);
  fillDatalists();
}

function fillDatalists() {
  $("#prod-datalist").innerHTML = state.productos
    .map((p) => `<option value="${escapeHtml(`${p.nombre} [${p.codigo}]`)}"></option>`)
    .join("");
  const cats = new Set([...CATEGORIAS_PEDIDO, ...state.productos.map((p) => p.categoria).filter(Boolean)]);
  $("#ped-cat-list").innerHTML = [...cats].map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  const provs = new Set(
    [...state.productos.map((p) => p.proveedor), ...state.pedidos.map((p) => p.proveedor)].filter(Boolean)
  );
  $("#ped-prov-list").innerHTML = [...provs].map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

function pedidoAbiertoDe(codigo) {
  const c = normalizarCodigo(codigo);
  return state.pedidos.find(
    (p) => p.estado === "Pedido" && (p.pedido_items || []).some((it) => normalizarCodigo(it.codigo) === c)
  );
}

function ultimoPedidoItemDe(codigo) {
  const c = normalizarCodigo(codigo);
  for (const ped of state.pedidos) {
    if (ped.estado === "Cancelado") continue;
    const item = (ped.pedido_items || []).find((it) => normalizarCodigo(it.codigo) === c);
    if (item) return { ped, item };
  }
  return null;
}

// Arma un ítem de pedido precargado para un producto del stock:
// 1) datos guardados en el producto, 2) lo que se pidió la última vez, 3) lo detectado en el nombre.
function sugerirItem(p) {
  const auto = inferirDatos(p.nombre);
  const prev = ultimoPedidoItemDe(p.codigo);
  let cantidad;
  if (p.cant_reposicion > 0) cantidad = p.cant_reposicion;
  else if (prev) cantidad = Number(prev.item.cantidad);
  else cantidad = Math.max(1, (p.stock_min || 0) * 2 - (p.stock || 0));
  return {
    codigo: p.codigo,
    descripcion: p.nombre,
    marca: p.marca || prev?.item.marca || auto.marca,
    color: p.color || prev?.item.color || auto.color,
    medida: p.medida || prev?.item.medida || auto.medida,
    cantidad,
    unidad: p.unidad || prev?.item.unidad || "Unidades",
    stock_al_pedir: p.stock,
    _proveedor: p.proveedor || prev?.ped.proveedor || "",
    _categoria: p.categoria || prev?.ped.categoria || "",
  };
}

function productosParaPedir() {
  return state.productos
    .filter((p) => p.stock <= p.stock_min && !pedidoAbiertoDe(p.codigo))
    .sort((a, b) => a.stock - a.stock_min - (b.stock - b.stock_min));
}

// ── Toast ────────────────────────────────────────────────────
function toast(msg, tipo = "ok") {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = `toast toast-${tipo}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

// ── Popup de alertas (pantalla inicial) ──────────────────────
const popupVistos = new Set();

function renderAlertPopup() {
  const el = $("#alert-popup");
  if ($("#app-view").classList.contains("hidden")) return el.classList.add("hidden");
  const lista = state.hasPedidos
    ? productosParaPedir()
    : state.productos.filter((p) => p.stock <= p.stock_min);
  if (!lista.length) {
    el.classList.add("hidden");
    return;
  }

  // si aparece un insumo nuevo bajo el mínimo, el popup se vuelve a abrir solo
  const nuevos = lista.filter((p) => !popupVistos.has(p.codigo));
  if (nuevos.length && popupVistos.size) state.popupCollapsed = false;
  lista.forEach((p) => popupVistos.add(p.codigo));
  if (nuevos.length) {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  el.classList.remove("hidden");
  el.classList.toggle("collapsed", !!state.popupCollapsed);
  $("#alert-popup-title").textContent = `⚠ ${lista.length} insumo${lista.length > 1 ? "s" : ""} para pedir`;
  $("#alert-popup-toggle").textContent = state.popupCollapsed ? "▴" : "▾";

  const max = 6;
  $("#alert-popup-body").innerHTML = `
    ${lista
      .slice(0, max)
      .map(
        (p) => `
      <button class="alert-popup-item" data-codigo="${escapeHtml(p.codigo)}" title="Click para armar la orden de pedido">
        <span class="api-nombre">${escapeHtml(p.nombre)}</span>
        <span class="api-stock" style="color:${p.stock === 0 ? "var(--red)" : "var(--yellow)"}">
          ${p.stock} / mín ${p.stock_min}
        </span>
        <span class="api-cta">${state.hasPedidos ? "Pedir ›" : "Ver ›"}</span>
      </button>`
      )
      .join("")}
    <div class="alert-popup-foot">
      ${lista.length > max ? `<button class="link-btn" id="api-ver-todas">+${lista.length - max} más · ver alertas</button>` : ""}
      ${state.hasPedidos && lista.length > 1 ? `<button class="btn-accent btn-sm" id="api-pedir-todos">🛒 Pedir todos juntos</button>` : ""}
    </div>
    ${state.hasPedidos ? "" : `<p class="hint" style="padding:0 10px 8px">Módulo de pedidos sin activar (falta correr supabase/pedidos.sql).</p>`}
  `;

  $all(".alert-popup-item", el).forEach((b) =>
    b.addEventListener("click", () =>
      state.hasPedidos ? abrirPedidoDesdeAlerta([b.dataset.codigo]) : showTab("alertas")
    )
  );
  $("#api-ver-todas")?.addEventListener("click", () => showTab("alertas"));
  $("#api-pedir-todos")?.addEventListener("click", () => abrirPedidoDesdeAlerta(lista.map((p) => p.codigo)));
}

$("#alert-popup-toggle").addEventListener("click", () => {
  state.popupCollapsed = !state.popupCollapsed;
  renderAlertPopup();
});
$("#alert-popup-title").addEventListener("click", () => {
  state.popupCollapsed = !state.popupCollapsed;
  renderAlertPopup();
});

// ── Modal: orden de pedido ───────────────────────────────────
let pedidoOrigen = "manual";

function abrirPedidoDesdeAlerta(codigos) {
  const prods = codigos.map(productoPorCodigo).filter(Boolean);
  if (!prods.length) return;
  const items = prods.map(sugerirItem);
  // proveedor / categoría: si todos los ítems coinciden, se precargan
  const uno = (k) => (new Set(items.map((i) => i[k])).size === 1 ? items[0][k] : "");
  abrirPedidoModal({ origen: "alerta", items, proveedor: uno("_proveedor"), categoria: uno("_categoria") });
}

function abrirPedidoManual() {
  abrirPedidoModal({ origen: "manual", items: [{}] });
}

function abrirPedidoModal({ origen, items, proveedor = "", categoria = "" }) {
  if (!state.hasPedidos) {
    alert("El módulo de pedidos todavía no está activado en la base de datos.\n\nHay que ejecutar supabase/pedidos.sql en Supabase (ver supabase/SETUP.md, paso 11).");
    return;
  }
  pedidoOrigen = origen;
  $("#pedido-modal-title").textContent =
    origen === "alerta" ? "🛒 Orden de pedido — reposición por stock mínimo" : "🛒 Nuevo pedido manual";
  $("#ped-categoria").value = categoria;
  $("#ped-proveedor").value = proveedor;
  $("#ped-urgencia").value = items.some((i) => i.stock_al_pedir === 0) ? "Urgente" : "Normal";
  $("#ped-obs").value = "";
  $("#ped-items").innerHTML = "";
  items.forEach(agregarFilaItem);
  $("#ped-confirm").disabled = false;
  $("#pedido-modal").classList.remove("hidden");
  // foco en la cantidad del primer ítem (lo único que casi siempre hay que tocar)
  const first = origen === "alerta" ? $("#ped-items .pi-cantidad") : $("#ped-items .pi-desc");
  first?.focus();
  first?.select?.();
}

function agregarFilaItem(it = {}) {
  const row = document.createElement("div");
  row.className = "ped-item-row";
  row.dataset.codigo = it.codigo || "";
  row.dataset.stock = it.stock_al_pedir ?? "";
  row.innerHTML = `
    <div class="pi-desc-wrap">
      <input class="pi-desc" list="prod-datalist" placeholder="Buscar en stock o escribir insumo nuevo" value="${escapeHtml(it.descripcion || "")}" />
      <span class="pi-tag"></span>
    </div>
    <input class="pi-marca" placeholder="Marca" value="${escapeHtml(it.marca || "")}" />
    <input class="pi-color" placeholder="Color" value="${escapeHtml(it.color || "")}" />
    <input class="pi-medida" placeholder="Medida" value="${escapeHtml(it.medida || "")}" />
    <input class="pi-cantidad" type="number" min="0.01" step="any" value="${it.cantidad ?? 1}" />
    <select class="pi-unidad">${UNIDADES.map((u) => `<option ${u === (it.unidad || "Unidades") ? "selected" : ""}>${u}</option>`).join("")}</select>
    <button class="icon-btn danger pi-del" type="button" title="Quitar ítem">✕</button>
  `;
  $("#ped-items").appendChild(row);
  actualizarTagFila(row);

  const desc = $(".pi-desc", row);
  desc.addEventListener("change", () => {
    const v = desc.value.trim();
    const m = v.match(/\[([^\]]+)\]\s*$/);
    const prod = m
      ? productoPorCodigo(m[1])
      : state.productos.find((p) => p.nombre.toLowerCase() === v.toLowerCase()) || productoPorCodigo(v);
    if (prod) {
      const s = sugerirItem(prod);
      desc.value = prod.nombre;
      row.dataset.codigo = prod.codigo;
      row.dataset.stock = prod.stock;
      $(".pi-marca", row).value = s.marca;
      $(".pi-color", row).value = s.color;
      $(".pi-medida", row).value = s.medida;
      $(".pi-cantidad", row).value = s.cantidad;
      $(".pi-unidad", row).value = s.unidad;
      if (!$("#ped-proveedor").value) $("#ped-proveedor").value = s._proveedor;
      if (!$("#ped-categoria").value) $("#ped-categoria").value = s._categoria;
    } else {
      const ligado = productoPorCodigo(row.dataset.codigo);
      if (!ligado || ligado.nombre.toLowerCase() !== v.toLowerCase()) {
        row.dataset.codigo = "";
        row.dataset.stock = "";
        // insumo nuevo: igual intentamos detectar color/marca/medida del texto
        const auto = inferirDatos(v);
        if (!$(".pi-marca", row).value) $(".pi-marca", row).value = auto.marca;
        if (!$(".pi-color", row).value) $(".pi-color", row).value = auto.color;
        if (!$(".pi-medida", row).value) $(".pi-medida", row).value = auto.medida;
      }
    }
    actualizarTagFila(row);
  });
  $(".pi-del", row).addEventListener("click", () => {
    row.remove();
    if (!$("#ped-items").children.length) agregarFilaItem({});
  });
}

function actualizarTagFila(row) {
  const tag = $(".pi-tag", row);
  const desc = $(".pi-desc", row).value.trim();
  if (row.dataset.codigo) {
    tag.textContent = `Cód ${row.dataset.codigo} · stock ${row.dataset.stock}`;
    tag.className = "pi-tag tag-stock";
  } else if (desc) {
    tag.textContent = "Insumo nuevo (no está en stock)";
    tag.className = "pi-tag tag-nuevo";
  } else {
    tag.textContent = "";
    tag.className = "pi-tag";
  }
}

$("#ped-add-item").addEventListener("click", () => {
  agregarFilaItem({});
  $("#ped-items .ped-item-row:last-child .pi-desc").focus();
});
$("#ped-cancel").addEventListener("click", () => $("#pedido-modal").classList.add("hidden"));

$("#ped-confirm").addEventListener("click", async () => {
  const items = $all(".ped-item-row", $("#ped-items"))
    .map((row) => ({
      codigo: row.dataset.codigo || "",
      descripcion: $(".pi-desc", row).value.trim().replace(/\s*\[[^\]]+\]\s*$/, ""),
      marca: $(".pi-marca", row).value.trim(),
      color: $(".pi-color", row).value.trim(),
      medida: $(".pi-medida", row).value.trim(),
      cantidad: parseFloat(String($(".pi-cantidad", row).value).replace(",", ".")),
      unidad: $(".pi-unidad", row).value,
      stock_al_pedir: row.dataset.stock === "" ? null : parseInt(row.dataset.stock, 10),
    }))
    .filter((i) => i.descripcion);

  if (!items.length) return alert("Agregá al menos un insumo.");
  const malCant = items.find((i) => !(i.cantidad > 0));
  if (malCant) return alert(`Revisá la cantidad de "${malCant.descripcion}".`);

  const yaPedidos = items.map((i) => i.codigo && pedidoAbiertoDe(i.codigo)).filter(Boolean);
  if (
    yaPedidos.length &&
    !confirm(`Atención: ya hay pedido en curso para:\n${yaPedidos.map((p) => `· Pedido #${p.id}`).join("\n")}\n\n¿Pedir igual?`)
  )
    return;

  const btn = $("#ped-confirm");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  const { data: ped, error } = await sb
    .from("pedidos")
    .insert({
      origen: pedidoOrigen,
      estado: "Pedido",
      categoria: $("#ped-categoria").value.trim(),
      proveedor: $("#ped-proveedor").value.trim(),
      urgencia: $("#ped-urgencia").value,
      obs: $("#ped-obs").value.trim(),
      usuario: state.currentUserLabel,
    })
    .select()
    .single();

  if (error) {
    btn.disabled = false;
    btn.textContent = "✉  Confirmar y enviar pedido";
    return alert(`No se pudo guardar el pedido.\n\nDetalle: ${error.message}`);
  }

  const { error: itErr } = await sb.from("pedido_items").insert(items.map((i) => ({ ...i, pedido_id: ped.id })));
  if (itErr) {
    // sin ítems el pedido no sirve: se marca cancelado para que no quede "abierto" vacío
    await sb.from("pedidos").update({ estado: "Cancelado", obs: `Error al guardar ítems: ${itErr.message}` }).eq("id", ped.id);
    btn.disabled = false;
    btn.textContent = "✉  Confirmar y enviar pedido";
    return alert(`No se pudieron guardar los ítems del pedido.\n\nDetalle: ${itErr.message}`);
  }

  $("#pedido-modal").classList.add("hidden");
  btn.textContent = "✉  Confirmar y enviar pedido";
  toast(`✓ Pedido #${ped.id} registrado. Enviando mail…`);

  await loadPedidos();
  refreshAlertBadge();
  if (state.currentTab !== "scanner") renderCurrentTab();

  await enviarMailPedido(ped.id);
});

// ── Envío de mail ────────────────────────────────────────────
async function enviarMailPedido(pedidoId) {
  const { data, error } = await sb.functions.invoke("enviar-pedido", { body: { pedido_id: pedidoId } });
  if (!error && data?.ok) {
    toast(`✉ Pedido #${pedidoId} enviado a Sergio y Leo`);
  } else {
    let detalle = data?.error || error?.message || "error desconocido";
    try {
      const body = await error?.context?.json?.();
      if (body?.error) detalle = body.error;
    } catch (_) {}
    console.warn("[pedidos] fallo envío automático:", detalle);
    const usarMailto = confirm(
      `No se pudo enviar el mail automáticamente (${detalle}).\n\n` +
        `El pedido #${pedidoId} quedó guardado igual.\n\n` +
        `¿Abrir tu programa de correo con el pedido ya escrito para enviarlo vos?`
    );
    if (usarMailto) {
      abrirMailto(pedidoId);
      await sb.from("pedidos").update({ email_estado: "manual", email_detalle: `Enviado desde el correo de ${state.currentUserLabel}` }).eq("id", pedidoId);
    } else {
      await sb.from("pedidos").update({ email_estado: "error", email_detalle: String(detalle).slice(0, 500) }).eq("id", pedidoId);
    }
  }
  await loadPedidos();
  if (state.currentTab === "pedidos") renderPedidos();
}

function textoPedido(ped) {
  const items = ped.pedido_items || [];
  return (
    `Orden de pedido #${ped.id}${ped.urgencia === "Urgente" ? " (URGENTE)" : ""}\n` +
    `Fecha: ${new Date(ped.fecha).toLocaleString("es-AR")} · Pedido por: ${ped.usuario}\n` +
    `Categoría: ${ped.categoria || "—"} · Proveedor: ${ped.proveedor || "—"}\n\n` +
    items
      .map(
        (it) =>
          `- ${it.cantidad} ${it.unidad} · ${it.descripcion}` +
          [it.marca && `Marca: ${it.marca}`, it.color && `Color: ${it.color}`, it.medida && `Medida: ${it.medida}`]
            .filter(Boolean)
            .map((s) => ` · ${s}`)
            .join("") +
          (it.codigo ? ` (cód ${it.codigo}, stock actual ${it.stock_al_pedir ?? "—"})` : " (insumo nuevo)")
      )
      .join("\n") +
    (ped.obs ? `\n\nObservaciones: ${ped.obs}` : "") +
    `\n\n— StockScanner Grupo Aixa`
  );
}

function abrirMailto(pedidoId) {
  const ped = state.pedidos.find((p) => p.id === pedidoId);
  if (!ped) return;
  const items = ped.pedido_items || [];
  const subject =
    `${ped.urgencia === "Urgente" ? "[URGENTE] " : ""}Pedido #${ped.id} — ` +
    (items.length === 1 ? `${items[0].cantidad} ${items[0].unidad} de ${items[0].descripcion}` : `${items.length} insumos`);
  window.location.href =
    `mailto:${DESTINATARIOS_PEDIDO.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(textoPedido(ped))}`;
}

// ── Pestaña PEDIDOS ──────────────────────────────────────────
function renderPedidos() {
  const content = $("#content");
  if (!state.hasPedidos) {
    content.innerHTML = `
      <h2 class="tab-title">🛒  Pedidos</h2>
      <div class="unknown-card">
        <h3>⚠  El módulo de pedidos todavía no está activado</h3>
        <p>Un administrador tiene que ejecutar <b>supabase/pedidos.sql</b> en el SQL Editor de Supabase
        (ver <b>supabase/SETUP.md</b>, paso 11). No borra ni cambia ningún producto.</p>
      </div>`;
    return;
  }
  content.innerHTML = `
    <h2 class="tab-title">🛒  Pedidos</h2>
    <div class="toolbar">
      <div class="hist-filters" style="margin:0">
        ${[
          ["abiertos", "En curso"],
          ["Recibido", "Recibidos"],
          ["Cancelado", "Cancelados"],
          ["todos", "Todos"],
        ]
          .map(
            ([v, l]) =>
              `<label><input type="radio" name="ped-filtro" value="${v}" ${state.pedFiltro === v ? "checked" : ""}/> ${l}</label>`
          )
          .join("")}
      </div>
      <input type="text" id="ped-search" placeholder="Buscar insumo, proveedor, #…" />
      <div class="spacer"></div>
      <button class="btn-accent btn-inline" id="ped-nuevo">＋  Nuevo pedido manual</button>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th><th>Fecha</th><th>Insumos</th><th>Categoría</th><th>Proveedor</th>
          <th>Por</th><th class="center">Estado</th><th class="center">Mail</th><th class="center">Acciones</th>
        </tr>
      </thead>
      <tbody id="ped-tbody"></tbody>
    </table>
  `;
  $all('input[name="ped-filtro"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.pedFiltro = e.target.value;
      renderPedidoRows();
    })
  );
  $("#ped-search").addEventListener("input", renderPedidoRows);
  $("#ped-nuevo").addEventListener("click", abrirPedidoManual);
  renderPedidoRows();
}

const MAIL_BADGE = {
  enviado: ["✓", "badge-green", "Mail enviado"],
  manual: ["✉", "badge-blue", "Enviado desde el correo del usuario"],
  error: ["⚠", "badge-red", "No se pudo enviar"],
  pendiente: ["…", "badge-gray", "Pendiente de envío"],
};
const ESTADO_BADGE = { Pedido: "badge-blue", Recibido: "badge-green", Cancelado: "badge-gray" };

function renderPedidoRows() {
  const q = ($("#ped-search")?.value || "").trim().toLowerCase();
  const f = state.pedFiltro;
  const rows = state.pedidos.filter((p) => {
    if (f === "abiertos" && p.estado !== "Pedido") return false;
    if (f !== "abiertos" && f !== "todos" && p.estado !== f) return false;
    if (!q) return true;
    const hay = [p.id, p.proveedor, p.categoria, p.usuario, p.obs, ...(p.pedido_items || []).map((i) => `${i.descripcion} ${i.codigo} ${i.marca} ${i.color}`)]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const tbody = $("#ped-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="center" style="color:var(--fg2);padding:24px">No hay pedidos para mostrar.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((p) => {
      const [mIcon, mCls, mTit] = MAIL_BADGE[p.email_estado] || MAIL_BADGE.pendiente;
      const items = (p.pedido_items || [])
        .map(
          (i) =>
            `<div class="ped-li"><b>${escapeHtml(String(i.cantidad))} ${escapeHtml(i.unidad)}</b> · ${escapeHtml(i.descripcion)}` +
            `${[i.marca, i.color, i.medida].filter(Boolean).length ? ` <span class="muted">(${escapeHtml([i.marca, i.color, i.medida].filter(Boolean).join(" · "))})</span>` : ""}` +
            `${i.cantidad_recibida != null ? ` <span class="muted">→ recibido ${escapeHtml(String(i.cantidad_recibida))}</span>` : ""}</div>`
        )
        .join("");
      return `
        <tr>
          <td>${p.id}${p.urgencia === "Urgente" ? ' <span class="badge badge-red">URG</span>' : ""}</td>
          <td style="white-space:nowrap">${new Date(p.fecha).toLocaleDateString("es-AR")}<br><span class="muted">${p.origen === "alerta" ? "⚠ por alerta" : "✎ manual"}</span></td>
          <td>${items}${p.obs ? `<div class="muted">📝 ${escapeHtml(p.obs)}</div>` : ""}</td>
          <td>${escapeHtml(p.categoria || "—")}</td>
          <td>${escapeHtml(p.proveedor || "—")}</td>
          <td>${escapeHtml(p.usuario || "—")}</td>
          <td class="center"><span class="badge ${ESTADO_BADGE[p.estado]}">${p.estado}</span>${p.fecha_recibido ? `<br><span class="muted">${new Date(p.fecha_recibido).toLocaleDateString("es-AR")}</span>` : ""}</td>
          <td class="center"><span class="badge ${mCls}" title="${escapeHtml(p.email_detalle || mTit)}">${mIcon}</span></td>
          <td class="actions center">
            ${p.estado === "Pedido" ? `<button class="icon-btn" data-act="recibir" data-id="${p.id}" title="Registrar que llegó (suma al stock)">📦 Recibir</button>` : ""}
            <button class="icon-btn" data-act="pdf" data-id="${p.id}" title="Descargar orden en PDF">⬇ PDF</button>
            ${p.estado === "Pedido" ? `<button class="icon-btn" data-act="mail" data-id="${p.id}" title="Volver a enviar el mail">✉</button>` : ""}
            ${p.estado === "Pedido" ? `<button class="icon-btn danger" data-act="cancelar" data-id="${p.id}" title="Cancelar pedido">✕</button>` : ""}
          </td>
        </tr>`;
    })
    .join("");

  $all("[data-act]", tbody).forEach((b) =>
    b.addEventListener("click", () => {
      const id = Number(b.dataset.id);
      if (b.dataset.act === "recibir") abrirRecibir(id);
      if (b.dataset.act === "pdf") pdfPedido(id);
      if (b.dataset.act === "mail") enviarMailPedido(id);
      if (b.dataset.act === "cancelar") cancelarPedido(id);
    })
  );
}

async function cancelarPedido(id) {
  if (!confirm(`¿Cancelar el pedido #${id}?\n\nQueda en el historial como cancelado y la alerta de esos insumos vuelve a aparecer.`)) return;
  const { error } = await sb.from("pedidos").update({ estado: "Cancelado" }).eq("id", id);
  if (error) return alert(`No se pudo cancelar.\n\nDetalle: ${error.message}`);
  toast(`Pedido #${id} cancelado`);
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
}

// ── Recepción: marca el pedido como recibido y suma al stock ─
let recibirId = null;

function abrirRecibir(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  recibirId = id;
  $("#recibir-title").textContent = `📦 Recibir pedido #${id}${ped.proveedor ? ` — ${ped.proveedor}` : ""}`;
  $("#recibir-items").innerHTML = (ped.pedido_items || [])
    .map((it) => {
      const prod = it.codigo ? productoPorCodigo(it.codigo) : null;
      return `
        <div class="recibir-row" data-item="${it.id}">
          <div class="rr-desc">${escapeHtml(it.descripcion)}<br>
            <span class="muted">Pedido: ${escapeHtml(String(it.cantidad))} ${escapeHtml(it.unidad)}${prod ? ` · stock actual ${prod.stock}` : " · insumo nuevo"}</span></div>
          <label>Llegó<input type="number" class="rr-cant" min="0" step="any" value="${escapeHtml(String(it.cantidad))}" /></label>
          ${
            prod
              ? `<label class="rr-check"><input type="checkbox" class="rr-sumar" checked /> Sumar al stock</label>`
              : `<span class="muted rr-check">No está en stock — cargalo en ＋ Productos si corresponde</span>`
          }
        </div>`;
    })
    .join("");
  $("#recibir-confirm").disabled = false;
  $("#recibir-modal").classList.remove("hidden");
}

$("#recibir-cancel").addEventListener("click", () => $("#recibir-modal").classList.add("hidden"));

$("#recibir-confirm").addEventListener("click", async () => {
  const ped = state.pedidos.find((p) => p.id === recibirId);
  if (!ped) return;
  const btn = $("#recibir-confirm");
  btn.disabled = true;
  const errores = [];

  for (const row of $all(".recibir-row", $("#recibir-items"))) {
    const it = ped.pedido_items.find((x) => String(x.id) === row.dataset.item);
    const cant = parseFloat(String($(".rr-cant", row).value).replace(",", ".")) || 0;
    await sb.from("pedido_items").update({ cantidad_recibida: cant }).eq("id", it.id);

    const sumar = $(".rr-sumar", row)?.checked;
    if (!sumar || cant <= 0 || !it.codigo) continue;
    // stock fresco de la base (otro usuario pudo haber escaneado mientras tanto)
    const local = productoPorCodigo(it.codigo);
    const { data: prod } = local
      ? await sb.from("productos").select("codigo,stock").eq("codigo", local.codigo).maybeSingle()
      : { data: null };
    if (!prod) { errores.push(`${it.descripcion}: producto no encontrado en stock`); continue; }
    const qty = Math.round(cant);
    const stockPost = prod.stock + qty;
    const { error: e1 } = await sb.from("productos").update({ stock: stockPost }).eq("codigo", prod.codigo);
    if (e1) { errores.push(`${it.descripcion}: ${e1.message}`); continue; }
    await sb.from("movimientos").insert({
      codigo: prod.codigo,
      tipo: "entrada",
      cantidad: qty,
      stock_prev: prod.stock,
      stock_post: stockPost,
      nota: `Recepción pedido #${ped.id}${ped.proveedor ? ` (${ped.proveedor})` : ""}`,
      usuario: state.currentUserLabel,
      fecha: nowStamp(),
    });
  }

  const { error } = await sb
    .from("pedidos")
    .update({ estado: "Recibido", fecha_recibido: new Date().toISOString(), recibido_por: state.currentUserLabel })
    .eq("id", ped.id);

  $("#recibir-modal").classList.add("hidden");
  if (error || errores.length) {
    alert(`La recepción se registró con problemas:\n\n${[error?.message, ...errores].filter(Boolean).join("\n")}`);
  } else {
    toast(`✓ Pedido #${ped.id} recibido y stock actualizado`);
  }
  await loadProductos();
  await loadMovimientos();
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
});

// ── PDF de una orden de pedido ───────────────────────────────
function pdfPedido(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const w = doc.internal.pageSize.getWidth();

  doc.setFontSize(18);
  doc.setTextColor(234, 88, 12);
  doc.text(`Orden de pedido #${ped.id}${ped.urgencia === "Urgente" ? "  —  URGENTE" : ""}`, 40, 46);
  doc.setFontSize(10);
  doc.setTextColor(60);
  doc.text(`Grupo Aixa  ·  ${new Date(ped.fecha).toLocaleString("es-AR")}  ·  Pedido por: ${ped.usuario}`, 40, 64);
  doc.text(`Categoría: ${ped.categoria || "—"}     Proveedor: ${ped.proveedor || "—"}     Estado: ${ped.estado}`, 40, 80);

  doc.autoTable({
    startY: 96,
    head: [["Insumo", "Código", "Marca", "Color", "Medida", "Cantidad"]],
    body: (ped.pedido_items || []).map((i) => [
      i.descripcion,
      i.codigo || "nuevo",
      i.marca || "—",
      i.color || "—",
      i.medida || "—",
      `${i.cantidad} ${i.unidad}`,
    ]),
    styles: { fontSize: 9, cellPadding: 6, overflow: "linebreak" },
    headStyles: { fillColor: [249, 115, 22], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: { 0: { cellWidth: "auto" }, 5: { halign: "center", cellWidth: 80 } },
    margin: { left: 40, right: 40 },
    tableWidth: w - 80,
  });
  if (ped.obs) {
    doc.setFontSize(10);
    doc.text(doc.splitTextToSize(`Observaciones: ${ped.obs}`, w - 80), 40, doc.lastAutoTable.finalY + 24);
  }
  doc.save(`pedido_${ped.id}.pdf`);
}

// Cerrar modales con Escape
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["#pedido-modal", "#recibir-modal", "#edit-stock-modal"].forEach((m) => $(m).classList.add("hidden"));
});
