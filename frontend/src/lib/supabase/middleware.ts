import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";

const PUBLIC_PATHS = ["/login", "/auth", "/apply", "/verify"]; // /apply: online admission; /verify: QR check of certificates and ID cards (no account needed)

export async function updateSession(request: NextRequest) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return new NextResponse(
      "Frontend is not configured: copy frontend/.env.example to frontend/.env.local and fill in the Supabase values, then restart `npm run dev`.",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    config.supabaseUrl,
    config.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Validates the session with Supabase Auth (cookies alone are not trusted).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Keep the query string too, so deep links (filters, tabs) survive sign-in.
    const target = path + request.nextUrl.search;
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(target)}`;
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
