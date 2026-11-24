-- ============================================================
-- StockScanner — v4: Leo puede editar cualquier pedido + HISTORIAL de cambios
-- Ejecutar completo en: Supabase Dashboard → SQL Editor → New query → Run
-- (requiere haber corrido antes pedidos.sql, pedidos_v2.sql y v3_marcelo_obra_ocultos.sql)
--
-- No borra datos. Se puede ejecutar más de una vez sin problema.
--
--   · Leo ahora edita cualquier pedido (obra, proveedor, ítems…), en cualquier estado.
--     Sigue sin poder borrar pedidos (eso es solo Admin y Sergio).
--   · Marcelo sigue editando solo los pedidos "Pendiente".
--   · Cada cambio en un pedido queda registrado en public.pedidos_historial:
--     quién, cuándo y qué cambió (valor anterior → valor nuevo).
--     Lo escribe la base sola (triggers): no se puede saltear ni borrar desde la web.
-- ============================================================

-- ── 1. Quién tiene la edición restringida (solo "Pendiente") ──────────────
create or replace function public.pedidos_edicion_restringida()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'marcelo@stockscanner.local';
$$;

create or replace function public.pedidos_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.fecha := old.fecha;
  if public.pedidos_edicion_restringida() and old.estado <> 'Pendiente' and (
       new.categoria is distinct from old.categoria or
       new.proveedor is distinct from old.proveedor or
       new.urgencia  is distinct from old.urgencia  or
       new.obs       is distinct from old.obs       or
       new.obra      is distinct from old.obra      or
       new.origen    is distinct from old.origen    or
       new.usuario   is distinct from old.usuario
     ) then
    raise exception 'Solo Admin, Sergio o Leo pueden editar un pedido que ya figura como "%"', old.estado;
  end if;
  return new;
end $$;

create or replace function public.pedido_items_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  est text;
begin
  if not public.pedidos_edicion_restringida() then
    return coalesce(new, old);
  end if;
  select estado into est from public.pedidos
   where id = (case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end);
  if est is null or est = 'Pendiente' then
    return coalesce(new, old);
  end if;
  -- en pedidos ya pedidos, Marcelo solo puede registrar lo que llegó
  if tg_op = 'UPDATE' and
     (new.pedido_id, new.codigo, new.descripcion, new.marca, new.color, new.medida, new.cantidad, new.unidad)
     is not distinct from
     (old.pedido_id, old.codigo, old.descripcion, old.marca, old.color, old.medida, old.cantidad, old.unidad) then
    return new;
  end if;
  raise exception 'Solo Admin, Sergio o Leo pueden editar los ítems de un pedido que ya figura como "%"', est;
end $$;

-- ── 2. Tabla del historial ────────────────────────────────────────────────
-- Sin foreign key a pedidos a propósito: si se borra un pedido, su historial queda.
create table if not exists public.pedidos_historial (
    id         bigint generated always as identity primary key,
    pedido_id  bigint not null,
    fecha      timestamptz not null default now(),
    usuario    text not null default '',
    accion     text not null,          -- Creó | Editó | Estado | Agregó ítem | Quitó ítem | Editó ítem | Borró
    detalle    text not null default ''
);
create index if not exists idx_pedidos_historial_pedido on public.pedidos_historial (pedido_id);
create index if not exists idx_pedidos_historial_fecha  on public.pedidos_historial (fecha desc);

alter table public.pedidos_historial enable row level security;
-- Todos los logueados lo pueden LEER. Nadie lo puede escribir/editar/borrar desde la web:
-- solo lo escriben los triggers de abajo (security definer).
drop policy if exists "auth select pedidos_historial" on public.pedidos_historial;
create policy "auth select pedidos_historial" on public.pedidos_historial
    for select using (auth.role() = 'authenticated');

-- ── 3. Helpers ────────────────────────────────────────────────────────────
create or replace function public.pedidos_usuario_actual()
returns text language sql stable set search_path = '' as $$
  select case coalesce(auth.jwt() ->> 'email', '')
    when 'admin@stockscanner.local'   then 'Admin'
    when 'sergio@stockscanner.local'  then 'Sergio'
    when 'leo@stockscanner.local'     then 'Leo'
    when 'marcelo@stockscanner.local' then 'Marcelo'
    when ''                           then 'Sistema'
    else auth.jwt() ->> 'email'
  end;
