import type { Metadata } from "next";
import { headers } from "next/headers";

import { Logo } from "@/components/logo.tsx";
import { findCarrierByToken } from "@/lib/arrivals/carrier.ts";
import { localDateISO, MAX_DAYS_AHEAD } from "@/lib/arrivals/rules.ts";
import { clientIp, takeArrivalToken } from "@/lib/ingest/rate-limit.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";
import type { AnnouncedArrival } from "@/types/database.ts";

import { ArrivalForm, type ArrivalRow } from "./form.tsx";

// Stránka pro řidiče dopravce.
//
// Mimo přihlášení, mimo app shell: žádný sidebar, žádná spodní
// navigace, z portálu jen logo. Kdo sem přijde, není uživatel portálu —
// je to řidič, který na telefonu u brány ohlásí, že zítra přiveze
// beton. Čím míň toho na obrazovce je, tím líp.

export const metadata: Metadata = {
  title: "Ohlášení příjezdu",
  // Odkaz nemá co viset ve vyhledávačích.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Kolik dní dopředu se ukazuje seznam vlastních ohlášení. */
const DAYS_AHEAD = 7;

export default async function Page({ params }: PageProps<"/prijezd/[token]">) {
  const { token } = await params;

  // Limit i na vykreslení, ne jen na odeslání: uhodnout token jde
  // i opakovaným načítáním stránky.
  const limit = await takeArrivalToken(supabaseAdmin(), {
    token,
    ip: clientIp(await headers()),
  });
  if (!limit.allowed) {
    return (
      <Prosta
        nadpis="Příliš mnoho pokusů"
        text="Zkuste to prosím za chvíli znovu."
      />
    );
  }

  const lookup = await findCarrierByToken(token);

  if (!lookup.ok) {
    // Neplatný, vypnutý i prošlý odkaz vypadají stejně. Odkaz, který
    // se ocitne v cizích rukou, se z odpovědi nemá jak dozvědět, jestli
    // aspoň někdy existoval.
    return (
      <Prosta
        nadpis="Odkaz neplatí"
        text="Tenhle odkaz na ohlášení příjezdu už není platný. Vyžádejte si nový u správce areálu."
      />
    );
  }

  const { carrier, site } = lookup;
  const ted = new Date();
  const dnes = localDateISO(site.timezone, ted);
  const doKdy = localDateISO(
    site.timezone,
    new Date(ted.getTime() + DAYS_AHEAD * 86_400_000),
  );

  const { data: arrivals } = await supabaseAdmin()
    .from("announced_arrivals")
    .select("id, plate, arrival_date, note, night_ok, cancelled_at, created_at")
    .eq("carrier_id", carrier.id)
    .is("cancelled_at", null)
    .gte("arrival_date", dnes)
    .lte("arrival_date", doKdy)
    .order("arrival_date", { ascending: true })
    .returns<AnnouncedArrival[]>();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[34rem] flex-col px-5 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <Logo className="h-6 self-start" />

      <h1 className="mt-7 text-[24px] font-normal leading-tight tracking-[-0.02em]">
        Ohlášení příjezdu
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
        {carrier.name} · {site.name}
      </p>

      <ArrivalForm
        token={token}
        today={dnes}
        maxDate={localDateISO(
          site.timezone,
          new Date(ted.getTime() + MAX_DAYS_AHEAD * 86_400_000),
        )}
        arrivals={(arrivals ?? []) as ArrivalRow[]}
        daysAhead={DAYS_AHEAD}
        timeZone={site.timezone}
      />
    </main>
  );
}

/**
 * Stránka bez ničeho. Schválně nemá odkaz zpět ani nápovědu, co dělat
 * dál — kdo sem přijde s cizím odkazem, nemá co zkoušet.
 */
function Prosta({ nadpis, text }: { nadpis: string; text: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[34rem] flex-col justify-center px-5 py-16 text-center">
      <Logo className="mx-auto h-6" />
      <h1 className="mt-8 text-[22px] font-normal tracking-[-0.02em]">{nadpis}</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">{text}</p>
    </main>
  );
}
