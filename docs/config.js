// Configuración pública de Supabase — la "anon key" está pensada para
// exponerse en el frontend (la seguridad real la da Row Level Security
// en Postgres, ver supabase/schema.sql). NUNCA poner acá la service_role key.
window.SUPABASE_URL = "REEMPLAZAR_CON_PROJECT_URL";
window.SUPABASE_ANON_KEY = "REEMPLAZAR_CON_ANON_KEY";
