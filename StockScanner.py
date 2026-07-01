import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import sqlite3
import csv
import os
import sys
import json
from datetime import datetime

# ─── RUTA DE LA BASE DE DATOS ────────────────────────────────────
def _get_base_dir():
    """Siempre devuelve la carpeta real donde está el .exe o el .py."""
    if getattr(sys, 'frozen', False):
        # Corriendo como .exe de PyInstaller
        path = os.path.realpath(sys.executable)
    else:
        try:
            path = os.path.realpath(__file__)
        except Exception:
            path = os.path.realpath(sys.argv[0])
    return os.path.dirname(path)

_BASE_DIR = _get_base_dir()
DB_FILE   = os.path.join(_BASE_DIR, "stockscanner.db")

def _check_write_permission():
    """Verifica que podemos crear/escribir la base de datos."""
    try:
        test_path = os.path.join(_BASE_DIR, "_write_test.tmp")
        with open(test_path, "w") as f:
            f.write("test")
        os.remove(test_path)
        return True, ""
    except Exception as e:
        return False, str(e)

def _show_startup_error(msg):
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "Error al iniciar StockScanner",
        f"No se puede guardar datos en:\n{_BASE_DIR}\n\n"
        f"Error: {msg}\n\n"
        f"Soluciones:\n"
        f"1. Mové el .exe al Escritorio y abrilo desde ahí\n"
        f"2. Clic derecho → Ejecutar como administrador\n"
        f"3. Verificá que el antivirus no bloquea el programa"
    )
    root.destroy()

