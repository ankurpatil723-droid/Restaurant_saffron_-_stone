const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('[Supabase] Warning: SUPABASE_URL is not defined in .env');
}

// Client using Publishable / Anon key (respects Row Level Security)
const supabase = createClient(supabaseUrl, supabasePublishableKey || supabaseSecretKey, {
  auth: {
    persistSession: false
  }
});

// Admin client using Secret / Service Role key (bypasses RLS for server-side operations)
const supabaseAdmin = supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : supabase;

module.exports = {
  supabase,
  supabaseAdmin,
  supabaseUrl,
  supabasePublishableKey,
  supabaseSecretKey
};
