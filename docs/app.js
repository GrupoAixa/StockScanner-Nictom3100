// StockScanner web — replica el comportamiento de StockScanner.py (Tkinter)
// sobre Supabase (Postgres + Auth + Realtime). Ver supabase/schema.sql.

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const USERS = {
  admin:  { email: "admin@stockscanner.local",  label: "Admin" },
  sergio: { email: "sergio@stockscanner.local", label: "Sergio" },
  leo:    { email: "leo@stockscanner.local",    label: "Leo" },
  marcelo:{ email: "marcelo@stockscanner.local", label: "Marcelo" },
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
  pedFiltro: "abiertos",   // pestaña Pedidos: abiertos | Pendiente | Pedido
  archFiltro: "Recibido",  // pestaña Recibidos: Recibido | Cancelado | todos
  hasPedidosV2: false,     // se corrió supabase/pedidos_v2.sql (estado Pendiente, borrar)
  hasObra: false,          // se corrió supabase/v3_marcelo_obra_ocultos.sql (columna obra)
  hasOcultos: false,       // ídem (columna productos.oculto)
  hasOT: false,            // se corrió supabase/v5_orden_trabajo_pedidos.sql (columna orden_trabajo)
  stockVista: "activos",   // Inventario: activos | ocultos
  hasHistPedidos: false,   // se corrió supabase/v4_leo_edita_historial_pedidos.sql
  histPedidos: [],         // cambios en pedidos (tabla pedidos_historial)
  histPedidoId: null,      // Historial filtrado a un solo pedido
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
  state.currentEmail = session.user.email;
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
    recibidos: renderRecibidos,
  };
  renderers[state.currentTab]?.();
}

// Productos bajo el mínimo que generan alerta (los ocultos no avisan)
const enAlerta = (p) => !p.oculto && p.stock <= p.stock_min;

function refreshAlertBadge() {
  const count = state.productos.filter(enAlerta).length;
  const label = $("#nav-alertas .nav-main");
  label.textContent = count > 0 ? `⚠  Alertas  (${count})` : "⚠  Alertas";
  const abiertos = state.pedidos.filter(esAbierto).length;
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
    ${state.hasOcultos ? "" : `<p class="hint" style="color:var(--yellow)">⚠ Falta ejecutar <b>supabase/v3_marcelo_obra_ocultos.sql</b> para poder ocultar productos.</p>`}
    <div class="toolbar">
      ${state.hasOcultos ? `<div class="hist-filters" style="margin:0">
        <label><input type="radio" name="stock-vista" value="activos" ${state.stockVista === "activos" ? "checked" : ""}/> Activos</label>
        <label><input type="radio" name="stock-vista" value="ocultos" ${state.stockVista === "ocultos" ? "checked" : ""}/> 🙈 Ocultos <span id="stock-ocultos-count"></span></label>
      </div>` : ""}
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
  $all('input[name="stock-vista"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.stockVista = e.target.value;
      renderStockRows();
    })
  );
  $("#stock-export").addEventListener("click", exportCsv);
  $("#stock-export-pdf").addEventListener("click", exportPdf);
  renderStockRows();
}

function renderStockRows() {
  const q = ($("#stock-search")?.value || "").trim().toLowerCase();
  const tbody = $("#stock-tbody");
  const verOcultos = state.hasOcultos && state.stockVista === "ocultos";
  const nOcultos = state.productos.filter((p) => p.oculto).length;
  if ($("#stock-ocultos-count")) $("#stock-ocultos-count").textContent = nOcultos ? `(${nOcultos})` : "";
  const rows = [...state.productos]
    .filter((p) => !!p.oculto === verOcultos)
    .filter((p) => !q || p.nombre.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="center" style="color:var(--fg2);padding:24px">${
      verOcultos
        ? "No hay productos ocultos. Usá 🙈 en la lista de Activos para ocultar los que casi no se usan (dejan de aparecer en las alertas)."
        : "No hay productos para mostrar."
    }</td></tr>`;
    return;
  }

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
            ${state.hasOcultos ? (p.oculto
              ? `<button class="icon-btn" data-action="ocultar" data-id="${p.id}" title="Volver a mostrar (vuelve a avisar en las alertas)">👁 Mostrar</button>`
              : `<button class="icon-btn" data-action="ocultar" data-id="${p.id}" title="Ocultar (no aparece en las alertas para pedir)">🙈</button>`) : ""}
          </td>
        </tr>`;
    })
    .join("");

  $all('[data-action="edit-stock"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => openEditStockModal(btn.dataset.id))
  );
  $all('[data-action="ocultar"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => toggleOculto(btn.dataset.id))
  );
  $all('[data-action="edit-producto"]', tbody).forEach((btn) =>
    btn.addEventListener("click", () => {
      showTab("productos");
      setTimeout(() => loadProductoInForm(btn.dataset.id), 0);
    })
  );
}

async function toggleOculto(id) {
  const p = state.productos.find((x) => String(x.id) === String(id));
  if (!p) return;
  const oculto = !p.oculto;
  const { error } = await sb.from("productos").update({ oculto }).eq("id", p.id);
  if (error) return alert(`No se pudo actualizar.\n\nDetalle: ${error.message}`);
  toast(oculto ? `🙈 "${p.nombre}" oculto — ya no aparece en las alertas` : `👁 "${p.nombre}" visible de nuevo`);
  await loadProductos();
  refreshAlertBadge();
  renderStockRows();
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
  const f = state.histFiltro;
  const radio = (v, txt) =>
    `<label><input type="radio" name="hist-filtro" value="${v}" ${f === v ? "checked" : ""} /> ${txt}</label>`;
  content.innerHTML = `
    <h2 class="tab-title">⏱  Historial de Movimientos</h2>
    <div class="hist-filters">
      ${radio("todos", "Todos")}
      ${radio("entrada", "Entradas")}
      ${radio("salida", "Salidas")}
      ${radio("ajuste", "Ajustes")}
      ${state.hasHistPedidos ? radio("pedidos", "Cambios en pedidos") : ""}
    </div>
    <div id="hist-body"></div>
  `;
  $all('input[name="hist-filtro"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.histFiltro = e.target.value;
      state.histPedidoId = null;
      renderHistBody();
    })
  );
  renderHistBody();
}

