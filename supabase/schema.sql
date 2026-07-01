-- ============================================================
-- StockScanner — Esquema Supabase (Postgres)
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create table if not exists productos (
    id         bigint generated always as identity primary key,
    codigo     text unique not null,
    nombre     text not null,
    categoria  text default '',
    precio     numeric(12,2) default 0,
    stock      integer default 0,
    stock_min  integer default 5,
    creado     timestamp default now()
);

create table if not exists movimientos (
    id          bigint generated always as identity primary key,
    codigo      text not null,
    tipo        text not null check (tipo in ('entrada', 'salida', 'ajuste')),
    cantidad    integer not null,
    stock_prev  integer,
    stock_post  integer,
    nota        text default '',
    usuario     text default '',
    fecha       timestamp default now()
);

create index if not exists idx_movimientos_codigo on movimientos (codigo);
create index if not exists idx_productos_nombre_lower on productos (lower(nombre));

-- ── Row Level Security ──────────────────────────────────────
-- Solo usuarios autenticados (los 3 creados a mano en el dashboard)
-- pueden leer/escribir. La signup pública DEBE estar desactivada
-- (Authentication → Providers → Email → "Allow new users to sign up" = OFF)
-- para que "autenticado" siga significando "uno de los 3 usuarios reales".

alter table productos   enable row level security;
alter table movimientos enable row level security;

create policy "auth select productos" on productos
    for select using (auth.role() = 'authenticated');
create policy "auth insert productos" on productos
    for insert with check (auth.role() = 'authenticated');
create policy "auth update productos" on productos
    for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "auth delete productos" on productos
    for delete using (auth.role() = 'authenticated');

-- movimientos es un log de auditoría: solo se lee y se agrega, nunca se
-- edita ni se borra (a propósito, no hay policy de update/delete).
create policy "auth select movimientos" on movimientos
    for select using (auth.role() = 'authenticated');
create policy "auth insert movimientos" on movimientos
    for insert with check (auth.role() = 'authenticated');

-- ── Realtime ─────────────────────────────────────────────────
-- replica identity full: necesario para que los eventos UPDATE/DELETE
-- de Realtime incluyan la fila completa "antes" del cambio.
alter table productos   replica identity full;
alter table movimientos replica identity full;

-- Agrega las tablas a la publicación de Realtime (equivalente a activar
-- el toggle "Realtime" en Table Editor para cada tabla).
alter publication supabase_realtime add table productos, movimientos;