$$;

-- "campo: antes → después" (o '' si no cambió)
create or replace function public.pedidos_hist_diff(campo text, antes text, despues text)
returns text language sql stable set search_path = '' as $$
  select case when coalesce(antes, '') is distinct from coalesce(despues, '')
    then format('%s: "%s" → "%s"', campo, coalesce(antes, ''), coalesce(despues, ''))
    else null end;
$$;

create or replace function public.pedidos_hist_item(i public.pedido_items)
returns text language sql stable set search_path = '' as $$
  select concat_ws(' ', i.descripcion, nullif(i.marca, ''), nullif(i.color, ''), nullif(i.medida, ''))
         || format(' (%s %s)', (case when i.cantidad = trunc(i.cantidad) then trunc(i.cantidad)::text else i.cantidad::text end), i.unidad);
$$;

-- ── 4. Trigger de pedidos (cabecera) ──────────────────────────────────────
create or replace function public.pedidos_hist_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cambios text;
begin
  if tg_op = 'INSERT' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (new.id, public.pedidos_usuario_actual(), 'Creó',
            concat_ws(' · ', nullif('Obra: ' || nullif(new.obra, ''), ''), nullif('Proveedor: ' || nullif(new.proveedor, ''), '')));
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
    public.pedidos_hist_diff('Obra',          old.obra,      new.obra),
    public.pedidos_hist_diff('Proveedor',     old.proveedor, new.proveedor),
    public.pedidos_hist_diff('Categoría',     old.categoria, new.categoria),
    public.pedidos_hist_diff('Urgencia',      old.urgencia,  new.urgencia),
    public.pedidos_hist_diff('Observaciones', old.obs,       new.obs)
  );
  if cambios <> '' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (new.id, public.pedidos_usuario_actual(), 'Editó', cambios);
  end if;
  return new;
end $$;

drop trigger if exists trg_pedidos_hist on public.pedidos;
create trigger trg_pedidos_hist after insert or update or delete on public.pedidos
    for each row execute function public.pedidos_hist_trg();

-- ── 5. Trigger de ítems ───────────────────────────────────────────────────
create or replace function public.pedido_items_hist_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ped     public.pedidos;
  cambios text;
begin
  select * into ped from public.pedidos
   where id = (case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end);
  -- el pedido se está borrando entero (cascade): ya quedó registrado "Borró"
  if ped.id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    -- los ítems que se cargan al crear el pedido ya los cubre "Creó"
    if ped.fecha > now() - interval '1 minute' then
      return new;
    end if;
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (ped.id, public.pedidos_usuario_actual(), 'Agregó ítem', public.pedidos_hist_item(new));
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (ped.id, public.pedidos_usuario_actual(), 'Quitó ítem', public.pedidos_hist_item(old));
    return old;
  end if;

  -- UPDATE: lo recibido (cantidad_recibida) no se registra acá; ya queda en movimientos de stock
  cambios := concat_ws(E'\n',
    public.pedidos_hist_diff('Descripción', old.descripcion,     new.descripcion),
    public.pedidos_hist_diff('Marca',       old.marca,           new.marca),
    public.pedidos_hist_diff('Color',       old.color,           new.color),
    public.pedidos_hist_diff('Medida',      old.medida,          new.medida),
    case when old.cantidad is distinct from new.cantidad
         then format('Cantidad: %s → %s', old.cantidad, new.cantidad) end,
    public.pedidos_hist_diff('Unidad',      old.unidad,          new.unidad),
    public.pedidos_hist_diff('Código',      old.codigo,          new.codigo)
  );
  if cambios <> '' then
    insert into public.pedidos_historial (pedido_id, usuario, accion, detalle)
    values (ped.id, public.pedidos_usuario_actual(), 'Editó ítem', old.descripcion || E'\n' || cambios);
  end if;
  return new;
end $$;

drop trigger if exists trg_pedido_items_hist on public.pedido_items;
create trigger trg_pedido_items_hist after insert or update or delete on public.pedido_items
    for each row execute function public.pedido_items_hist_trg();

-- Verificación: últimos cambios registrados
-- select * from public.pedidos_historial order by fecha desc limit 20;
