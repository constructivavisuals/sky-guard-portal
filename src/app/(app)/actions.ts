"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { ALL_SITES, SITE_COOKIE, isSiteId } from "@/lib/site.ts";

/**
 * Uloží vybranou lokalitu do cookie.
 *
 * Neověřuje, že lokalita existuje — kdyby uživatel podstrčil cizí UUID,
 * RLS mu stejně nic nevrátí a getSiteSelection() se vrátí na první
 * viditelnou lokalitu. Kontroluje se jen tvar, ať se do cookie nedostane
 * cokoli.
 */
export async function selectSite(formData: FormData) {
  const value = String(formData.get("siteId") ?? "");
  const store = await cookies();

  if (value === ALL_SITES) {
    store.set(SITE_COOKIE, ALL_SITES, cookieOptions());
  } else if (isSiteId(value)) {
    store.set(SITE_COOKIE, value, cookieOptions());
  } else {
    store.delete(SITE_COOKIE);
  }

  // Filtr se propisuje do celého shellu včetně odznaku střežení.
  revalidatePath("/", "layout");
}

function cookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  };
}
