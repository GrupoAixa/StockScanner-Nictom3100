-- ============================================================
-- StockScanner — Pedidos v2: estado "Pendiente", borrar y editar con permisos
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query → Run
-- (requiere haber corrido antes supabase/pedidos.sql)
--
-- No borra datos. Los pedidos existentes conservan su estado actual.
-- Se puede ejecutar más de una vez sin problema.
-- ============================================================

-- ── 1. Nuevo flujo de estados: Pendiente → Pedido → Recibido (o Cancelado) ──
--   Pendiente = se cargó la orden, todavía no se le pidió al proveedor
--   Pedido    = ya se le pidió al proveedor (alguien lo marcó)
--   Recibido  = llegó (pasa al apartado "Recibidos")
alter table public.pedidos drop constraint if exists pedidos_estado_check;
alter table public.pedidos add constraint pedidos_estado_check
    check (estado in ('Pendiente', 'Pedido', 'Recibido', 'Cancelado'));
alter table public.pedidos alter column estado set default 'Pendiente';

alter table public.pedidos add column if not exists fecha_pedido_prov timestamptz;   -- cuándo se le pidió al proveedor
alter table public.pedidos add column if not exists pedido_por        text default '';
alter table public.pedidos add column if not exists editado_por       text default '';
alter table public.pedidos add column if not exists fecha_editado     timestamptz;

-- ── 2. Quién es quién (según el usuario logueado) ─────────────────────────
create or replace function public.pedidos_es_admin()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('admin@stockscanner.local', 'sergio@stockscanner.local');
$$;

create or replace function public.pedidos_es_leo()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'leo@stockscanner.local';
$$;

-- ── 3. Borrar pedidos: solo Admin y Sergio ─────────────────────────────────
drop policy if exists "admin delete pedidos" on public.pedidos;
create policy "admin delete pedidos" on public.pedidos
    for delete using (public.pedidos_es_admin());

-- Ítems: se pueden quitar al editar un pedido (las reglas de Leo las aplica el trigger de abajo).
-- Al borrar un pedido, sus ítems se borran solos (on delete cascade).
drop policy if exists "auth delete pedido_items" on public.pedido_items;
create policy "auth delete pedido_items" on public.pedido_items
    for delete using (auth.role() = 'authenticated');

-- ── 4. Reglas de edición (se aplican en la base, no solo en la web) ───────
--   · Nadie puede cambiar la fecha del pedido.
--   · Leo no puede editar el contenido de un pedido que ya no está "Pendiente"
--     (sí puede marcarlo como pedido, recibirlo, cancelarlo o reabrirlo).
create or replace function public.pedidos_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.fecha := old.fecha;
  if public.pedidos_es_leo() and old.estado <> 'Pendiente' and (
       new.categoria is distinct from old.categoria or
       new.proveedor is distinct from old.proveedor or
       new.urgencia  is distinct from old.urgencia  or
       new.obs       is distinct from old.obs       or
       new.origen    is distinct from old.origen    or
       new.usuario   is distinct from old.usuario
     ) then
    raise exception 'Leo no puede editar un pedido que ya figura como "%"', old.estado;
  end if;
  return new;
end $$;

drop trigger if exists trg_pedidos_guard on public.pedidos;
create trigger trg_pedidos_guard before update on public.pedidos
    for each row execute function public.pedidos_guard();

create or replace function public.pedido_items_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  est text;
begin
  if not public.pedidos_es_leo() then
    return coalesce(new, old);
  end if;
  select estado into est from public.pedidos
   where id = (case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end);
  if est is null or est = 'Pendiente' then
    return coalesce(new, old);
  end if;
  -- en pedidos ya pedidos, Leo solo puede registrar lo que llegó
  if tg_op = 'UPDATE' and
     (new.pedido_id, new.codigo, new.descripcion, new.marca, new.color, new.medida, new.cantidad, new.unidad)
     is not distinct from
     (old.pedido_id, old.codigo, old.descripcion, old.marca, old.color, old.medida, old.cantidad, old.unidad) then
    return new;
  end if;
  raise exception 'Leo no puede editar los ítems de un pedido que ya figura como "%"', est;
end $$;

drop trigger if exists trg_pedido_items_guard on public.pedido_items;
create trigger trg_pedido_items_guard before insert or update or delete on public.pedido_items
    for each row execute function public.pedido_items_guard();
