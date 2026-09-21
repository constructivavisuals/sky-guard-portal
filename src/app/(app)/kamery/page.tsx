import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Video } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui.tsx";
import { PREVIEW_BUCKET, PREVIEW_SIGNED_URL_TTL } from "@/lib/cameras/preview.ts";
import { formatDate } from "@/lib/format.ts";
import { getSiteSelection } from "@/lib/selected-site.ts";
import { createClient } from "@/lib/supabase/server.ts";

export const metadata: Metadata = { title: "Kamery" };

// Přehled kamer — rozcestník do detailu.
//
// ═══ Proč se sem sloučily tři položky menu ═════════════════════════
// Živý obraz, časová osa a záznamy byly tři stránky, mezi kterými
// člověk skákal a musel si u toho pamatovat, o které kameře je řeč.
// Přitom je to jedna otázka: co se na té stavbě děje nebo dělo.
// Vzor je DMSS — kamera se otevře a v ní se přepínají pohledy.
//
// ═══ Tenhle seznam o živosti kamery NIC netvrdí ════════════════════
// A je to schválně, po dvou pokusech, které tvrdily nepravdu:
//
//   `last_seen_at`   zapisuje se, jen když něco DORAZÍ — detekce, klip
//                    nebo vjezd. Zdravá kamera, u které půl hodiny
//                    nikdo neprošel, se tvářila jako mrtvá. V noci na
//                    klidné stavbě všechny.
//
//   `cameras.status` má DEFAULT 'offline' a nastavuje ho jedině ruční
//                    formulář v Areálech. Kamery ho tedy mají takový,
//                    s jakým je někdo založil — u většiny 'offline',
//                    ať fungují sebelíp.
//
// Ani jedno není živost. Ukazovat kolečko počítané z něčeho jiného
// znamená u bezpečnostního produktu to nejhorší: buď se poplach spustí
// na funkční kameře, nebo se mlčí u rozbité.
//
// Živost umí říct jedině relay — `sky-events` drží na každé kameře
// spojení a o výpadku ví hned. Do portálu to zatím neposílá. Dokud to
// posílat nebude, je poctivější neříkat nic než hádat.
//
// Administrativní stav zůstává v Areálech, kde ho admin nastavuje
// a kde má tím pádem smysl.
//
// ═══ Náhled ano, živá mřížka ne ════════════════════════════════════
// Jméno KL_03 neřekne nikomu, kdo po té stavbě nechodí, kam ta kamera
// kouká — a tak se otevíraly po řadě, dokud se nenašla ta správná.
// Řeší to jeden STATICKÝ snímek u řádku, který jednou týdně obnovuje
// `/api/cron/nahledy`.
//
// Mřížka ŽIVÝCH náhledů by vypadala líp a stála devět spojení na
// kamery, které zároveň píšou na vlastní kartu — při každém otevření
// seznamu. Živý obraz se proto pořád načítá až v detailu, u jedné
// kamery.
//
// Statický snímek se u toho musí přiznat, jinak je to horší než nic:
// pod každým náhledem je datum pořízení. Bez něj by obrázek tvrdil,
// že tak ta stavba vypadá TEĎ, a klient by se podle týden starého
// záběru rozhodoval, jestli tam někdo je.

export const dynamic = "force-dynamic";

interface CameraRow {
  id: string;
  name: string;
  serial_number: string | null;
  site_id: string;
  sites: { name: string; timezone: string } | null;
  /** Migrace 20260921120000; chybí, dokud nenaběhne. */
  preview_path?: string | null;
  preview_captured_at?: string | null;
}

const SLOUPCE = "id, name, serial_number, site_id, sites(name, timezone)";
const SLOUPCE_S_NAHLEDEM = `${SLOUPCE}, preview_path, preview_captured_at`;

async function nacistKamery(
  supabase: Awaited<ReturnType<typeof createClient>>,
  siteId: string | null,
  sNahledem: boolean,
) {
  let query = supabase
    .from("cameras")
    .select(sNahledem ? SLOUPCE_S_NAHLEDEM : SLOUPCE)
    .eq("ingest_mode", "ftp")
    .neq("status", "decommissioned")
    .order("name");

  if (siteId) query = query.eq("site_id", siteId);

  return await query.returns<CameraRow[]>();
}