function renderHistBody() {
  if (state.histFiltro === "pedidos") return renderHistPedidos();
  $("#hist-body").innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Fecha</th><th>Código</th><th>Producto</th><th class="center">Tipo</th>
          <th class="center">Cant.</th><th class="center">Antes</th><th class="center">Después</th>
          <th>Usuario</th><th>Nota</th>
        </tr>
      </thead>
      <tbody id="hist-tbody"></tbody>
    </table>`;
  renderHistRows();
}

// Cambios en pedidos: los registra la base sola (supabase/v4_leo_edita_historial_pedidos.sql)
async function loadHistPedidos() {
  let q = sb.from("pedidos_historial").select("*").order("fecha", { ascending: false }).order("id", { ascending: false });
  q = state.histPedidoId ? q.eq("pedido_id", state.histPedidoId) : q.limit(500);
  const { data, error } = await q;
  if (error) {
    console.warn("[historial pedidos]", error.message);
    state.histPedidos = [];
    return;
  }
  state.histPedidos = data;
}

async function renderHistPedidos() {
  const body = $("#hist-body");
  const id = state.histPedidoId;
  body.innerHTML = `
    <div class="hist-filters">
      <input type="text" id="hist-ped-search" placeholder="Buscar: #pedido, usuario, obra, OT, insumo…" style="flex:1;max-width:380px" />
      ${id ? `<span>Mostrando solo el pedido <b>#${id}</b></span> <button class="btn-secondary" id="hist-ped-todos">Ver todos</button>` : ""}
    </div>
    <table class="data-table">
      <thead><tr><th>Fecha</th><th class="center">Pedido</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead>
      <tbody id="hist-ped-tbody"><tr><td colspan="5" class="muted">Cargando…</td></tr></tbody>
    </table>`;
  $("#hist-ped-todos")?.addEventListener("click", () => {
    state.histPedidoId = null;
    renderHistPedidos();
  });
  $("#hist-ped-search").addEventListener("input", renderHistPedRows);
  await loadHistPedidos();
  if (state.currentTab === "historial" && state.histFiltro === "pedidos") renderHistPedRows();
}

function renderHistPedRows() {
  const tbody = $("#hist-ped-tbody");
  if (!tbody) return;
  const txt = ($("#hist-ped-search")?.value || "").trim().toLowerCase().replace(/^#/, "");
  const rows = state.histPedidos.filter(
    (h) => !txt || `${h.pedido_id} ${h.usuario} ${h.accion} ${h.detalle}`.toLowerCase().includes(txt)
  );
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (h) => `
        <tr>
          <td>${new Date(h.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
          <td class="center"><b>#${h.pedido_id}</b></td>
          <td>${escapeHtml(h.usuario)}</td>
          <td>${escapeHtml(h.accion)}</td>
          <td style="white-space:pre-line">${escapeHtml(h.detalle)}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No hay cambios registrados.</td></tr>`;
}

function verHistorialPedido(id) {
  state.histFiltro = "pedidos";
  state.histPedidoId = id;
  showTab("historial");
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
          <label>Cantidad a pedir habitualmente</label>
          <input id="prod-cant-repo" type="number" min="0" value="0" />
          <p class="hint">Si el stock está en o bajo el mínimo, el pedido propone lo que falta para llegar al mínimo. Este valor se usa cuando se pide sin estar bajo el mínimo (0 = lo que se pidió la última vez).</p>
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
    .filter(enAlerta)
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
  const [a, b, c, d, e, f, g] = await Promise.all([
    sb.from("pedidos").select("id").limit(1),
    sb.from("productos").select("marca,cant_reposicion").limit(1),
    sb.from("pedidos").select("pedido_por").limit(1),
    sb.from("pedidos").select("obra").limit(1),
    sb.from("productos").select("oculto").limit(1),
    sb.from("pedidos_historial").select("id").limit(1),
    sb.from("pedidos").select("orden_trabajo").limit(1),
  ]);
  state.hasPedidos = !a.error;
  state.hasProdExtras = !b.error;
  state.hasPedidosV2 = !c.error;
  state.hasObra = !d.error;
  state.hasOcultos = !e.error;
  state.hasHistPedidos = !f.error;
  state.hasOT = !g.error;
  if (!state.hasOT) console.warn("[v5] Falta ejecutar supabase/v5_orden_trabajo_pedidos.sql");
  if (!state.hasHistPedidos) console.warn("[v4] Falta ejecutar supabase/v4_leo_edita_historial_pedidos.sql");
  if (!state.hasObra || !state.hasOcultos) console.warn("[v3] Falta ejecutar supabase/v3_marcelo_obra_ocultos.sql");
  if (state.hasPedidos && !state.hasPedidosV2) console.warn("[pedidos] Falta ejecutar supabase/pedidos_v2.sql");
  if (!state.hasPedidos) console.warn("[pedidos] Falta ejecutar supabase/pedidos.sql:", a.error?.message);
}

async function loadPedidos() {
  if (!state.hasPedidos) return;
  // todos los abiertos (para no perder alertas) + los últimos 300 cerrados
  const [abiertos, cerrados] = await Promise.all([
    sb.from("pedidos").select("*, pedido_items(*)").in("estado", ESTADOS_ABIERTOS).order("id", { ascending: false }),
    sb.from("pedidos").select("*, pedido_items(*)").in("estado", ["Recibido", "Cancelado"]).order("id", { ascending: false }).limit(300),
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
  const obras = new Set(state.pedidos.map((p) => p.obra).filter(Boolean));
  $("#ped-obra-list").innerHTML = [...obras].map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

// Pendiente (falta pedirlo al proveedor) y Pedido (esperando entrega) son pedidos "abiertos"
const ESTADOS_ABIERTOS = ["Pendiente", "Pedido"];
const esAbierto = (p) => ESTADOS_ABIERTOS.includes(p.estado);

// ── Permisos ──
// Admin y Sergio: borran pedidos y editan cualquiera. Leo: edita cualquiera (no borra); cada cambio
// queda en el historial. Marcelo: edita solo los "Pendiente". Todos pueden marcar como pedido y recibir.
// Mismas reglas en la base: supabase/pedidos_v2.sql, v3 y v4 (sin v4, Leo sigue como Marcelo).
const edicionRestringida = () =>
  state.currentEmail === USERS.marcelo.email || (!state.hasHistPedidos && state.currentEmail === USERS.leo.email);
const puedeBorrar = () => [USERS.admin.email, USERS.sergio.email].includes(state.currentEmail);
const puedeEditar = (p) => !(edicionRestringida() && p.estado !== "Pendiente");

function pedidoAbiertoDe(codigo, exceptoId = null) {
  const c = normalizarCodigo(codigo);
  return state.pedidos.find(
    (p) => esAbierto(p) && p.id !== exceptoId && (p.pedido_items || []).some((it) => normalizarCodigo(it.codigo) === c)
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
  // bajo el mínimo: se pide lo que falta para llegar al mínimo (editable en el pedido)
  if (p.stock <= p.stock_min) cantidad = Math.max(1, p.stock_min - p.stock);
  else if (p.cant_reposicion > 0) cantidad = p.cant_reposicion;
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
    .filter((p) => enAlerta(p) && !pedidoAbiertoDe(p.codigo))
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
    : state.productos.filter(enAlerta);
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
let pedidoEditando = null; // pedido que se está editando (null = pedido nuevo)
const TXT_CONFIRMAR = "✉  Confirmar y enviar pedido";
const TXT_GUARDAR = "💾  Guardar cambios";

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
  pedidoEditando = null;
  $("#pedido-modal-title").textContent =
    origen === "alerta" ? "🛒 Orden de pedido — reposición por stock mínimo" : "🛒 Nuevo pedido manual";
  $("#ped-categoria").value = categoria;
  $("#ped-proveedor").value = proveedor;
  $("#ped-obra").value = "";
  $("#ped-obra-wrap").classList.toggle("hidden", !state.hasObra);
  $("#ped-ot").value = "";
  $("#ped-ot-wrap").classList.toggle("hidden", !state.hasOT);
  $("#ped-urgencia").value = items.some((i) => i.stock_al_pedir === 0) ? "Urgente" : "Normal";
  $("#ped-obs").value = "";
  $("#ped-items").innerHTML = "";
  items.forEach(agregarFilaItem);
  $("#ped-mail-hint").classList.remove("hidden");
  $("#ped-confirm").textContent = TXT_CONFIRMAR;
  $("#ped-confirm").disabled = false;
  $("#pedido-modal").classList.remove("hidden");
  // foco en la cantidad del primer ítem (lo único que casi siempre hay que tocar)
  const first = origen === "alerta" ? $("#ped-items .pi-cantidad") : $("#ped-items .pi-desc");
  first?.focus();
  first?.select?.();
}

function abrirEditarPedido(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  if (!puedeEditar(ped)) {
    return alert(`El pedido #${id} ya figura como "${ped.estado}".\n\nSolo Admin, Sergio o Leo pueden editarlo.`);
  }
  pedidoEditando = ped;
  pedidoOrigen = ped.origen;
  $("#pedido-modal-title").textContent =
    `✎ Editar pedido #${ped.id} — creado el ${new Date(ped.fecha).toLocaleDateString("es-AR")} por ${ped.usuario} (la fecha no se modifica)`;
  $("#ped-categoria").value = ped.categoria || "";
  $("#ped-proveedor").value = ped.proveedor || "";
  $("#ped-obra").value = ped.obra || "";
  $("#ped-obra-wrap").classList.toggle("hidden", !state.hasObra);
  $("#ped-ot").value = ped.orden_trabajo || "";
  $("#ped-ot-wrap").classList.toggle("hidden", !state.hasOT);
  $("#ped-urgencia").value = ped.urgencia || "Normal";
  $("#ped-obs").value = ped.obs || "";
  $("#ped-items").innerHTML = "";
  (ped.pedido_items || []).forEach(agregarFilaItem);
  if (!(ped.pedido_items || []).length) agregarFilaItem({});
  $("#ped-mail-hint").classList.add("hidden");
  $("#ped-confirm").textContent = TXT_GUARDAR;
  $("#ped-confirm").disabled = false;
  $("#pedido-modal").classList.remove("hidden");
  $("#ped-items .pi-desc")?.focus();
}

function agregarFilaItem(it = {}) {
  const row = document.createElement("div");
  row.className = "ped-item-row";
  row.dataset.codigo = it.codigo || "";
  row.dataset.stock = it.stock_al_pedir ?? "";
  row.dataset.itemId = it.id || "";            // ítem ya guardado (al editar)
  row.dataset.recibido = recibidoDe(it) || ""; // lo que ya llegó de este ítem
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
    // insumo escrito a mano que no está en el inventario: ofrecer crearlo (una vez por texto)
    if (v && !row.dataset.codigo && row.dataset.ofrecido !== v) {
      row.dataset.ofrecido = v;
      ofrecerCrearProducto(row);
    }
  });
  $(".pi-del", row).addEventListener("click", () => {
    if (Number(row.dataset.recibido) > 0 &&
        !confirm(`De "${$(".pi-desc", row).value}" ya se recibieron ${fmtNum(row.dataset.recibido)}.\n\n¿Quitarlo igual del pedido? (el stock que ya se sumó no cambia)`)) return;
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
    tag.innerHTML = `Insumo nuevo (no está en stock)<button type="button" class="pi-crear">＋ crear en inventario</button>`;
    tag.className = "pi-tag tag-nuevo";
    $(".pi-crear", tag).addEventListener("click", () => ofrecerCrearProducto(row));
  } else {
    tag.textContent = "";
    tag.className = "pi-tag";
  }
}