# ─── DATABASE ────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS productos (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo     TEXT UNIQUE NOT NULL,
            nombre     TEXT NOT NULL,
            categoria  TEXT DEFAULT '',
            precio     REAL DEFAULT 0,
            stock      INTEGER DEFAULT 0,
            stock_min  INTEGER DEFAULT 5,
            creado     TEXT
        )""")
    c.execute("""
        CREATE TABLE IF NOT EXISTS movimientos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo      TEXT NOT NULL,
            tipo        TEXT NOT NULL,
            cantidad    INTEGER NOT NULL,
            stock_prev  INTEGER,
            stock_post  INTEGER,
            nota        TEXT DEFAULT '',
            fecha       TEXT
        )""")
    conn.commit()
    conn.close()

# ─── COLORS & FONTS ─────────────────────────────────────────────
BG        = "#0D1117"
BG2       = "#161B22"
BG3       = "#21262D"
ACCENT    = "#F97316"
ACCENT2   = "#FB923C"
GREEN     = "#22C55E"
RED       = "#EF4444"
YELLOW    = "#EAB308"
BLUE      = "#3B82F6"
FG        = "#F0F6FC"
FG2       = "#8B949E"
BORDER    = "#30363D"

FONT_TITLE = ("Segoe UI", 22, "bold")
FONT_BIG   = ("Segoe UI", 14, "bold")
FONT_MED   = ("Segoe UI", 11)
FONT_SMALL = ("Segoe UI", 9)
FONT_CODE  = ("Consolas", 13, "bold")
FONT_MONO  = ("Consolas", 10)

# ─── MAIN APP ────────────────────────────────────────────────────
class StockScannerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        init_db()
        self.title("StockScanner — Control de Inventario")
        self.geometry("1100x720")
        self.minsize(900, 600)
        self.configure(bg=BG)
        self.resizable(True, True)

        self.current_tab = tk.StringVar(value="scanner")
        self.scan_buffer = ""
        self._last_scan  = ""

        self._build_layout()
        self._show_tab("scanner")

        self.bind("<Key>", self._on_key)
        self.bind("<Return>", self._on_scan_enter)
        self.after(100, lambda: self.scan_entry.focus_set())

    def _build_layout(self):
        self.sidebar = tk.Frame(self, bg=BG2, width=200)
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)

        logo_frame = tk.Frame(self.sidebar, bg=BG2)
        logo_frame.pack(fill="x", padx=16, pady=(20, 8))
        tk.Label(logo_frame, text="⬡", font=("Segoe UI", 28), fg=ACCENT, bg=BG2).pack(anchor="w")
        tk.Label(logo_frame, text="StockScanner", font=("Segoe UI", 13, "bold"), fg=FG, bg=BG2).pack(anchor="w")
        tk.Label(logo_frame, text="Control de Inventario", font=FONT_SMALL, fg=FG2, bg=BG2).pack(anchor="w")

        tk.Frame(self.sidebar, bg=BORDER, height=1).pack(fill="x", padx=12, pady=12)

        self.nav_buttons = {}
        tabs = [
            ("scanner",   "◉  Escanear",   "Registrá movimientos"),
            ("stock",     "☰  Inventario", "Ver y editar stock"),
            ("historial", "⏱  Historial",  "Movimientos recientes"),
            ("productos", "＋  Productos",  "Agregar / editar"),
            ("alertas",   "⚠  Alertas",    "Stock bajo mínimo"),
        ]
        for key, label, sub in tabs:
            self.nav_buttons[key] = self._nav_btn(key, label, sub)

        # DB path info at bottom
        tk.Frame(self.sidebar, bg=BORDER, height=1).pack(fill="x", padx=12, pady=12, side="bottom")
        db_short = "..." + DB_FILE[-28:] if len(DB_FILE) > 30 else DB_FILE
        tk.Label(self.sidebar, text=f"DB: {db_short}", font=("Segoe UI", 7),
                 fg=FG2, bg=BG2, wraplength=180).pack(side="bottom", padx=8, pady=(0,2), anchor="w")
        tk.Label(self.sidebar, text="● Nictom 3100 — HID", font=FONT_SMALL,
                 fg=GREEN, bg=BG2).pack(side="bottom", padx=16, pady=(0,4), anchor="w")

        self.content = tk.Frame(self, bg=BG)
        self.content.pack(side="left", fill="both", expand=True)

    def _nav_btn(self, key, label, sub):
        frame = tk.Frame(self.sidebar, bg=BG2, cursor="hand2")
        frame.pack(fill="x", padx=8, pady=2)
        lbl = tk.Label(frame, text=label, font=("Segoe UI", 11, "bold"),
                       fg=FG2, bg=BG2, anchor="w", padx=12, pady=6)
        lbl.pack(fill="x")

        def on_enter(e):
            if self.current_tab.get() != key:
                frame.configure(bg=BG3); lbl.configure(bg=BG3)
        def on_leave(e):
            if self.current_tab.get() != key:
                frame.configure(bg=BG2); lbl.configure(bg=BG2)
        def on_click(e): self._show_tab(key)

        for w in (frame, lbl):
            w.bind("<Enter>", on_enter)
            w.bind("<Leave>", on_leave)
            w.bind("<Button-1>", on_click)
        return (frame, lbl)

    def _set_nav_active(self, key):
        for k, (frame, lbl) in self.nav_buttons.items():
            if k == key:
                frame.configure(bg=BG3)
                lbl.configure(fg=ACCENT, bg=BG3)
            else:
                frame.configure(bg=BG2)
                lbl.configure(fg=FG2, bg=BG2)

    def _show_tab(self, key):
        self.current_tab.set(key)
        self._set_nav_active(key)
        for w in self.content.winfo_children():
            w.destroy()
        {
            "scanner":   self._tab_scanner,
            "stock":     self._tab_stock,
            "historial": self._tab_historial,
            "productos": self._tab_productos,
            "alertas":   self._tab_alertas,
        }[key]()

    # ── SCANNER TAB ─────────────────────────────────────────────
    def _tab_scanner(self):
        pad = tk.Frame(self.content, bg=BG)
        pad.pack(fill="both", expand=True, padx=28, pady=24)

        hdr = tk.Frame(pad, bg=BG)
        hdr.pack(fill="x", pady=(0,20))
        tk.Label(hdr, text="◉  Escanear Producto", font=FONT_TITLE, fg=FG, bg=BG).pack(side="left")

        scan_card = tk.Frame(pad, bg=BG2, highlightbackground=ACCENT,
                             highlightthickness=1)
        scan_card.pack(fill="x", pady=(0,16))

        inner = tk.Frame(scan_card, bg=BG2)
        inner.pack(fill="x", padx=20, pady=20)

        tk.Label(inner, text="CÓDIGO DE BARRAS", font=("Segoe UI", 9, "bold"),
                 fg=ACCENT, bg=BG2, anchor="w").pack(fill="x")

        entry_frame = tk.Frame(inner, bg=BG3)
        entry_frame.pack(fill="x", pady=(6,0))

        self.scan_entry = tk.Entry(entry_frame, font=FONT_CODE, fg=ACCENT2, bg=BG3,
                                   insertbackground=ACCENT, relief="flat", bd=0, width=30)
        self.scan_entry.pack(side="left", fill="x", expand=True, padx=12, pady=10)
        self.scan_entry.bind("<Return>", self._process_scan)

        tk.Button(entry_frame, text="Buscar  ⏎", font=("Segoe UI", 10, "bold"),
                  fg=BG, bg=ACCENT, activebackground=ACCENT2, activeforeground=BG,
                  relief="flat", bd=0, padx=14, pady=8, cursor="hand2",
                  command=lambda: self._process_scan(None)).pack(side="right", padx=4, pady=4)

        tk.Label(inner, text="Apuntá el lector al código — el resultado aparece abajo automáticamente",
                 font=FONT_SMALL, fg=FG2, bg=BG2).pack(anchor="w", pady=(8,0))

        tipo_frame = tk.Frame(pad, bg=BG)
        tipo_frame.pack(fill="x", pady=(0,16))
        tk.Label(tipo_frame, text="TIPO DE MOVIMIENTO:", font=("Segoe UI", 9, "bold"),
                 fg=FG2, bg=BG).pack(side="left", padx=(0,12))
        self.tipo_var = tk.StringVar(value="entrada")
        for val, label, color in [("entrada","▲  ENTRADA",GREEN),("salida","▼  SALIDA",RED),("ajuste","◎  AJUSTE",YELLOW)]:
            tk.Radiobutton(tipo_frame, text=label, variable=self.tipo_var, value=val,
                           font=("Segoe UI", 10, "bold"), fg=color, bg=BG,
                           selectcolor=BG3, activebackground=BG, activeforeground=color,
                           relief="flat", bd=0, cursor="hand2").pack(side="left", padx=8)

        qty_frame = tk.Frame(pad, bg=BG)
        qty_frame.pack(fill="x", pady=(0,16))
        tk.Label(qty_frame, text="CANTIDAD:", font=("Segoe UI", 9, "bold"),
                 fg=FG2, bg=BG).pack(side="left", padx=(0,12))
        self.qty_var = tk.IntVar(value=1)
        tk.Spinbox(qty_frame, from_=1, to=9999, textvariable=self.qty_var,
                   font=FONT_BIG, fg=FG, bg=BG3, relief="flat",
                   buttonbackground=BG3, width=5, bd=0,
                   insertbackground=FG).pack(side="left")
        tk.Label(qty_frame, text="  NOTA:", font=("Segoe UI", 9, "bold"),
                 fg=FG2, bg=BG).pack(side="left", padx=(24,8))
        self.nota_var = tk.StringVar()
        tk.Entry(qty_frame, textvariable=self.nota_var, font=FONT_MED,
                 fg=FG, bg=BG3, insertbackground=FG, relief="flat", bd=0, width=24
                 ).pack(side="left", ipady=4)

        self.result_frame = tk.Frame(pad, bg=BG2)
        self.result_frame.pack(fill="both", expand=True)
        _show_placeholder(self.result_frame, "Esperando escaneo...", FG2)
        self.scan_entry.focus_set()

    def _process_scan(self, event):
        codigo = self.scan_entry.get().strip()
        if not codigo:
            return
        self._last_scan = codigo
        self.scan_entry.delete(0, tk.END)

        conn = get_db()
        prod = conn.execute("SELECT * FROM productos WHERE codigo=?", (codigo,)).fetchone()
        conn.close()

        for w in self.result_frame.winfo_children():
            w.destroy()

        if prod:
            self._show_scan_result(prod, codigo)
        else:
            self._show_scan_unknown(codigo)

    def _show_scan_result(self, prod, codigo):
        f = self.result_frame
        tipo  = self.tipo_var.get()
        qty   = self.qty_var.get()
        nota  = self.nota_var.get()
        color = GREEN if tipo == "entrada" else RED if tipo == "salida" else YELLOW

        card = tk.Frame(f, bg=BG3)
        card.pack(fill="x", pady=(0,12))
        left = tk.Frame(card, bg=BG3)
        left.pack(side="left", fill="both", expand=True, padx=20, pady=16)
        tk.Label(left, text=prod["nombre"], font=FONT_BIG, fg=FG, bg=BG3).pack(anchor="w")
        tk.Label(left, text=f"Código: {prod['codigo']}   Categoría: {prod['categoria'] or '—'}",
                 font=FONT_SMALL, fg=FG2, bg=BG3).pack(anchor="w", pady=(2,0))

        stock_prev = prod["stock"]
        if tipo == "entrada":
            stock_post = stock_prev + qty
        elif tipo == "salida":
            stock_post = max(0, stock_prev - qty)
        else:
            stock_post = qty

        right = tk.Frame(card, bg=BG3)
        right.pack(side="right", padx=20, pady=16)
        tk.Label(right, text="STOCK ACTUAL", font=("Segoe UI", 8, "bold"), fg=FG2, bg=BG3).pack()
        stk_color = GREEN if stock_prev > prod["stock_min"] else YELLOW if stock_prev > 0 else RED
        tk.Label(right, text=str(stock_prev), font=("Segoe UI", 28, "bold"), fg=stk_color, bg=BG3).pack()

        mv_frame = tk.Frame(f, bg=BG2)
        mv_frame.pack(fill="x", pady=(0,12))
        tk.Label(mv_frame, text=f"  Movimiento: {tipo.upper()}  {qty} unidad{'es' if qty>1 else ''}",
                 font=("Segoe UI", 11, "bold"), fg=color, bg=BG2).pack(side="left", padx=16, pady=12)
        tk.Label(mv_frame, text=f"{stock_prev}  →  {stock_post}",
                 font=FONT_CODE, fg=FG, bg=BG2).pack(side="left", padx=16)
        if nota:
            tk.Label(mv_frame, text=f"  Nota: {nota}", font=FONT_SMALL, fg=FG2, bg=BG2).pack(side="left")

        btn_frame = tk.Frame(f, bg=BG)
        btn_frame.pack(fill="x")

        def confirmar():
            try:
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn = get_db()
                conn.execute("UPDATE productos SET stock=? WHERE codigo=?", (stock_post, codigo))
                conn.execute(
                    "INSERT INTO movimientos (codigo,tipo,cantidad,stock_prev,stock_post,nota,fecha) VALUES (?,?,?,?,?,?,?)",
                    (codigo, tipo, qty, stock_prev, stock_post, nota, now))
                conn.commit()
                conn.close()
                self.nota_var.set("")
                self.qty_var.set(1)
                for w in f.winfo_children(): w.destroy()
                conf = tk.Frame(f, bg=BG3)
                conf.pack(fill="x", pady=8)
                tk.Label(conf,
                         text=f"✓  {prod['nombre']}  —  {tipo.upper()} de {qty} unidades registrada",
                         font=("Segoe UI", 13, "bold"), fg=GREEN, bg=BG3,
                         pady=20, padx=20).pack(fill="x")
                tk.Label(f, text=f"Stock: {stock_prev} → {stock_post}",
                         font=FONT_MED, fg=FG2, bg=BG).pack(pady=4)
                self.scan_entry.focus_set()
                self._refresh_alert_count()
            except Exception as e:
                messagebox.showerror("Error al guardar",
                    f"No se pudo guardar el movimiento.\n\nDetalle: {e}\n\nRuta DB: {DB_FILE}")

        tk.Button(btn_frame, text=f"✓  CONFIRMAR {tipo.upper()}",
                  font=("Segoe UI", 12, "bold"), fg=BG, bg=color,
                  activebackground=color, relief="flat", bd=0,
                  padx=20, pady=10, cursor="hand2",
                  command=confirmar).pack(side="left")
        tk.Button(btn_frame, text="✕  Cancelar",
                  font=("Segoe UI", 11), fg=FG2, bg=BG3,
                  activebackground=BORDER, relief="flat", bd=0,
                  padx=16, pady=10, cursor="hand2",
                  command=lambda: [w.destroy() for w in f.winfo_children()] or
                  _show_placeholder(f, "Esperando escaneo...", FG2)).pack(side="left", padx=(8,0))

    def _show_scan_unknown(self, codigo):
        f = self.result_frame
        card = tk.Frame(f, bg=BG3)
        card.pack(fill="x")
        inner = tk.Frame(card, bg=BG3)
        inner.pack(padx=20, pady=20, fill="x")
        tk.Label(inner, text="⚠  Código no encontrado en el sistema",
                 font=FONT_BIG, fg=YELLOW, bg=BG3).pack(anchor="w")
        tk.Label(inner, text=f"Código escaneado: {codigo}",
                 font=FONT_CODE, fg=FG2, bg=BG3).pack(anchor="w", pady=(4,12))
        tk.Label(inner, text="Primero tenés que agregar este producto en ＋ Productos",
                 font=FONT_MED, fg=FG, bg=BG3).pack(anchor="w")
        btn_frame = tk.Frame(inner, bg=BG3)
        btn_frame.pack(anchor="w", pady=(12,0))
        def ir_a_productos():
            self._show_tab("productos")
            self.after(150, lambda: self._prefill_nuevo_producto(codigo))
        tk.Button(btn_frame, text="＋  Ir a Agregar Producto",
                  font=("Segoe UI", 10, "bold"), fg=BG, bg=ACCENT,
                  relief="flat", bd=0, padx=14, pady=8, cursor="hand2",
                  command=ir_a_productos).pack(side="left")

    def _prefill_nuevo_producto(self, codigo):
        if hasattr(self, 'codigo_entry'):
            self.codigo_entry.delete(0, tk.END)
            self.codigo_entry.insert(0, codigo)
            if hasattr(self, 'nombre_entry'):
                self.nombre_entry.focus_set()

    # ── STOCK TAB ───────────────────────────────────────────────
    def _tab_stock(self):
        pad = tk.Frame(self.content, bg=BG)
        pad.pack(fill="both", expand=True, padx=28, pady=24)
        tk.Label(pad, text="☰  Inventario", font=FONT_TITLE, fg=FG, bg=BG).pack(anchor="w", pady=(0,16))

        toolbar = tk.Frame(pad, bg=BG)
        toolbar.pack(fill="x", pady=(0,12))
        self.search_var = tk.StringVar()
        self.search_var.trace("w", lambda *a: self._refresh_stock_table())
        tk.Label(toolbar, text="Buscar:", font=FONT_SMALL, fg=FG2, bg=BG).pack(side="left")
        tk.Entry(toolbar, textvariable=self.search_var, font=FONT_MED,
                 fg=FG, bg=BG3, insertbackground=FG, relief="flat", bd=0,
                 width=22).pack(side="left", ipady=5, padx=(6,16))
        tk.Button(toolbar, text="↑↓  Exportar CSV",
                  font=("Segoe UI", 9, "bold"), fg=FG, bg=BG3,
                  activebackground=BORDER, relief="flat", bd=0,
                  padx=12, pady=6, cursor="hand2",
                  command=self._export_csv).pack(side="right")
        tk.Button(toolbar, text="↻  Actualizar",
                  font=("Segoe UI", 9, "bold"), fg=FG, bg=BG3,
                  activebackground=BORDER, relief="flat", bd=0,
                  padx=12, pady=6, cursor="hand2",
                  command=self._refresh_stock_table).pack(side="right", padx=(0,8))

        cols = ("codigo","nombre","categoria","stock","stock_min","precio","estado")
        col_labels = ("Código","Nombre","Categoría","Stock","Mín.","Precio","Estado")
        col_widths  = (110,220,110,70,55,80,90)

        frame_tree = tk.Frame(pad, bg=BORDER)
        frame_tree.pack(fill="both", expand=True)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Stock.Treeview", background=BG2, foreground=FG,
                        fieldbackground=BG2, rowheight=30, font=FONT_MED, borderwidth=0)
        style.configure("Stock.Treeview.Heading", background=BG3, foreground=ACCENT,
                        font=("Segoe UI", 9, "bold"), relief="flat", borderwidth=0)
        style.map("Stock.Treeview", background=[("selected", BG3)], foreground=[("selected", ACCENT)])

        self.stock_tree = ttk.Treeview(frame_tree, columns=cols, show="headings",
                                        style="Stock.Treeview", selectmode="browse")
        for col, label, width in zip(cols, col_labels, col_widths):
            self.stock_tree.heading(col, text=label)
            self.stock_tree.column(col, width=width,
                                   anchor="center" if col not in ("nombre","categoria") else "w")
        sb = ttk.Scrollbar(frame_tree, orient="vertical", command=self.stock_tree.yview)
        self.stock_tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.stock_tree.pack(fill="both", expand=True)
        self.stock_tree.tag_configure("ok",    foreground=GREEN)
        self.stock_tree.tag_configure("low",   foreground=YELLOW)
        self.stock_tree.tag_configure("empty", foreground=RED)
        self.stock_tree.bind("<Double-1>", self._edit_from_stock)
        self._refresh_stock_table()

    def _refresh_stock_table(self):
        if not hasattr(self, 'stock_tree'): return
        q = self.search_var.get().strip().lower() if hasattr(self,'search_var') else ""
        conn = get_db()
        rows = conn.execute("SELECT * FROM productos ORDER BY nombre").fetchall()
        conn.close()
        for item in self.stock_tree.get_children():
            self.stock_tree.delete(item)
        for row in rows:
            if q and q not in row["nombre"].lower() and q not in row["codigo"].lower():
                continue
            estado = "✓  OK" if row["stock"] > row["stock_min"] else ("⚠  Bajo" if row["stock"] > 0 else "✕  Sin stock")
            tag = "ok" if row["stock"] > row["stock_min"] else ("low" if row["stock"] > 0 else "empty")
            self.stock_tree.insert("", "end",
                values=(row["codigo"], row["nombre"], row["categoria"] or "—",
                        row["stock"], row["stock_min"],
                        f'${row["precio"]:,.0f}' if row["precio"] else "—", estado),
                tags=(tag,), iid=str(row["id"]))

    def _edit_from_stock(self, event):
        sel = self.stock_tree.selection()
        if not sel: return
        conn = get_db()
        prod = conn.execute("SELECT * FROM productos WHERE id=?", (sel[0],)).fetchone()
        conn.close()
        if prod:
            self._show_tab("productos")
            self.after(150, lambda: self._load_prod_in_form(dict(prod)))

    def _export_csv(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".csv", filetypes=[("CSV","*.csv")],
            initialfile=f"stock_{datetime.now().strftime('%Y%m%d_%H%M')}.csv")
        if not path: return
        conn = get_db()
        rows = conn.execute("SELECT codigo,nombre,categoria,stock,stock_min,precio FROM productos ORDER BY nombre").fetchall()
        conn.close()
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["Código","Nombre","Categoría","Stock","Stock Mínimo","Precio"])
            for r in rows: w.writerow(list(r))
        messagebox.showinfo("Exportado", f"Stock exportado a:\n{path}")

    # ── HISTORIAL TAB ────────────────────────────────────────────
    def _tab_historial(self):
        pad = tk.Frame(self.content, bg=BG)
        pad.pack(fill="both", expand=True, padx=28, pady=24)
        tk.Label(pad, text="⏱  Historial de Movimientos", font=FONT_TITLE, fg=FG, bg=BG).pack(anchor="w", pady=(0,16))

        filt = tk.Frame(pad, bg=BG)
        filt.pack(fill="x", pady=(0,12))
        self.hist_filter = tk.StringVar(value="todos")
        for val, label in [("todos","Todos"),("entrada","Entradas"),("salida","Salidas"),("ajuste","Ajustes")]:
            tk.Radiobutton(filt, text=label, variable=self.hist_filter, value=val,
                           font=("Segoe UI",10), fg=FG2, bg=BG, selectcolor=BG3,
                           activebackground=BG, cursor="hand2",
                           command=self._refresh_hist).pack(side="left", padx=(0,12))

        cols  = ("fecha","codigo","nombre","tipo","cantidad","stock_prev","stock_post","nota")
        heads = ("Fecha","Código","Producto","Tipo","Cant.","Antes","Después","Nota")
        wids  = (140,90,180,80,55,60,70,120)

        frame_tree = tk.Frame(pad, bg=BORDER)
        frame_tree.pack(fill="both", expand=True)

        style = ttk.Style()
        style.configure("Hist.Treeview", background=BG2, foreground=FG,
                        fieldbackground=BG2, rowheight=28, font=("Segoe UI",10), borderwidth=0)
        style.configure("Hist.Treeview.Heading", background=BG3, foreground=ACCENT,
                        font=("Segoe UI",9,"bold"), relief="flat")
        style.map("Hist.Treeview", background=[("selected",BG3)], foreground=[("selected",ACCENT)])

        self.hist_tree = ttk.Treeview(frame_tree, columns=cols, show="headings", style="Hist.Treeview")
        for col, head, w in zip(cols, heads, wids):
            self.hist_tree.heading(col, text=head)
            self.hist_tree.column(col, width=w, anchor="w" if col in ("nombre","nota") else "center")
        self.hist_tree.tag_configure("entrada", foreground=GREEN)
        self.hist_tree.tag_configure("salida",  foreground=RED)
        self.hist_tree.tag_configure("ajuste",  foreground=YELLOW)
        sb = ttk.Scrollbar(frame_tree, orient="vertical", command=self.hist_tree.yview)
        self.hist_tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.hist_tree.pack(fill="both", expand=True)
        self._refresh_hist()

    def _refresh_hist(self):
        if not hasattr(self, "hist_tree"): return
        filt = self.hist_filter.get() if hasattr(self,"hist_filter") else "todos"
        conn = get_db()
        if filt == "todos":
            rows = conn.execute("""
                SELECT m.fecha, m.codigo, COALESCE(p.nombre,'—'), m.tipo,
                       m.cantidad, m.stock_prev, m.stock_post, m.nota
                FROM movimientos m LEFT JOIN productos p ON m.codigo=p.codigo
                ORDER BY m.id DESC LIMIT 200""").fetchall()
        else:
            rows = conn.execute("""
                SELECT m.fecha, m.codigo, COALESCE(p.nombre,'—'), m.tipo,
                       m.cantidad, m.stock_prev, m.stock_post, m.nota
                FROM movimientos m LEFT JOIN productos p ON m.codigo=p.codigo
                WHERE m.tipo=? ORDER BY m.id DESC LIMIT 200""", (filt,)).fetchall()
        conn.close()
        for item in self.hist_tree.get_children():
            self.hist_tree.delete(item)
        for row in rows:
            self.hist_tree.insert("", "end",
                values=(row[0], row[1], row[2], row[3].upper(), row[4],
                        row[5] if row[5] is not None else "—",
                        row[6] if row[6] is not None else "—",
                        row[7] or ""),
                tags=(row[3],))

    # ── PRODUCTOS TAB ────────────────────────────────────────────
    def _tab_productos(self):
        pad = tk.Frame(self.content, bg=BG)
        pad.pack(fill="both", expand=True, padx=28, pady=24)
        tk.Label(pad, text="＋  Productos", font=FONT_TITLE, fg=FG, bg=BG).pack(anchor="w", pady=(0,16))

        paned = tk.Frame(pad, bg=BG)
        paned.pack(fill="both", expand=True)

        # Left form
        form_frame = tk.Frame(paned, bg=BG2, width=340)
        form_frame.pack(side="left", fill="y", padx=(0,16))
        form_frame.pack_propagate(False)

        tk.Label(form_frame, text="NUEVO / EDITAR PRODUCTO", font=("Segoe UI",10,"bold"),
                 fg=ACCENT, bg=BG2).pack(anchor="w", padx=16, pady=(16,12))

        self._prod_form_vars = {}
        self._prod_edit_id   = None

        fields = [
            ("codigo",    "Código de Barras *",      True),
            ("nombre",    "Nombre / Descripción *",  True),
            ("categoria", "Categoría",               False),
            ("precio",    "Precio Unitario ($)",      False),
            ("stock",     "Stock Inicial",            False),
            ("stock_min", "Stock Mínimo (alerta)",    False),
        ]
        for key, label, required in fields:
            tk.Label(form_frame, text=label,
                     font=("Segoe UI", 9, "bold" if required else "normal"),
                     fg=FG if required else FG2, bg=BG2).pack(anchor="w", padx=16, pady=(8,2))
            default = "0" if key == "stock" else ("5" if key == "stock_min" else "")
            var = tk.StringVar(value=default)
            e = tk.Entry(form_frame, textvariable=var, font=FONT_MED,
                         fg=FG, bg=BG3, insertbackground=FG, relief="flat", bd=0)
            e.pack(fill="x", padx=16, ipady=6)
            self._prod_form_vars[key] = var
            if key == "codigo":
                self.codigo_entry = e
            if key == "nombre":
                self.nombre_entry = e

        tk.Label(form_frame, text="* campos obligatorios", font=FONT_SMALL,
                 fg=FG2, bg=BG2).pack(anchor="w", padx=16, pady=(8,0))

        btn_f = tk.Frame(form_frame, bg=BG2)
        btn_f.pack(fill="x", padx=16, pady=16)

        def guardar():
            codigo = self._prod_form_vars["codigo"].get().strip()
            nombre = self._prod_form_vars["nombre"].get().strip()
            if not codigo or not nombre:
                messagebox.showerror("Error", "Código y Nombre son obligatorios.")
                return
            try:
                precio    = float(self._prod_form_vars["precio"].get() or 0)
                stock     = int(self._prod_form_vars["stock"].get() or 0)
                stock_min = int(self._prod_form_vars["stock_min"].get() or 5)
            except ValueError:
                messagebox.showerror("Error", "Precio y stock deben ser números.")
                return
            categoria = self._prod_form_vars["categoria"].get().strip()
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            try:
                conn = get_db()
                if self._prod_edit_id:
                    conn.execute(
                        "UPDATE productos SET codigo=?,nombre=?,categoria=?,precio=?,stock=?,stock_min=? WHERE id=?",
                        (codigo, nombre, categoria, precio, stock, stock_min, self._prod_edit_id))
                    msg = f"Producto actualizado:\n{nombre}"
                else:
                    conn.execute(
                        "INSERT INTO productos (codigo,nombre,categoria,precio,stock,stock_min,creado) VALUES (?,?,?,?,?,?,?)",
                        (codigo, nombre, categoria, precio, stock, stock_min, now))
                    msg = f"Producto guardado:\n{nombre}"
                conn.commit()
                conn.close()
            except sqlite3.IntegrityError:
                messagebox.showerror("Error", f"El código '{codigo}' ya existe.")
                return
            except Exception as e:
                messagebox.showerror("Error al guardar",
                    f"No se pudo guardar.\n\nDetalle: {e}\n\nRuta DB: {DB_FILE}")
                return

            messagebox.showinfo("✓  Guardado", msg)
            for k, v in self._prod_form_vars.items():
                v.set("0" if k == "stock" else ("5" if k == "stock_min" else ""))
            self._prod_edit_id = None
            save_btn.configure(text="＋  Guardar Producto")
            self._refresh_prod_list()
            self._refresh_alert_count()

        save_btn = tk.Button(btn_f, text="＋  Guardar Producto",
                             font=("Segoe UI",10,"bold"), fg=BG, bg=ACCENT,
                             relief="flat", bd=0, padx=14, pady=8, cursor="hand2",
                             command=guardar)
        save_btn.pack(fill="x")
        self._save_btn = save_btn

        def limpiar():
            for k, v in self._prod_form_vars.items():
                v.set("0" if k == "stock" else ("5" if k == "stock_min" else ""))
            self._prod_edit_id = None
            save_btn.configure(text="＋  Guardar Producto")

        tk.Button(btn_f, text="✕  Limpiar",
                  font=FONT_SMALL, fg=FG2, bg=BG3,
                  relief="flat", bd=0, padx=10, pady=6, cursor="hand2",
                  command=limpiar).pack(fill="x", pady=(6,0))

        # Right list
        list_frame = tk.Frame(paned, bg=BG)
        list_frame.pack(side="left", fill="both", expand=True)
        tk.Label(list_frame, text="CATÁLOGO  (doble clic para editar)",
                 font=("Segoe UI",9,"bold"), fg=ACCENT, bg=BG).pack(anchor="w", pady=(0,8))

        cols = ("codigo","nombre","categoria","stock","precio")
        heads= ("Código","Nombre","Categoría","Stock","Precio")
        wids = (110,230,110,70,90)

        style = ttk.Style()
        style.configure("Prod.Treeview", background=BG2, foreground=FG,
                        fieldbackground=BG2, rowheight=28, font=FONT_MED, borderwidth=0)
        style.configure("Prod.Treeview.Heading", background=BG3, foreground=ACCENT,
                        font=("Segoe UI",9,"bold"), relief="flat")
        style.map("Prod.Treeview", background=[("selected",BG3)], foreground=[("selected",ACCENT)])

        self.prod_tree = ttk.Treeview(list_frame, columns=cols, show="headings", style="Prod.Treeview")
        for col, head, w in zip(cols, heads, wids):
            self.prod_tree.heading(col, text=head)
            self.prod_tree.column(col, width=w, anchor="w" if col=="nombre" else "center")

        sb2 = ttk.Scrollbar(list_frame, orient="vertical", command=self.prod_tree.yview)
        self.prod_tree.configure(yscrollcommand=sb2.set)
        sb2.pack(side="right", fill="y")
        self.prod_tree.pack(fill="both", expand=True)

        def on_edit(event):
            sel = self.prod_tree.selection()
            if not sel: return
            conn = get_db()
            prod = conn.execute("SELECT * FROM productos WHERE id=?", (sel[0],)).fetchone()
            conn.close()
            if prod:
                self._prod_edit_id = prod["id"]
                self._prod_form_vars["codigo"].set(prod["codigo"])
                self._prod_form_vars["nombre"].set(prod["nombre"])
                self._prod_form_vars["categoria"].set(prod["categoria"] or "")
                self._prod_form_vars["precio"].set(str(prod["precio"]))
                self._prod_form_vars["stock"].set(str(prod["stock"]))
                self._prod_form_vars["stock_min"].set(str(prod["stock_min"]))
                save_btn.configure(text="✎  Actualizar Producto")

        self.prod_tree.bind("<Double-1>", on_edit)

        ctx = tk.Menu(self.prod_tree, tearoff=0, bg=BG3, fg=FG,
                      activebackground=RED, activeforeground=FG)
        def delete_prod():
            sel = self.prod_tree.selection()
            if not sel: return
            conn = get_db()
            prod = conn.execute("SELECT nombre FROM productos WHERE id=?", (sel[0],)).fetchone()
            if prod and messagebox.askyesno("Eliminar", f"¿Eliminar '{prod['nombre']}'?"):
                conn.execute("DELETE FROM productos WHERE id=?", (sel[0],))
                conn.commit()
            conn.close()
            self._refresh_prod_list()
        ctx.add_command(label="  ✕  Eliminar producto", command=delete_prod)
        self.prod_tree.bind("<Button-3>", lambda e: ctx.post(e.x_root, e.y_root))

        self._refresh_prod_list()

    def _refresh_prod_list(self):
        if not hasattr(self,'prod_tree'): return
        conn = get_db()
        rows = conn.execute("SELECT * FROM productos ORDER BY nombre").fetchall()
        conn.close()
        for item in self.prod_tree.get_children():
            self.prod_tree.delete(item)
        for row in rows:
            self.prod_tree.insert("","end",
                values=(row["codigo"], row["nombre"], row["categoria"] or "—",
                        row["stock"], f'${row["precio"]:,.0f}' if row["precio"] else "—"),
                iid=str(row["id"]))

    def _load_prod_in_form(self, prod):
        if not hasattr(self, '_prod_form_vars'): return
        self._prod_edit_id = prod["id"]
        self._prod_form_vars["codigo"].set(prod["codigo"])
        self._prod_form_vars["nombre"].set(prod["nombre"])
        self._prod_form_vars["categoria"].set(prod["categoria"] or "")
        self._prod_form_vars["precio"].set(str(prod["precio"]))
        self._prod_form_vars["stock"].set(str(prod["stock"]))
        self._prod_form_vars["stock_min"].set(str(prod["stock_min"]))
        if hasattr(self, '_save_btn'):
            self._save_btn.configure(text="✎  Actualizar Producto")

    # ── ALERTAS TAB ──────────────────────────────────────────────
    def _tab_alertas(self):
        pad = tk.Frame(self.content, bg=BG)
        pad.pack(fill="both", expand=True, padx=28, pady=24)
        conn = get_db()
        alertas = conn.execute("SELECT * FROM productos WHERE stock <= stock_min ORDER BY stock ASC").fetchall()
        conn.close()
        tk.Label(pad, text="⚠  Alertas de Stock", font=FONT_TITLE, fg=FG, bg=BG).pack(anchor="w")
        tk.Label(pad, text=f"{len(alertas)} producto{'s' if len(alertas)!=1 else ''} con stock en o bajo el mínimo",
                 font=FONT_MED, fg=FG2, bg=BG).pack(anchor="w", pady=(4,20))

        if not alertas:
            tk.Label(pad, text="✓  Todo el stock está por encima del mínimo.",
                     font=FONT_BIG, fg=GREEN, bg=BG).pack(pady=40)
            return

        canvas = tk.Canvas(pad, bg=BG, highlightthickness=0)
        scroll = ttk.Scrollbar(pad, orient="vertical", command=canvas.yview)
        sf = tk.Frame(canvas, bg=BG)
        sf.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0,0), window=sf, anchor="nw")
        canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)

        for prod in alertas:
            color = RED if prod["stock"] == 0 else YELLOW
            icon  = "✕" if prod["stock"] == 0 else "⚠"
            card = tk.Frame(sf, bg=BG2)
            card.pack(fill="x", pady=4)
            tk.Label(card, text=icon, font=("Segoe UI",20), fg=color, bg=BG2,
                     width=3).pack(side="left", padx=12, pady=12)
            info = tk.Frame(card, bg=BG2)
            info.pack(side="left", fill="both", expand=True, pady=12)
            tk.Label(info, text=prod["nombre"], font=("Segoe UI",12,"bold"), fg=FG, bg=BG2).pack(anchor="w")
            tk.Label(info, text=f"Código: {prod['codigo']}  ·  {prod['categoria'] or '—'}",
                     font=FONT_SMALL, fg=FG2, bg=BG2).pack(anchor="w")
            nums = tk.Frame(card, bg=BG2)
            nums.pack(side="right", padx=20, pady=12)
            for label, val, col in [("STOCK", prod["stock"], color), ("MÍNIMO", prod["stock_min"], FG2)]:
                f2 = tk.Frame(nums, bg=BG2)
                f2.pack(side="left", padx=8)
                tk.Label(f2, text=label, font=("Segoe UI",8,"bold"), fg=FG2, bg=BG2).pack()
                tk.Label(f2, text=str(val), font=("Segoe UI",22,"bold"), fg=col, bg=BG2).pack()

    def _refresh_alert_count(self):
        try:
            conn = get_db()
            count = conn.execute("SELECT COUNT(*) FROM productos WHERE stock <= stock_min").fetchone()[0]
            conn.close()
            if "alertas" in self.nav_buttons:
                frame, lbl = self.nav_buttons["alertas"]
                lbl.configure(text=f"⚠  Alertas  ({count})" if count > 0 else "⚠  Alertas")
        except Exception:
            pass

    def _on_key(self, event):
        if self.current_tab.get() == "scanner" and hasattr(self, "scan_entry"):
            if event.char and event.char.isprintable():
                self.scan_entry.focus_set()

    def _on_scan_enter(self, event):
        if self.current_tab.get() == "scanner" and hasattr(self, "scan_entry"):
            self._process_scan(event)

# ─── HELPERS ─────────────────────────────────────────────────────
def _show_placeholder(frame, text, color):
    tk.Label(frame, text=text, font=("Segoe UI",13),
             fg=color, bg=frame.cget("bg")).pack(pady=40)

# ─── ENTRY POINT ─────────────────────────────────────────────────
if __name__ == "__main__":
    # Verificar permisos de escritura antes de abrir la UI
    ok, err = _check_write_permission()
    if not ok:
        _show_startup_error(err)
        sys.exit(1)

    app = StockScannerApp()
    app._refresh_alert_count()
    app.mainloop()