export default async function Page() {
  const { selected } = await getSiteSelection();

  let cameras: CameraRow[] = [];
  let failed = false;
  /** Cesta náhledu → podepsaná adresa. Prázdné, než proběhne cron. */
  const nahledy = new Map<string, string>();

  try {
    const supabase = await createClient();

    // Nejdřív se sloupci náhledu, a když migrace 20260921120000 ještě
    // nenaběhla, znovu bez nich. Bez téhle větve by stačilo nasadit kód
    // dřív než migraci a celý seznam kamer by zmizel za hláškou
    // „nepodařilo se načíst" — tedy kvůli obrázku by se nedalo otevřít
    // ani video.
    let vysledek = await nacistKamery(supabase, selected?.id ?? null, true);
    if (vysledek.error) {
      vysledek = await nacistKamery(supabase, selected?.id ?? null, false);
    }
    if (vysledek.error) throw vysledek.error;

    cameras = vysledek.data ?? [];

    const cesty = cameras
      .map((row) => row.preview_path)
      .filter((cesta): cesta is string => Boolean(cesta));

    if (cesty.length > 0) {
      // Jedním voláním pro celý seznam — jinak by to bylo tolik kol po
      // síti, kolik je kamer. Podepisuje se klientem PŘIHLÁŠENÉHO
      // uživatele, takže o přístupu rozhoduje politika nad
      // storage.objects, ne tenhle kód.
      const { data } = await supabase.storage
        .from(PREVIEW_BUCKET)
        .createSignedUrls(cesty, PREVIEW_SIGNED_URL_TTL);

      for (const item of data ?? []) {
        if (item.signedUrl && item.path) nahledy.set(item.path, item.signedUrl);
      }
    }
  } catch {
    failed = true;
  }

  // Kamera bez sériového čísla se do výběru nedostane: relay ji nemá
  // jak pojmenovat, takže by to byl proklik do chybové hlášky.
  const dostupne = cameras.filter((row) => row.serial_number);

  return (
    <>
      <PageHeader
        title="Kamery"
        description={
          selected
            ? `Obraz, záznam a události kamer na lokalitě ${selected.name}.`
            : "Vyberte lokalitu v liště — kamery se otevírají po jedné."
        }
      />

      {failed ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Kamery se nepodařilo načíst"
          description="Zkuste to za chvíli znovu."
        />
      ) : dostupne.length === 0 ? (
        <EmptyState
          icon={<Video className="h-5 w-5" aria-hidden="true" />}
          title="Žádná kamera"
          description={
            cameras.length > 0
              ? "Kamery tu jsou, ale nemají vyplněné sériové číslo — relay je podle něj hledá."
              : "Obraz umí stavební kamery připojené přes relay."
          }
        />
      ) : (
        <ul className="border-t border-[var(--line)]">
          {dostupne.map((row) => {
            const nahled = row.preview_path
              ? (nahledy.get(row.preview_path) ?? null)
              : null;
            const poridzeno =
              nahled && row.preview_captured_at
                ? formatDate(row.preview_captured_at, row.sites?.timezone)
                : null;
            // Druhý řádek. U vybrané lokality stojí popisek sám, tak
            // začíná velkým písmenem; za jménem lokality je to
            // pokračování věty. Kamera bez náhledu to řekne — prázdný
            // řádek by vypadal jako chyba vykreslení a ikona vedle něj
            // jako rozbitý obrázek.
            const popisek = selected
              ? poridzeno
                ? `Náhled z ${poridzeno}`
                : "Náhled se zatím nepořídil"
              : [row.sites?.name ?? "—", poridzeno ? `náhled z ${poridzeno}` : null]
                  .filter(Boolean)
                  .join(" · ");

            return (
              <li key={row.id}>
                <Link
                  href={`/kamery/${row.id}`}
                  className="flex items-center gap-4 border-b border-[var(--line)] px-4 py-2.5 transition hover:bg-[var(--surface-2)] sm:px-6 sm:py-3"
                >
                  {/*
                    Pevná velikost i bez snímku, aby seznam nepoposkočil
                    u kamery, která náhled zatím nemá — a aby se po
                    dotažení obrázku nepřekreslil zbytek řádku.

                    ═══ Velikost je daná obrazovkou, ne vkusem ═══════
                    Šest kamer na lokalitě se musí vejít na telefon BEZ
                    scrollování — jinak je poslední kamera schovaná
                    a seznam přestane být rozcestník. Na iPhonu vychází
                    řádek na 84 px: náhled 64 px a 2×10 px kolem něj.
                    Kdo bude přidávat, ať to na telefonu přeměří;
                    o dva řádky víc znamená menší náhled, ne delší
                    stránku.

                    Poměr stran drží při 16:9 (64×112 je 1,75), aby se
                    ze snímku ořízl co nejmenší kus. Na širokém displeji
                    je místa dost, tam se náhled zvětší.
                  */}
                  <span className="block h-16 w-28 shrink-0 overflow-hidden border border-[var(--line)] bg-[var(--surface-2)] sm:h-20 sm:w-36">
                    {nahled ? (
                      // Obyčejný <img>: adresa je podepsaná a krátkodobá,
                      // takže by ji next/image cachoval pod klíčem, který
                      // za čtvrt hodiny přestane platit.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={nahled}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center">
                        <Video
                          className="h-5 w-5 text-[var(--text-muted)]"
                          aria-hidden="true"
                        />
                      </span>
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">
                      {row.name}
                    </span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {/*
                        Datum u náhledu není ozdoba: statický snímek
                        vypadá jako živý obraz a tohle je jediné místo,
                        kde se přizná, že je starý.

                        Jméno lokality se vypisuje, jen když se dívá
                        přes všechny — u vybrané lokality ho nese
                        nadpis stránky a v každém řádku by jen bral
                        místo datu, které se pak na telefonu ořízne.
                      */}
                      {popisek}
                    </span>
                  </span>

                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Klipy u detekcí jsou přístupné z každé kamery zvlášť, ale
        seznam přes všechny kamery se hodí při hledání „kdy se to
        stalo naposledy". Nechávat ho jen jako adresu bez odkazu by
        znamenalo, že o něm nikdo neví.
      */}
      {dostupne.length > 0 ? (
        <div className="px-4 py-4 sm:px-6">
          <Link
            href="/zaznamy"
            className="text-xs text-[var(--text-muted)] underline underline-offset-4 transition hover:text-[var(--text)]"
          >
            Uložené klipy přes všechny kamery
          </Link>
        </div>
      ) : null}
    </>
  );
}
