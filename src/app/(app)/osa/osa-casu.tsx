"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";

import { Prehravac } from "../prehravac.tsx";

// Časová osa nad záznamem na SD kartě kamery.
//
// ═══ Proč skoky a ne plynulé táhlo ═════════════════════════════════
// Protože takhle to doopravdy funguje. go2rtc pojem času nemá: každý
// posun znamená ZAVŘÍT proud a otevřít nový od jiného okamžiku, což je
// nové spojení na kameru, hledání na kartě a čekání na klíčový snímek.
// Táhlo by slibovalo plynulost, kterou pod ním nikdo nemá — divák by
// ho táhl a obraz by se sekal.
//
// Tlačítka a přesný čas naopak říkají pravdu: jeden skok, jedno
// otevření. Za to je odezva předvídatelná.
//
// ═══ Čas se drží v prohlížeči, ne v adrese ═════════════════════════
// Kdyby byl v URL, každý skok by znamenal navigaci na serveru
// a překreslení celé stránky včetně zbytečného načtení seznamu kamer.
// Přepnutí KAMERY navigace je (jiná stránka, jiný seznam), přepnutí
// ČASU ne.

/** Skoky, které dávají smysl při hledání události. */
const SKOKY = [
  { label: "1 min", ms: 60_000 },
  { label: "10 min", ms: 600_000 },
  { label: "1 h", ms: 3_600_000 },
  { label: "1 den", ms: 86_400_000 },
];

/** Výchozí odstup od živého okraje. */
const VYCHOZI_ZPET_MS = 3_600_000;

/**
 * `datetime-local` chce místní čas bez zóny.
 *
 * `toISOString()` je UTC a vyrobilo by posun o hodinu nebo dvě —
 * uživatel by zadal 14:00 a díval se na 12:00.
 */
function proInput(d: Date): string {
  const posun = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - posun).toISOString().slice(0, 16);
}

function popisCasu(d: Date): string {
  return d.toLocaleString("cs-CZ", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const TLACITKO =
  "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-3 py-1 text-xs " +
  "text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] " +
  "hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent";

export function OsaCasu({
  cameraId,
  cameraName,
  dosahDni,
}: {
  cameraId: string;
  cameraName: string;
  dosahDni: number;
}) {
  // ═══ Nic časového se nevykreslí, dokud se nenahydratuje ═════════
  // Tahle komponenta jde na server i do prohlížeče. Kdyby vykreslila
  // čas rovnou, obě vykreslení by se lišila hned dvakrát:
  //
  //   * `Date.now()` je mezi nimi o pár set milisekund jinde;
  //   * `toLocaleString` a `getTimezoneOffset` berou zónu BĚHU —
  //     server jede v UTC, prohlížeč v Europe/Prague, takže i při
  //     zmrazeném čase by se texty lišily o dvě hodiny.
  //
  // React to hlásí jako #418 a hydrataci té části zahodí.
  //
  // Do nahydratování se proto vykresluje kostra, která je na obou
  // stranách stejná. Týž vzor jako v login-form.tsx: `useState`
  // s efektem by vyrobil kaskádový render navíc.
  //
  // Vedlejší užitek: přehrávač se nesmontuje se serverovým časem,
  // takže si nesahá pro lístek na okamžik, který si nikdo nevybral.
  const hydratovano = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Inicializátory `useState` běží až v prohlížeči při prvním klientském
  // renderu — a jejich hodnota se do té doby stejně nevykresluje.
  const [od, setOd] = useState(() => new Date(Date.now() - VYCHOZI_ZPET_MS));
  const [ted, setTed] = useState(() => Date.now());

  const nejdriv = useMemo(
    () => new Date(ted - dosahDni * 86_400_000),
    [ted, dosahDni],
  );
  const nejpozdeji = useMemo(() => new Date(ted), [ted]);

  /** Ořízne na to, co karta drží. Volá se jen z obsluhy událostí. */
  function nastav(kdy: Date, nyni: number) {
    const dolni = nyni - dosahDni * 86_400_000;
    setTed(nyni);
    setOd(new Date(Math.min(Math.max(kdy.getTime(), dolni), nyni)));
  }

  // `nyni` se předává zvenčí, z obsluhy události. Číst hodiny uvnitř
  // funkce volané při renderu by bylo nečisté — a linter to pozná,
  // i když ji ve skutečnosti nikdo z renderu nevolá.
  function posun(ms: number, nyni: number) {
    nastav(new Date(od.getTime() + ms), nyni);
  }

  if (!hydratovano) {
    return (
      <div className="border-b border-[var(--line)] px-4 py-4 text-xs text-[var(--text-muted)] sm:px-6">
        Načítá se časová osa…
      </div>
    );
  }

  const naZacatku = od.getTime() - 60_000 < nejdriv.getTime();
  const naKonci = od.getTime() + 60_000 > nejpozdeji.getTime();

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-[var(--line)] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Zpátky</span>
          {[...SKOKY].reverse().map((skok) => (
            <button
              key={`zpet-${skok.label}`}
              type="button"
              onClick={() => posun(-skok.ms, Date.now())}
              disabled={naZacatku}
              className={TLACITKO}
            >
              <ChevronLeft className="h-3 w-3" aria-hidden="true" />
              {skok.label}
            </button>
          ))}

          <span className="ml-2 text-xs text-[var(--text-muted)]">Dopředu</span>
          {SKOKY.map((skok) => (
            <button
              key={`vpred-${skok.label}`}
              type="button"
              onClick={() => posun(skok.ms, Date.now())}
              disabled={naKonci}
              className={TLACITKO}
            >
              {skok.label}
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            Od
            <input
              type="datetime-local"
              value={proInput(od)}
              min={proInput(nejdriv)}
              max={proInput(nejpozdeji)}
              onChange={(e) => {
                const zadany = new Date(e.target.value);
                if (!Number.isNaN(zadany.getTime())) nastav(zadany, Date.now());
              }}
              className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-2)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>

          <button
            type="button"
            onClick={() => {
              const nyni = Date.now();
              nastav(new Date(nyni - VYCHOZI_ZPET_MS), nyni);
            }}
            className={TLACITKO}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Hodinu zpátky
          </button>

          <span className="text-sm tabular-nums text-[var(--text)]">
            {popisCasu(od)}
          </span>
        </div>
      </div>

      <Prehravac
        // Jiný čas je JINÝ PROUD, ne přetočení toho běžícího. Bez klíče
        // by se do <video> jen vyměnil zdroj a MediaSource z minulého
        // spojení by zůstala viset.
        key={`${cameraId}-${Math.floor(od.getTime() / 1000)}`}
        konfiguraceUrl={`/api/kamery/${cameraId}/zaznam?od=${encodeURIComponent(
          od.toISOString(),
        )}`}
        cameraName={cameraName}
      />

      <p className="px-4 py-3 text-xs text-[var(--text-muted)] sm:px-6">
        Záznam je na SD kartě v kameře a drží zhruba {dosahDni} dní zpětně.
        Každý skok otevírá nové spojení, takže chvíli trvá, než obraz
        naskočí.
      </p>
    </>
  );
}