// ── Crear en el inventario un insumo nuevo escrito en el pedido ──
// Código: 2 primeras letras de cada palabra + las medidas completas.
// Ej: "Bisagra cazoleta Blum 35mm" → BICABL35MM · "Melamina blanca 18mm 2,75x1,83" → MEBL18MM275X183
const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "para", "con", "sin", "y", "o", "en", "a", "x", "por"]);

function generarCodigo(nombre) {
  const tokens = sinAcentos(nombre)
    .toUpperCase()
    .replace(/×/g, "X")
    .split(/[\s\-\/]+/)
    .map((w) => w.replace(/[^A-Z0-9,.]/g, ""))
    .filter(Boolean);
  const esNum = (w) => /^\d/.test(w || "");
  const partes = tokens
    .map((w, i) => {
      // "4 x 40" → la X entre dos números se conserva (4X40)
      if (w === "X") return esNum(tokens[i - 1]) && esNum(tokens[i + 1]) ? "X" : "";
      if (PALABRAS_VACIAS.has(w.toLowerCase())) return "";
      return /\d/.test(w) ? w.replace(/[^A-Z0-9]/g, "") : w.replace(/[^A-Z]/g, "").slice(0, 2);
    })
    .filter(Boolean);
  const base = partes.join("") || "INS";
  let codigo = base;
  for (let n = 2; productoPorCodigo(codigo); n++) codigo = `${base}-${n}`;
  return codigo;
}

