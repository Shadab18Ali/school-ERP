import { createBrowserClient } from "@supabase/ssr";
import { config } from "@/lib/config";

export function createClient() {
  return createBrowserClient(
    config.supabaseUrl,
    config.supabaseAnonKey,
  );
}
