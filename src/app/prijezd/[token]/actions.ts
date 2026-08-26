"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { findCarrierByToken } from "@/lib/arrivals/carrier.ts";
import { localDateISO, MAX_DAYS_AHEAD } from "@/lib/arrivals/rules.ts";
import { clientIp, takeArrivalToken } from "@/lib/ingest/rate-limit.ts";
import { normalizePlate } from "@/lib/plates.ts";
import { supabaseAdmin } from "@/lib/supabase-admin.ts";

// Server akce stránky řidiče.
//
// Token se ověřuje ZNOVU v každé akci, ne jen při vykreslení stránky.
// Akce je samostatný endpoint: kdo si opíše její volání, obejde tím
// stránku úplně. Vypnutý dopravce proto musí narazit i tady.
//
// Všechno běží pod service_role, protože řidič nemá účet. Rozsah je
// dán tokenem: zapisuje se výhradně pod carrier_id a site_id, které
// z něj vyšly — nikdy z toho, co přišlo z formuláře.

export interface ArrivalActionState {
  ok: boolean;
  error?: string;
  /** Co uživatel odeslal, ať se formulář po chybě nevyprázdní. */
  values?: { plate?: string; arrival_date?: string; note?: string; night_ok?: boolean };
}

const NEPLATNY: ArrivalActionState = {
  ok: false,
  error: "Odkaz už neplatí. Vyžádejte si nový.",
};

export async function ohlasitPrijezd(
  _prev: ArrivalActionState,
  data: FormData,
): Promise<ArrivalActionState> {
  const token = String(data.get("token") ?? "");
  const plateRaw = String(data.get("plate") ?? "").trim();
  const dateRaw = String(data.get("arrival_date") ?? "").trim();
  const noteRaw = String(data.get("note") ?? "").trim();
  const nightOk = data.has("night_ok");

  const values = {
    plate: plateRaw,
    arrival_date: dateRaw,
    note: noteRaw,
    night_ok: nightOk,
  };

  const db = supabaseAdmin();
  const limit = await takeArrivalToken(db, {
    token,
    ip: clientIp(await headers()),
  });
  if (!limit.allowed) {
    return { ok: false, error: "Příliš mnoho pokusů. Zkuste to za chvíli.", values };
  }

  const lookup = await findCarrierByToken(token);
  if (!lookup.ok) return { ...NEPLATNY, values };

  const plate = normalizePlate(plateRaw);
  if (!plate) {
    return { ok: false, error: "Zadejte registrační značku.", values };
  }
  if (plate.length > 15) {
    return { ok: false, error: "Značka je příliš dlouhá.", values };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return { ok: false, error: "Zadejte datum příjezdu.", values };
  }

  // Dnešek se počítá v pásmu lokality, ne prohlížeče: řidič může být
  // v jiném pásmu než areál a „dnes“ platí pro areál.
  const dnes = localDateISO(lookup.site.timezone);
  if (dateRaw < dnes) {
    return { ok: false, error: "Zpětně se ohlásit nedá. Vyberte dnešek nebo pozdější den.", values };
  }

  const nejzazsi = localDateISO(
    lookup.site.timezone,
    new Date(Date.now() + MAX_DAYS_AHEAD * 86_400_000),
  );
  if (dateRaw > nejzazsi) {
    return {
      ok: false,
      error: `Ohlásit se dá nejvýš ${MAX_DAYS_AHEAD} dní dopředu.`,
      values,
    };
  }

  const { error } = await db.from("announced_arrivals").insert({
    carrier_id: lookup.carrier.id,
    // Z tokenu, ne z formuláře. Jinak by šlo ohlásit příjezd na cizí
    // lokalitu podstrčením jiného site_id.
    site_id: lookup.carrier.site_id,
    plate: plateRaw,
    arrival_date: dateRaw,
    note: noteRaw || null,
    night_ok: nightOk,
  });

  if (error) {
    // 23505 = tentýž dopravce už tutéž značku na tentýž den ohlásil.
    // Není to chyba, jen zbytečné druhé odeslání.
    if (error.code === "23505") {
      return { ok: false, error: "Tenhle příjezd už máte ohlášený.", values };
    }
    console.error("Zápis ohlášení selhal", { message: error.message });
    return { ok: false, error: "Ohlášení se nepodařilo uložit.", values };
  }

  revalidatePath(`/prijezd/${token}`);
  return { ok: true };
}

export async function zrusitOhlaseni(
  _prev: ArrivalActionState,
  data: FormData,
): Promise<ArrivalActionState> {
  const token = String(data.get("token") ?? "");
  const id = String(data.get("id") ?? "");

  const db = supabaseAdmin();
  const limit = await takeArrivalToken(db, {
    token,
    ip: clientIp(await headers()),
  });
  if (!limit.allowed) {
    return { ok: false, error: "Příliš mnoho pokusů. Zkuste to za chvíli." };
  }

  const lookup = await findCarrierByToken(token);
  if (!lookup.ok) return NEPLATNY;

  // Razítko místo mazání: ohlášení, na které se ingest při rozhodování
  // odvolal, musí zůstat dohledatelné. Filtr na carrier_id je tu ta
  // podstatná část — bez něj by cizí token rušil cizí ohlášení.
  const { error } = await db
    .from("announced_arrivals")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", id)
    .eq("carrier_id", lookup.carrier.id)
    .is("cancelled_at", null);

  if (error) {
    console.error("Zrušení ohlášení selhalo", { message: error.message });
    return { ok: false, error: "Ohlášení se nepodařilo zrušit." };
  }

  revalidatePath(`/prijezd/${token}`);
  return { ok: true };
}