let nuevoProdRow = null;

function ofrecerCrearProducto(row) {
  const nombre = $(".pi-desc", row).value.trim();
  if (!nombre) return;
  nuevoProdRow = row;
  $("#np-texto").textContent = `"${nombre}"`;
  $("#np-nombre").value = nombre;
  $("#np-codigo").value = generarCodigo(nombre);
  $("#np-categoria").value = $("#ped-categoria").value.trim();
  $("#np-stock-min").value = "5";
  $("#np-crear").disabled = false;
  $("#nuevo-prod-modal").classList.remove("hidden");
  $("#np-crear").focus();
}

function cerrarNuevoProd() {
  $("#nuevo-prod-modal").classList.add("hidden");
  nuevoProdRow?.querySelector(".pi-cantidad")?.focus();
  nuevoProdRow = null;
}

$("#np-no").addEventListener("click", cerrarNuevoProd);

$("#np-nombre").addEventListener("input", () => {
  $("#np-codigo").value = generarCodigo($("#np-nombre").value);
});

$("#np-crear").addEventListener("click", async () => {
  const row = nuevoProdRow;
  if (!row) return;
  const nombre = $("#np-nombre").value.trim();
  const codigo = $("#np-codigo").value.trim();
  if (!nombre || !codigo) return alert("Nombre y código son obligatorios.");
  const existe = productoPorCodigo(codigo);
  if (existe) return alert(`El código '${codigo}' ya lo usa "${existe.nombre}". Cambialo.`);

  const payload = {
    codigo,
    nombre,
    categoria: $("#np-categoria").value.trim(),
    precio: 0,
    stock: 0,
    stock_min: Math.max(0, parseInt($("#np-stock-min").value, 10) || 0),
    creado: nowStamp(),
  };
  if (state.hasProdExtras) {
    const auto = inferirDatos(nombre);
    payload.marca = $(".pi-marca", row).value.trim() || auto.marca;
    payload.color = $(".pi-color", row).value.trim() || auto.color;
    payload.medida = $(".pi-medida", row).value.trim() || auto.medida;
    payload.unidad = $(".pi-unidad", row).value;
    payload.proveedor = $("#ped-proveedor").value.trim();
  }

  $("#np-crear").disabled = true;
  const { error } = await sb.from("productos").insert(payload);
  if (error) {
    $("#np-crear").disabled = false;
    return alert(error.code === "23505" ? `El código '${codigo}' ya existe. Cambialo.` : `No se pudo crear.\n\nDetalle: ${error.message}`);
  }
  await loadProductos();
  refreshAlertBadge();
  // la fila del pedido queda ligada al producto recién creado
  $(".pi-desc", row).value = nombre;
  row.dataset.codigo = codigo;
  row.dataset.stock = "0";
  row.dataset.ofrecido = nombre;
  actualizarTagFila(row);
  toast(`✓ "${nombre}" guardado en el inventario con código ${codigo}`);
  cerrarNuevoProd();
});

$("#ped-add-item").addEventListener("click", () => {
  agregarFilaItem({});
  $("#ped-items .ped-item-row:last-child .pi-desc").focus();
});
$("#ped-cancel").addEventListener("click", () => {
  $("#pedido-modal").classList.add("hidden");
  pedidoEditando = null;
});

