-- ============================================================
-- StockScanner — v5: N° de ORDEN DE TRABAJO en los pedidos
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query → Run
-- (requiere haber corrido antes v3_marcelo_obra_ocultos.sql y v4_leo_edita_historial_pedidos.sql)
--
-- No borra datos. Se puede ejecutar más de una vez sin problema.
--
--   · Nueva columna pedidos.orden_trabajo (texto, opcional), junto a la obra,
--     para que no queden dudas de a qué obra se refiere el pedido.
--   · Las reglas de edición y el historial de cambios ahora la incluyen.
-- ============================================================

-- ── 1. Columna ────────────────────────────────────────────────────────────
alter table public.pedidos add column if not exists orden_trabajo text default '';

-- ── 2. Reglas de edición: también cubren la orden de trabajo ──────────────
create or replace function public.pedidos_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.fecha := old.fecha;
  if public.pedidos_edicion_restringida() and old.estado <> 'Pendiente' and (
       new.categoria     is distinct from old.categoria     or
       new.proveedor     is distinct from old.proveedor     or
       new.urgencia      is distinct from old.urgencia      or
       new.obs           is distinct from old.obs           or
       new.obra          is distinct from old.obra          or
       new.orden_trabajo is distinct from old.orden_trabajo or
       new.origen        is distinct from old.origen        or
       new.usuario       is distinct from old.usuario
     ) then
    raise exception 'Solo Admin, Sergio o Leo pueden editar un pedido que ya figura como "%"', old.estado;
  end if;
  return new;
end $$;

-- ── 3. Historial: registrar la orden de trabajo ───────────────────────────
create or replace function public.pedidos_hist_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cambios text;
begin
  if tg_op = 'INSERT' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (new.id, public.pedidos_usuario_actual(), 'Creó',
            concat_ws(' · ',
              nullif('Obra: ' || nullif(new.obra, ''), ''),
              nullif('OT: ' || nullif(new.orden_trabajo, ''), ''),
              nullif('Proveedor: ' || nullif(new.proveedor, ''), '')));
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (old.id, public.pedidos_usuario_actual(), 'Borró',
            format('Pedido de %s, estado "%s"', old.usuario, old.estado));
    return old;
  end if;

  -- UPDATE
  if new.estado is distinct from old.estado then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (new.id, public.pedidos_usuario_actual(), 'Estado',
            format('"%s" → "%s"', old.estado, new.estado));
  end if;

  cambios := concat_ws(E'\n',
    public.pedidos_hist_diff('Obra',             old.obra,          new.obra),
    public.pedidos_hist_diff('Orden de trabajo', old.orden_trabajo, new.orden_trabajo),
    public.pedidos_hist_diff('Proveedor',        old.proveedor,     new.proveedor),
    public.pedidos_hist_diff('Categoría',        old.categoria,     new.categoria),
    public.pedidos_hist_diff('Urgencia',         old.urgencia,      new.urgencia),
    public.pedidos_hist_diff('Observaciones',    old.obs,           new.obs)
  );
  if cambios <> '' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (new.id, public.pedidos_usuario_actual(), 'Editó', cambios);
  end if;
  return new;
end $$;

-- Verificación:
-- select id, obra, orden_trabajo from public.pedidos order by id desc limit 10;
