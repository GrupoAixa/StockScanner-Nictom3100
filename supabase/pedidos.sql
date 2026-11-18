-- ============================================================
-- StockScanner — Módulo de PEDIDOS (unificado con Aixa Pedidos)
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query → Run
--
-- 100% ADITIVO: no borra ni modifica ningún producto ni movimiento.
-- Solo agrega columnas opcionales a `productos` (con valores por defecto)
-- y crea las tablas nuevas `pedidos` y `pedido_items`.
-- Se puede ejecutar más de una vez sin problema.
-- ============================================================

-- ── 1. Datos extra de cada insumo (para autocompletar los pedidos) ──
alter table productos add column if not exists marca           text    default '';
alter table productos add column if not exists color           text    default '';
alter table productos add column if not exists medida          text    default '';
alter table productos add column if not exists proveedor       text    default '';
alter table productos add column if not exists unidad          text    default 'Unidades';
-- Cantidad que se pide habitualmente cuando se llega al mínimo (0 = calcular sola)
alter table productos add column if not exists cant_reposicion integer default 0;

-- ── 2. Pedidos (cabecera) ─────────────────────────────────────────
create table if not exists pedidos (
    id             bigint generated always as identity primary key,
    origen         text not null default 'manual' check (origen in ('alerta', 'manual')),
    estado         text not null default 'Pedido' check (estado in ('Pedido', 'Recibido', 'Cancelado')),
    categoria      text default '',
    proveedor      text default '',
    urgencia       text default 'Normal',
    obs            text default '',
    usuario        text default '',
    email_estado   text default 'pendiente',   -- pendiente | enviado | error | manual
    email_detalle  text default '',
    fecha          timestamptz default now(),
    fecha_recibido timestamptz,
    recibido_por   text default ''
);

-- ── 3. Ítems de cada pedido ───────────────────────────────────────
create table if not exists pedido_items (
    id                bigint generated always as identity primary key,
    pedido_id         bigint not null references pedidos(id) on delete cascade,
    codigo            text default '',          -- vacío = insumo nuevo (no está en stock)
    descripcion       text not null,
    marca             text default '',
    color             text default '',
    medida            text default '',
    cantidad          numeric not null check (cantidad > 0),
    unidad            text default 'Unidades',
    stock_al_pedir    integer,
    cantidad_recibida numeric
);

create index if not exists idx_pedido_items_pedido on pedido_items (pedido_id);
create index if not exists idx_pedido_items_codigo on pedido_items (lower(codigo));
create index if not exists idx_pedidos_estado      on pedidos (estado);

-- ── 4. Seguridad: solo los usuarios logueados (Admin, Sergio, Leo) ──
alter table pedidos      enable row level security;
alter table pedido_items enable row level security;

drop policy if exists "auth select pedidos" on pedidos;
drop policy if exists "auth insert pedidos" on pedidos;
drop policy if exists "auth update pedidos" on pedidos;
create policy "auth select pedidos" on pedidos for select using (auth.role() = 'authenticated');
create policy "auth insert pedidos" on pedidos for insert with check (auth.role() = 'authenticated');
create policy "auth update pedidos" on pedidos for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
-- Sin policy de delete a propósito: los pedidos se CANCELAN, no se borran (quedan de historial).

drop policy if exists "auth select pedido_items" on pedido_items;
drop policy if exists "auth insert pedido_items" on pedido_items;
drop policy if exists "auth update pedido_items" on pedido_items;
create policy "auth select pedido_items" on pedido_items for select using (auth.role() = 'authenticated');
create policy "auth insert pedido_items" on pedido_items for insert with check (auth.role() = 'authenticated');
create policy "auth update pedido_items" on pedido_items for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ── 5. Realtime (que los 3 vean los pedidos al instante) ─────────
alter table pedidos      replica identity full;
alter table pedido_items replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table pedidos;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table pedido_items; exception when duplicate_object then null; end;
end $$;

-- Verificación (debería dar el mismo número de productos que antes):
-- select count(*) from productos;