$("#ped-confirm").addEventListener("click", async () => {
  const items = $all(".ped-item-row", $("#ped-items"))
    .map((row) => ({
      _id: row.dataset.itemId ? Number(row.dataset.itemId) : null,
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

  if (pedidoEditando) return guardarEdicionPedido(items);

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
      // sin la migración v2 la base solo acepta "Pedido"
      estado: state.hasPedidosV2 ? "Pendiente" : "Pedido",
      categoria: $("#ped-categoria").value.trim(),
      proveedor: $("#ped-proveedor").value.trim(),
      urgencia: $("#ped-urgencia").value,
      obs: $("#ped-obs").value.trim(),
      ...(state.hasObra ? { obra: $("#ped-obra").value.trim() } : {}),
      ...(state.hasOT ? { orden_trabajo: $("#ped-ot").value.trim() } : {}),
      usuario: state.currentUserLabel,
    })
    .select()
    .single();

  if (error) {
    btn.disabled = false;
    btn.textContent = TXT_CONFIRMAR;
    return alert(`No se pudo guardar el pedido.\n\nDetalle: ${error.message}`);
  }

  const { error: itErr } = await sb.from("pedido_items").insert(items.map(({ _id, ...i }) => ({ ...i, pedido_id: ped.id })));
  if (itErr) {
    // sin ítems el pedido no sirve: se marca cancelado para que no quede "abierto" vacío
    await sb.from("pedidos").update({ estado: "Cancelado", obs: `Error al guardar ítems: ${itErr.message}` }).eq("id", ped.id);
    btn.disabled = false;
    btn.textContent = TXT_CONFIRMAR;
    return alert(`No se pudieron guardar los ítems del pedido.\n\nDetalle: ${itErr.message}`);
  }

  $("#pedido-modal").classList.add("hidden");
  btn.textContent = TXT_CONFIRMAR;
  toast(`✓ Pedido #${ped.id} registrado. Enviando mail…`);

  await loadPedidos();
  refreshAlertBadge();
  if (state.currentTab !== "scanner") renderCurrentTab();

  await enviarMailPedido(ped.id);
});

async function guardarEdicionPedido(items) {
  const ped = pedidoEditando;
  const btn = $("#ped-confirm");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  const errores = [];

  const header = {
    categoria: $("#ped-categoria").value.trim(),
    proveedor: $("#ped-proveedor").value.trim(),
    urgencia: $("#ped-urgencia").value,
    obs: $("#ped-obs").value.trim(),
  };
  if (state.hasObra) header.obra = $("#ped-obra").value.trim();
  if (state.hasOT) header.orden_trabajo = $("#ped-ot").value.trim();
  if (state.hasPedidosV2) Object.assign(header, { editado_por: state.currentUserLabel, fecha_editado: new Date().toISOString() });
  const { error: eH } = await sb.from("pedidos").update(header).eq("id", ped.id);
  if (eH) errores.push(eH.message);

  if (!eH) {
    const idsQuedan = new Set(items.filter((i) => i._id).map((i) => i._id));
    for (const viejo of ped.pedido_items || []) {
      if (idsQuedan.has(viejo.id)) continue;
      const { error } = await sb.from("pedido_items").delete().eq("id", viejo.id);
      if (error) errores.push(`Quitar "${viejo.descripcion}": ${error.message}`);
    }
    for (const { _id, ...it } of items) {
      if (_id) {
        const { stock_al_pedir, ...cambios } = it; // el stock al momento de pedir no se pisa
        const { error } = await sb.from("pedido_items").update(cambios).eq("id", _id);
        if (error) errores.push(`"${it.descripcion}": ${error.message}`);
      } else {
        const { error } = await sb.from("pedido_items").insert({ ...it, pedido_id: ped.id });
        if (error) errores.push(`Agregar "${it.descripcion}": ${error.message}`);
      }
    }
  }

  btn.disabled = false;
  btn.textContent = TXT_GUARDAR;
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
  if (errores.length) return alert(`No se pudieron guardar todos los cambios:\n\n${errores.join("\n")}`);

  $("#pedido-modal").classList.add("hidden");
  pedidoEditando = null;
  toast(`✓ Pedido #${ped.id} actualizado`);
  if (esAbierto(ped) && confirm(`¿Reenviar el mail del pedido #${ped.id} corregido a Sergio y Leo?`)) {
    await enviarMailPedido(ped.id);
  }
}

// ── Marcar como pedido al proveedor / borrar ─────────────────
async function marcarPedido(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  if (!confirm(`¿Confirmás que el pedido #${id} ya se le pidió al proveedor${ped.proveedor ? ` (${ped.proveedor})` : ""}?`)) return;
  const { error } = await sb
    .from("pedidos")
    .update({ estado: "Pedido", fecha_pedido_prov: new Date().toISOString(), pedido_por: state.currentUserLabel })
    .eq("id", id);
  if (error) return alert(`No se pudo actualizar.\n\nDetalle: ${error.message}`);
  toast(`✓ Pedido #${id} marcado como pedido al proveedor`);
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
}

async function borrarPedido(id) {
  if (!puedeBorrar()) return alert("Solo Admin y Sergio pueden borrar pedidos.");
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  const llego = (ped.pedido_items || []).some((i) => recibidoDe(i) > 0);
  if (
    !confirm(
      `¿BORRAR definitivamente el pedido #${id}?\n\n` +
        `Se elimina con todos sus ítems y no se puede deshacer.` +
        (llego ? `\n\nOjo: el stock que ya se sumó al recibirlo NO se descuenta (si hace falta, corregilo en Inventario).` : "") +
        `\n\nSi solo no se va a pedir, mejor usá ✕ Cancelar (queda en el historial).`
    )
  )
    return;
  const { data, error } = await sb.from("pedidos").delete().eq("id", id).select("id");
  if (error) return alert(`No se pudo borrar.\n\nDetalle: ${error.message}`);
  if (!data?.length) {
    return alert("La base no permitió borrar el pedido.\n\nFalta ejecutar supabase/pedidos_v2.sql en Supabase, o tu usuario no tiene permiso.");
  }
  toast(`🗑 Pedido #${id} borrado`);
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
}

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
  if (state.currentTab === "pedidos" || state.currentTab === "recibidos") renderCurrentTab();
}

// "Obra: Cocina Pérez · OT N° 123" (lo que haya cargado)
function obraTexto(ped) {
  return [ped.obra && `Obra: ${ped.obra}`, ped.orden_trabajo && `OT N° ${ped.orden_trabajo}`].filter(Boolean).join(" · ");
}

