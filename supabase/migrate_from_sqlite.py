"""
Migracion unica: stockscanner.db (SQLite local) -> Supabase (Postgres).

Uso:
    1. Correr supabase/schema.sql en el SQL Editor de Supabase primero.
    2. Setear estas dos variables de entorno (NUNCA pegar la service_role
       key en un chat o commitearla):
           SUPABASE_URL              https://xxxx.supabase.co
           SUPABASE_SERVICE_ROLE_KEY la "service_role" (no la "anon") key
    3. python supabase/migrate_from_sqlite.py

Solo usa la libreria estandar de Python (sqlite3 + urllib) para no depender
de wheels de psycopg2/requests que pueden no existir para la version de
Python instalada.
"""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

DB_FILE = Path(__file__).resolve().parent.parent / "stockscanner.db"


def _env(name):
    val = os.environ.get(name, "").strip()
    if not val:
        print(f"ERROR: falta la variable de entorno {name}", file=sys.stderr)
        sys.exit(1)
    return val


def _post(base_url, service_key, table, rows):
    if not rows:
        return []
    url = f"{base_url.rstrip('/')}/rest/v1/{table}"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("apikey", service_key)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        print(f"ERROR insertando en '{table}': HTTP {e.code}\n{detail}", file=sys.stderr)
        sys.exit(1)


def _get_count(base_url, service_key, table):
    url = f"{base_url.rstrip('/')}/rest/v1/{table}?select=id"
    req = urllib.request.Request(url, method="GET")
    req.add_header("apikey", service_key)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("Prefer", "count=exact")
    with urllib.request.urlopen(req) as resp:
        return len(json.loads(resp.read().decode("utf-8")))


def main():
    base_url = _env("SUPABASE_URL")
    service_key = _env("SUPABASE_SERVICE_ROLE_KEY")

    if not DB_FILE.exists():
        print(f"ERROR: no se encontro {DB_FILE}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row

    productos = [dict(r) for r in conn.execute("SELECT * FROM productos ORDER BY id")]
    movimientos = [dict(r) for r in conn.execute("SELECT * FROM movimientos ORDER BY id")]
    conn.close()

    # No migramos el "id" original: Postgres genera sus propios ids.
    # movimientos.usuario no existia en SQLite -> queda vacio para el
    # historial pre-migracion (columna nueva agregada en schema.sql).
    productos_rows = [
        {k: v for k, v in p.items() if k != "id"} for p in productos
    ]
    movimientos_rows = [
        {**{k: v for k, v in m.items() if k != "id"}, "usuario": ""}
        for m in movimientos
    ]

    print(f"Migrando {len(productos_rows)} productos y {len(movimientos_rows)} movimientos...")

    _post(base_url, service_key, "productos", productos_rows)
    _post(base_url, service_key, "movimientos", movimientos_rows)

    count_p = _get_count(base_url, service_key, "productos")
    count_m = _get_count(base_url, service_key, "movimientos")

    print(f"Verificacion: Supabase tiene ahora {count_p} productos y {count_m} movimientos.")
    if count_p != len(productos_rows) or count_m != len(movimientos_rows):
        print(
            "ADVERTENCIA: el conteo en Supabase no coincide exactamente con "
            "SQLite (puede ser normal si ya habia datos previos en Supabase; "
            "revisar a mano si es inesperado).",
            file=sys.stderr,
        )
    else:
        print("OK: los conteos coinciden con stockscanner.db.")


if __name__ == "__main__":
    main()
