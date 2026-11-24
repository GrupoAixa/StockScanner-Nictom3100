-- ============================================================
-- StockScanner — v3: usuario Marcelo, OBRA en pedidos, productos OCULTOS
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query → Run
-- (requiere haber corrido antes supabase/pedidos.sql y supabase/pedidos_v2.sql)
--
-- No borra datos. Se puede ejecutar más de una vez sin problema.
-- ============================================================

-- ── 1. Obra a la que va cada pedido (ej: "Cocina Pérez") ──────────────────
alter table public.pedidos add column if not exists obra text default '';

-- ── 2. Productos ocultos: no salen en las alertas para pedir ──────────────
alter table public.productos add column if not exists oculto boolean not null default false;

-- ── 3. Marcelo tiene los mismos permisos que Leo ─────────────────────────
--   (puede crear pedidos, marcarlos como pedidos, recibirlos, y editar solo
--    los que están "Pendiente"; no puede borrar pedidos)
create or replace function public.pedidos_es_leo()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('leo@stockscanner.local', 'marcelo@stockscanner.local');
$$;

-- ── 4. Reglas de edición: ahora también cubren la obra ────────────────────
create or replace function public.pedidos_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.fecha := old.fecha;
  if public.pedidos_es_leo() and old.estado <> 'Pendiente' and (
       new.categoria is distinct from old.categoria or
       new.proveedor is distinct from old.proveedor or
       new.urgencia  is distinct from old.urgencia  or
       new.obs       is distinct from old.obs       or
       new.obra      is distinct from old.obra      or
       new.origen    is distinct from old.origen    or
       new.usuario   is distinct from old.usuario
     ) then
    raise exception 'Solo Admin o Sergio pueden editar un pedido que ya figura como "%"', old.estado;
  end if;
  return new;
end $$;

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
  -- en pedidos ya pedidos, Leo/Marcelo solo pueden registrar lo que llegó
  if tg_op = 'UPDATE' and
     (new.pedido_id, new.codigo, new.descripcion, new.marca, new.color, new.medida, new.cantidad, new.unidad)
     is not distinct from
     (old.pedido_id, old.codigo, old.descripcion, old.marca, old.color, old.medida, old.cantidad, old.unidad) then
    return new;
  end if;
  raise exception 'Solo Admin o Sergio pueden editar los ítems de un pedido que ya figura como "%"', est;
end $$;