function textoPedido(ped) {
  const items = ped.pedido_items || [];
  return (
    `Orden de pedido #${ped.id}${ped.urgencia === "Urgente" ? " (URGENTE)" : ""}\n` +
    `Fecha: ${new Date(ped.fecha).toLocaleString("es-AR")} · Pedido por: ${ped.usuario}\n` +
    (ped.obra || ped.orden_trabajo ? `${obraTexto(ped)}\n` : "") +
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
    `${ped.urgencia === "Urgente" ? "[URGENTE] " : ""}Pedido #${ped.id}${ped.obra || ped.orden_trabajo ? ` (${obraTexto(ped)})` : ""} — ` +
    (items.length === 1 ? `${items[0].cantidad} ${items[0].unidad} de ${items[0].descripcion}` : `${items.length} insumos`);
  window.location.href =
    `mailto:${DESTINATARIOS_PEDIDO.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(textoPedido(ped))}`;
}

// ── Pestañas PEDIDOS (abiertos) y RECIBIDOS (archivo) ───────
const AVISO_SIN_MODULO = `
  <div class="unknown-card">
    <h3>⚠  El módulo de pedidos todavía no está activado</h3>
    <p>Un administrador tiene que ejecutar <b>supabase/pedidos.sql</b> en el SQL Editor de Supabase
    (ver <b>supabase/SETUP.md</b>, paso 11). No borra ni cambia ningún producto.</p>
  </div>`;

function renderPedidos() {
  renderVistaPedidos({
    vista: "abiertos",
    titulo: "🛒  Pedidos",
    filtroKey: "pedFiltro",
    filtros: [
      ["abiertos", "Todos los pendientes"],
      ...(state.hasPedidosV2 ? [["Pendiente", "Falta pedir al proveedor"]] : []),
      ["Pedido", "Pedidos, esperando entrega"],
    ],
  });
}

function renderRecibidos() {
  renderVistaPedidos({
    vista: "archivo",
    titulo: "📦  Recibidos",
    filtroKey: "archFiltro",
    filtros: [
      ["Recibido", "Recibidos"],
      ["Cancelado", "Cancelados"],
      ["archivo", "Todos"],
    ],
  });
}

function renderVistaPedidos({ vista, titulo, filtroKey, filtros }) {
  const content = $("#content");
  if (!state.hasPedidos) {
    content.innerHTML = `<h2 class="tab-title">${titulo}</h2>${AVISO_SIN_MODULO}`;
    return;
  }
  if (!filtros.some(([v]) => v === state[filtroKey])) state[filtroKey] = filtros[0][0];
  content.innerHTML = `
    <h2 class="tab-title">${titulo}</h2>
    ${state.hasPedidosV2 ? "" : `<p class="hint" style="color:var(--yellow)">⚠ Falta ejecutar <b>supabase/pedidos_v2.sql</b> para activar el estado "Pendiente" y el borrado de pedidos.</p>`}
    <div class="toolbar">
      <div class="hist-filters" style="margin:0">
        ${filtros
          .map(
            ([v, l]) =>
              `<label><input type="radio" name="ped-filtro" value="${v}" ${state[filtroKey] === v ? "checked" : ""}/> ${l}</label>`
          )
          .join("")}
      </div>
      <input type="text" id="ped-search" placeholder="Buscar insumo, obra, OT, proveedor, #…" />
      <div class="spacer"></div>
      ${vista === "abiertos" ? `<button class="btn-accent btn-inline" id="ped-nuevo">＋  Nuevo pedido manual</button>` : ""}
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th><th>Fecha</th><th>Insumos</th><th>Obra</th><th>Categoría</th><th>Proveedor</th>
          <th>Por</th><th class="center">Estado</th><th class="center">Mail</th><th class="center">Acciones</th>
        </tr>
      </thead>
      <tbody id="ped-tbody"></tbody>
    </table>
  `;
  $all('input[name="ped-filtro"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state[filtroKey] = e.target.value;
      renderPedidoRows();
    })
  );
  $("#ped-search").addEventListener("input", renderPedidoRows);
  $("#ped-nuevo")?.addEventListener("click", abrirPedidoManual);
  renderPedidoRows();
}

const MAIL_BADGE = {
  enviado: ["✓", "badge-green", "Mail enviado"],
  manual: ["✉", "badge-blue", "Enviado desde el correo del usuario"],
  error: ["⚠", "badge-red", "No se pudo enviar"],
  pendiente: ["…", "badge-gray", "Pendiente de envío"],
};
const ESTADO_BADGE = { Pendiente: "badge-orange", Pedido: "badge-blue", Recibido: "badge-green", Cancelado: "badge-gray" };

// Entregas parciales: cantidad_recibida es ACUMULADA (suma de todas las entregas)
const recibidoDe = (it) => Number(it.cantidad_recibida) || 0;
const pendienteDe = (it) => Math.max(0, Number(it.cantidad) - recibidoDe(it));
const fmtNum = (n) => String(Math.round(Number(n) * 100) / 100).replace(".", ",");

function estadoPedidoHtml(p) {
  const items = p.pedido_items || [];
  const llegoAlgo = items.some((i) => recibidoDe(i) > 0);
  const falta = items.some((i) => pendienteDe(i) > 0);
  if (esAbierto(p) && llegoAlgo) return `<span class="badge badge-yellow" title="Llegó una parte, falta el resto">Parcial</span>`;
  if (p.estado === "Pendiente") return `<span class="badge badge-orange" title="Falta pedírselo al proveedor">Pendiente</span>`;
  if (p.estado === "Pedido" && p.fecha_pedido_prov)
    return `<span class="badge badge-blue">Pedido</span><br><span class="muted">${new Date(p.fecha_pedido_prov).toLocaleDateString("es-AR")}${p.pedido_por ? ` · ${escapeHtml(p.pedido_por)}` : ""}</span>`;
  if (p.estado === "Recibido" && falta) return `<span class="badge badge-green" title="Se cerró con mercadería faltante">Recibido</span><br><span class="muted" style="color:var(--yellow)">con faltante</span>`;
  return `<span class="badge ${ESTADO_BADGE[p.estado]}">${p.estado}</span>`;
}

