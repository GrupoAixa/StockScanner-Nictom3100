// Edge Function: enviar-pedido
// Envía por mail una orden de pedido a Sergio y Leo.
//
// La web la llama con el pedido_id recién creado. La función lee el pedido
// con el JWT del usuario logueado (respeta RLS: solo Admin/Sergio/Leo), arma
// el mail y lo manda. Los destinatarios están fijos acá, del lado servidor,
// para que nadie pueda usar la función para mandar mails a otras direcciones.
//
// Proveedor de correo (configurar UNO en Edge Functions → Secrets):
//   A) Resend:  RESEND_API_KEY  (+ MAIL_FROM, ej "Pedidos Aixa <pedidos@grupoaixa.com.ar>",
//               con el dominio grupoaixa.com.ar verificado en resend.com)
//   B) Gmail:   GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google)
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const DESTINATARIOS = ["sergio@grupoaixa.com.ar", "leo@grupoaixa.com.ar"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function armarMail(ped: any) {
  const items: any[] = ped.pedido_items || [];
  const fecha = new Date(ped.fecha).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  const urgente = ped.urgencia === "Urgente";
  const subject =
    `${urgente ? "[URGENTE] " : ""}Pedido #${ped.id} — ` +
    (items.length === 1 ? `${items[0].cantidad} ${items[0].unidad} de ${items[0].descripcion}` : `${items.length} insumos`);

  const filas = items
    .map(
      (it) => `<tr>
        <td style="padding:6px 8px;border:1px solid #ddd">${esc(it.descripcion)}${it.codigo ? `<br><small style="color:#888">Cód: ${esc(it.codigo)}</small>` : `<br><small style="color:#c2410c">Insumo nuevo</small>`}</td>
        <td style="padding:6px 8px;border:1px solid #ddd">${esc(it.marca) || "—"}</td>
        <td style="padding:6px 8px;border:1px solid #ddd">${esc(it.color) || "—"}</td>
        <td style="padding:6px 8px;border:1px solid #ddd">${esc(it.medida) || "—"}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:center"><b>${esc(it.cantidad)}</b> ${esc(it.unidad)}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:center">${it.stock_al_pedir ?? "—"}</td>
      </tr>`
    )
    .join("");

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#222">
    <h2 style="margin:0 0 4px;color:#ea580c">${urgente ? "🔴 URGENTE — " : ""}Orden de pedido #${ped.id}</h2>
    <p style="margin:0 0 12px;color:#555">${ped.origen === "alerta" ? "Generada desde la alerta de stock mínimo" : "Pedido manual"} · ${esc(fecha)} · por <b>${esc(ped.usuario)}</b></p>
    <p style="margin:0 0 4px"><b>Categoría:</b> ${esc(ped.categoria) || "—"} &nbsp; <b>Proveedor:</b> ${esc(ped.proveedor) || "—"}</p>
    <table style="border-collapse:collapse;margin-top:10px;font-size:14px">
      <thead><tr style="background:#f97316;color:#fff">
        <th style="padding:6px 8px;text-align:left">Insumo</th><th style="padding:6px 8px">Marca</th>
        <th style="padding:6px 8px">Color</th><th style="padding:6px 8px">Medida</th>
        <th style="padding:6px 8px">Cantidad</th><th style="padding:6px 8px">Stock actual</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    ${ped.obs ? `<p style="margin-top:12px"><b>Observaciones:</b><br>${esc(ped.obs).replace(/\n/g, "<br>")}</p>` : ""}
    <p style="margin-top:18px;color:#888;font-size:12px">Enviado automáticamente por StockScanner — Grupo Aixa.</p>
  </div>`;

  const text =
    `Orden de pedido #${ped.id}${urgente ? " (URGENTE)" : ""}\n` +
    `Fecha: ${fecha} · Pedido por: ${ped.usuario}\n` +
    `Categoría: ${ped.categoria || "—"} · Proveedor: ${ped.proveedor || "—"}\n\n` +
    items
      .map(
        (it) =>
          `- ${it.cantidad} ${it.unidad} · ${it.descripcion}` +
          [it.marca && `Marca: ${it.marca}`, it.color && `Color: ${it.color}`, it.medida && `Medida: ${it.medida}`]
            .filter(Boolean)
            .map((s) => ` · ${s}`)
            .join("") +
          (it.codigo ? ` (cód ${it.codigo})` : " (insumo nuevo)")
      )
      .join("\n") +
    (ped.obs ? `\n\nObservaciones: ${ped.obs}` : "");

  return { subject, html, text };
}

async function enviar(subject: string, html: string, text: string) {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey) {
    const from = Deno.env.get("MAIL_FROM") || "StockScanner <onboarding@resend.dev>";
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: DESTINATARIOS, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return "resend";
  }

  const gUser = Deno.env.get("GMAIL_USER");
  const gPass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (gUser && gPass) {
    const client = new SMTPClient({
      connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: gUser, password: gPass } },
    });
    await client.send({ from: `StockScanner Aixa <${gUser}>`, to: DESTINATARIOS, subject, content: text, html });
    await client.close();
    return "gmail";
  }

  throw new Error("Correo no configurado (falta RESEND_API_KEY o GMAIL_USER/GMAIL_APP_PASSWORD)");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let pedidoId: number;
  try {
    pedidoId = Number((await req.json()).pedido_id);
    if (!Number.isFinite(pedidoId)) throw new Error();
  } catch {
    return json({ error: "Falta pedido_id" }, 400);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const { data: ped, error } = await sb.from("pedidos").select("*, pedido_items(*)").eq("id", pedidoId).single();
  if (error || !ped) return json({ error: "Pedido no encontrado" }, 404);

  const { subject, html, text } = armarMail(ped);
  try {
    const via = await enviar(subject, html, text);
    await sb
      .from("pedidos")
      .update({ email_estado: "enviado", email_detalle: `Enviado (${via}) a ${DESTINATARIOS.join(", ")} — ${new Date().toISOString()}` })
      .eq("id", pedidoId);
    return json({ ok: true, via });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("pedidos").update({ email_estado: "error", email_detalle: msg.slice(0, 500) }).eq("id", pedidoId);
    return json({ ok: false, error: msg }, 502);
  }
});
