window.STM_SUPABASE = {
  url: 'https://jbxmijepfjtqnukamhbb.supabase.co',
  publishableKey: 'sb_publishable_ZG6f872kCGU8vm3lG_KWVA_EZpfTFdL'
};

window.supabaseClient = null;
if (window.supabase && window.STM_SUPABASE.url && window.STM_SUPABASE.publishableKey) {
  window.supabaseClient = window.supabase.createClient(
    window.STM_SUPABASE.url,
    window.STM_SUPABASE.publishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );
}