function renderPedidoRows() {
  const q = ($("#ped-search")?.value || "").trim().toLowerCase();
  const enArchivo = state.currentTab === "recibidos";
  const f = enArchivo ? state.archFiltro : state.pedFiltro;
  const rows = state.pedidos.filter((p) => {
    if (enArchivo === esAbierto(p)) return false; // abiertos en Pedidos, cerrados en Recibidos
    if (f !== "abiertos" && f !== "archivo" && p.estado !== f) return false;
    if (!q) return true;
    const hay = [p.id, p.obra, p.orden_trabajo, p.proveedor, p.categoria, p.usuario, p.obs, ...(p.pedido_items || []).map((i) => `${i.descripcion} ${i.codigo} ${i.marca} ${i.color}`)]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const tbody = $("#ped-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="center" style="color:var(--fg2);padding:24px">${
      enArchivo ? "No hay pedidos para mostrar." : "✓ No hay pedidos pendientes. Los recibidos están en 📦 Recibidos."
    }</td></tr>`;
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
            `${
              recibidoDe(i) > 0
                ? pendienteDe(i) > 0
                  ? ` <span class="muted" style="color:var(--yellow)">→ llegó ${fmtNum(recibidoDe(i))}, falta ${fmtNum(pendienteDe(i))}</span>`
                  : ` <span class="muted" style="color:var(--green)">→ llegó ${fmtNum(recibidoDe(i))} ✓</span>`
                : ""
            }</div>`
        )
        .join("");
      return `
        <tr>
          <td>${p.id}${p.urgencia === "Urgente" ? ' <span class="badge badge-red">URG</span>' : ""}</td>
          <td style="white-space:nowrap">${new Date(p.fecha).toLocaleDateString("es-AR")}<br><span class="muted">${p.origen === "alerta" ? "⚠ por alerta" : "✎ manual"}</span></td>
          <td>${items}${p.obs ? `<div class="muted">📝 ${escapeHtml(p.obs)}</div>` : ""}</td>
          <td>${p.obra ? `<b>${escapeHtml(p.obra)}</b>` : p.orden_trabajo ? "" : "—"}${p.orden_trabajo ? `${p.obra ? "<br>" : ""}<span class="muted">OT N° ${escapeHtml(p.orden_trabajo)}</span>` : ""}</td>
          <td>${escapeHtml(p.categoria || "—")}</td>
          <td>${escapeHtml(p.proveedor || "—")}</td>
          <td>${escapeHtml(p.usuario || "—")}</td>
          <td class="center">${estadoPedidoHtml(p)}${p.fecha_recibido ? `<br><span class="muted">${new Date(p.fecha_recibido).toLocaleDateString("es-AR")}</span>` : ""}</td>
          <td class="center"><span class="badge ${mCls}" title="${escapeHtml(p.email_detalle || mTit)}">${mIcon}</span></td>
          <td class="actions center">
            ${p.estado === "Pendiente" ? `<button class="icon-btn btn-marcar" data-act="marcar" data-id="${p.id}" title="Ya se lo pedimos al proveedor">✓ Marcar pedido</button>` : ""}
            ${esAbierto(p) ? `<button class="icon-btn" data-act="recibir" data-id="${p.id}" title="Registrar lo que llegó (suma al stock). Se puede hacer en varias entregas.">📦 Recibir</button>` : ""}
            ${!esAbierto(p) ? `<button class="icon-btn" data-act="reabrir" data-id="${p.id}" title="Reabrir el pedido (ej: el proveedor trae el resto otro día)">↺ Reabrir</button>` : ""}
            ${puedeEditar(p) ? `<button class="icon-btn" data-act="editar" data-id="${p.id}" title="Editar pedido">✎</button>` : ""}
            <button class="icon-btn" data-act="pdf" data-id="${p.id}" title="Descargar orden en PDF">⬇ PDF</button>
            ${state.hasHistPedidos ? `<button class="icon-btn" data-act="historial" data-id="${p.id}" title="Ver quién modificó este pedido">⏱</button>` : ""}
            ${esAbierto(p) ? `<button class="icon-btn" data-act="mail" data-id="${p.id}" title="Volver a enviar el mail">✉</button>` : ""}
            ${esAbierto(p) ? `<button class="icon-btn danger" data-act="cancelar" data-id="${p.id}" title="Cancelar pedido">✕</button>` : ""}
            ${puedeBorrar() && state.hasPedidosV2 ? `<button class="icon-btn danger" data-act="borrar" data-id="${p.id}" title="Borrar pedido definitivamente">🗑</button>` : ""}
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
      if (b.dataset.act === "reabrir") reabrirPedido(id);
      if (b.dataset.act === "marcar") marcarPedido(id);
      if (b.dataset.act === "editar") abrirEditarPedido(id);
      if (b.dataset.act === "borrar") borrarPedido(id);
      if (b.dataset.act === "historial") verHistorialPedido(id);
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

async function reabrirPedido(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  const faltan = (ped.pedido_items || []).filter((i) => pendienteDe(i) > 0);
  if (
    !confirm(
      `¿Reabrir el pedido #${id}?\n\n` +
        (faltan.length
          ? `Queda pendiente:\n${faltan.map((i) => `· ${fmtNum(pendienteDe(i))} ${i.unidad} de ${i.descripcion}`).join("\n")}\n\n`
          : "") +
        `Lo que ya se recibió queda registrado (no se vuelve a sumar al stock).`
    )
  )
    return;
  const estado = state.hasPedidosV2 && !ped.fecha_pedido_prov && ped.estado === "Cancelado" ? "Pendiente" : "Pedido";
  const { error } = await sb.from("pedidos").update({ estado, fecha_recibido: null }).eq("id", id);
  if (error) return alert(`No se pudo reabrir.\n\nDetalle: ${error.message}`);
  toast(`↺ Pedido #${id} reabierto — está de nuevo en 🛒 Pedidos`);
  await loadPedidos();
  refreshAlertBadge();
  renderCurrentTab();
}

// ── Recepción: puede ser en varias entregas (parciales) ──────
let recibirId = null;

function abrirRecibir(id) {
  const ped = state.pedidos.find((p) => p.id === id);
  if (!ped) return;
  recibirId = id;
  $("#recibir-title").textContent = `📦 Recibir pedido #${id}${ped.proveedor ? ` — ${ped.proveedor}` : ""}`;
  $("#recibir-items").innerHTML = (ped.pedido_items || [])
    .map((it) => {
      const prod = it.codigo ? productoPorCodigo(it.codigo) : null;
      const ya = recibidoDe(it);
      const falta = pendienteDe(it);
      return `
        <div class="recibir-row ${falta === 0 ? "rr-completo" : ""}" data-item="${it.id}">
          <div class="rr-desc">${escapeHtml(it.descripcion)}<br>
            <span class="muted">Pedido: ${fmtNum(it.cantidad)} ${escapeHtml(it.unidad)}` +
        (ya > 0 ? ` · ya llegó ${fmtNum(ya)} · <b style="color:${falta ? "var(--yellow)" : "var(--green)"}">${falta ? `falta ${fmtNum(falta)}` : "completo ✓"}</b>` : "") +
        `${prod ? ` · stock actual ${prod.stock}` : " · insumo nuevo"}</span></div>
          <label>Llega ahora<input type="number" class="rr-cant" min="0" step="any" value="${fmtNum(falta).replace(",", ".")}" /></label>
          ${
            prod
              ? `<label class="rr-check"><input type="checkbox" class="rr-sumar" checked /> Sumar al stock</label>`
              : `<span class="muted rr-check">No está en stock — cargalo en ＋ Productos si corresponde</span>`
          }
        </div>`;
    })
    .join("");
  $("#recibir-cerrar").checked = false;
  $("#recibir-confirm").disabled = false;
  $("#recibir-modal").classList.remove("hidden");
  $(".recibir-row:not(.rr-completo) .rr-cant")?.select();
}

$("#recibir-cancel").addEventListener("click", () => $("#recibir-modal").classList.add("hidden"));

$("#recibir-confirm").addEventListener("click", async () => {
  const ped = state.pedidos.find((p) => p.id === recibirId);
  if (!ped) return;
  const filas = $all(".recibir-row", $("#recibir-items")).map((row) => ({
    row,
    it: ped.pedido_items.find((x) => String(x.id) === row.dataset.item),
    cant: Math.max(0, parseFloat(String($(".rr-cant", row).value).replace(",", ".")) || 0),
  }));
  const cerrarIgual = $("#recibir-cerrar").checked;
  if (!filas.some((f) => f.cant > 0) && !cerrarIgual) {
    return alert("No cargaste ninguna cantidad.\n\nSi el proveedor no va a traer nada más, tildá \"Cerrar el pedido aunque falte mercadería\".");
  }

  const btn = $("#recibir-confirm");
  btn.disabled = true;
  const errores = [];
  const recibidoNuevo = {}; // item.id -> acumulado después de esta entrega

  for (const { row, it, cant } of filas) {
    recibidoNuevo[it.id] = recibidoDe(it) + cant;
    if (cant <= 0) continue;
    const { error: eIt } = await sb.from("pedido_items").update({ cantidad_recibida: recibidoNuevo[it.id] }).eq("id", it.id);
    if (eIt) { errores.push(`${it.descripcion}: ${eIt.message}`); continue; }

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
      nota:
        `Recepción pedido #${ped.id}${ped.proveedor ? ` (${ped.proveedor})` : ""}` +
        (recibidoNuevo[it.id] < Number(it.cantidad) ? ` — parcial ${fmtNum(recibidoNuevo[it.id])} de ${fmtNum(it.cantidad)}` : ""),
      usuario: state.currentUserLabel,
      fecha: nowStamp(),
    });
  }

  const faltantes = filas.filter(({ it }) => recibidoNuevo[it.id] < Number(it.cantidad));
  const completo = faltantes.length === 0;
  let error = null;
  if (!completo && !cerrarIgual && ped.estado === "Pendiente") {
    // llegó una parte de algo que figuraba "Pendiente": evidentemente ya se pidió
    ({ error } = await sb.from("pedidos").update({ estado: "Pedido", fecha_pedido_prov: new Date().toISOString(), pedido_por: state.currentUserLabel }).eq("id", ped.id));
  }
  if (completo || cerrarIgual) {
    ({ error } = await sb
      .from("pedidos")
      .update({ estado: "Recibido", fecha_recibido: new Date().toISOString(), recibido_por: state.currentUserLabel })
      .eq("id", ped.id));
  }

  $("#recibir-modal").classList.add("hidden");
  if (error || errores.length) {
    alert(`La recepción se registró con problemas:\n\n${[error?.message, ...errores].filter(Boolean).join("\n")}`);
  } else if (completo) {
    toast(`✓ Pedido #${ped.id} recibido completo y stock actualizado — pasó a 📦 Recibidos`);
  } else if (cerrarIgual) {
    toast(`Pedido #${ped.id} cerrado con faltante (${faltantes.length} ítem${faltantes.length > 1 ? "s" : ""}) — pasó a 📦 Recibidos`);
  } else {
    toast(`📦 Entrega parcial registrada. El pedido #${ped.id} sigue abierto: falta${faltantes.length > 1 ? "n" : ""} ${faltantes.length} ítem${faltantes.length > 1 ? "s" : ""}`);
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
  const hayRecibido = (ped.pedido_items || []).some((i) => recibidoDe(i) > 0);

  doc.setFontSize(18);
  doc.setTextColor(234, 88, 12);
  doc.text(`Orden de pedido #${ped.id}${ped.urgencia === "Urgente" ? "  —  URGENTE" : ""}`, 40, 46);
  doc.setFontSize(10);
  doc.setTextColor(60);
  doc.text(`Grupo Aixa  ·  ${new Date(ped.fecha).toLocaleString("es-AR")}  ·  Pedido por: ${ped.usuario}`, 40, 64);
  doc.text(`Categoría: ${ped.categoria || "—"}     Proveedor: ${ped.proveedor || "—"}     Estado: ${ped.estado}`, 40, 80);
  const conObra = ped.obra || ped.orden_trabajo;
  if (conObra) {
    doc.setFontSize(12);
    doc.setTextColor(30);
    doc.text(obraTexto(ped), 40, 98);
  }

  doc.autoTable({
    startY: conObra ? 112 : 96,
    head: [["Insumo", "Código", "Marca", "Color", "Medida", "Cantidad", ...(hayRecibido ? ["Recibido"] : [])]],
    body: (ped.pedido_items || []).map((i) => [
      i.descripcion,
      i.codigo || "nuevo",
      i.marca || "—",
      i.color || "—",
      i.medida || "—",
      `${fmtNum(i.cantidad)} ${i.unidad}`,
      ...(hayRecibido ? [pendienteDe(i) > 0 ? `${fmtNum(recibidoDe(i))} (falta ${fmtNum(pendienteDe(i))})` : `${fmtNum(recibidoDe(i))} (completo)`] : []),
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
  // si está abierto el aviso de insumo nuevo, Escape cierra solo ese (el pedido sigue abierto)
  if (!$("#nuevo-prod-modal").classList.contains("hidden")) return cerrarNuevoProd();
  ["#pedido-modal", "#recibir-modal", "#edit-stock-modal"].forEach((m) => $(m).classList.add("hidden"));
});
