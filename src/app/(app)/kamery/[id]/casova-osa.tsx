"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Časová osa nad záznamem na SD kartě, ve stylu DMSS.
//
// ═══ Co osa ukazuje ════════════════════════════════════════════════
// Zelený pás    kde záznam je — tedy dokud sahá karta v kameře
// Oranžové čárky detekce toho dne; je to jediné, co o obsahu víme
// Ukazatel      vybraný okamžik, k němu bublina s časem
//
// Zelený pás NENÍ seznam nahraných úseků. Kamera natáčí nepřetržitě,
// takže je souvislý — končí tam, kam sahá kapacita karty. Kreslit
// jednotlivé úseky by znamenalo předstírat údaj, který nemáme; DMSS
// ho má z kamery, my ne.
//
// ═══ Proč se dá zoomovat ═══════════════════════════════════════════
// Celý den na šířku telefonu má jedna minuta necelý pixel — trefit se
// na vteřinu nejde. Přiblížením se rozsah zúží až na pět minut, kde
// jedna vteřina zabírá znatelný kus. Bez toho je osa hezká a k ničemu.

const DEN_MS = 86_400_000;
const NEJUZSI_MS = 5 * 60_000;

/** Popisky se volí tak, aby jich na šířku byl rozumný počet. */
const KROKY = [
  { ms: 6 * 3_600_000, tvar: "hodina" },
  { ms: 3_600_000, tvar: "hodina" },
  { ms: 15 * 60_000, tvar: "minuta" },
  { ms: 5 * 60_000, tvar: "minuta" },
  { ms: 60_000, tvar: "minuta" },
  { ms: 10_000, tvar: "vterina" },
] as const;

function zacatekDne(d: Date): Date {
  const kopie = new Date(d);
  kopie.setHours(0, 0, 0, 0);
  return kopie;
}

function popisek(cas: Date, tvar: string): string {
  const h = String(cas.getHours()).padStart(2, "0");
  const m = String(cas.getMinutes()).padStart(2, "0");
  if (tvar === "vterina") {
    return `${h}:${m}:${String(cas.getSeconds()).padStart(2, "0")}`;
  }
  return `${h}:${m}`;
}

function cas(d: Date): string {
  return d.toLocaleTimeString("cs-CZ", { hour12: false });
}

export function CasovaOsa({
  hodnota,
  onZmena,
  dostupneOd,
  nejpozdeji,
  detekce,
}: {
  hodnota: Date;
  onZmena: (kdy: Date) => void;
  /** Kam až dozadu sahá karta. */
  dostupneOd: Date;
  nejpozdeji: Date;
  /** Kdy toho dne něco bylo. Jen značky, ne úseky. */
  detekce: readonly Date[];
}) {
  const [rozsah, setRozsah] = useState(DEN_MS);
  const [stred, setStred] = useState<Date>(hodnota);
  const pas = useRef<HTMLDivElement>(null);
  const tah = useRef<{ x: number; stred: number; tazeno: boolean } | null>(null);

  // ═══ Přiblížení dvěma prsty ══════════════════════════════════════
  // Lupičky tu byly a zmizely: na telefonu je přirozené osu roztáhnout
  // a stáhnout prsty, přesně jako mapu. Tlačítka navíc znamenala
  // klepat pětkrát, než se z celého dne dostane na minuty.
  //
  // Drží se všechny prsty na ose, protože rozestup mezi nimi je to
  // jediné, z čeho se dá poměr přiblížení spočítat.
  const prsty = useRef(new Map<number, number>());
  const stisk = useRef<{ rozestup: number; rozsah: number; stred: number } | null>(null);

  const den = zacatekDne(hodnota);
  // Přes useMemo, ať se při každém překreslení nevyrábí nové Date —
  // závisely by na něm hooky níž a přepočítávaly by se pořád.
  const od = useMemo(
    () => new Date(stred.getTime() - rozsah / 2),
    [stred, rozsah],
  );
  const doo = useMemo(
    () => new Date(stred.getTime() + rozsah / 2),
    [stred, rozsah],
  );

  /** Kde na ose (0–1) leží daný okamžik. */
  const podil = useCallback(
    (kdy: Date) => (kdy.getTime() - od.getTime()) / rozsah,
    [od, rozsah],
  );

  const krok = useMemo(() => {
    // Takový, aby popisků bylo mezi čtyřmi a deseti.
    for (const k of KROKY) {
      if (rozsah / k.ms >= 4 && rozsah / k.ms <= 12) return k;
    }
    return KROKY[rozsah > DEN_MS / 2 ? 0 : KROKY.length - 1];
  }, [rozsah]);

  const znacky = useMemo(() => {
    const ven: Date[] = [];
    const prvni = Math.ceil(od.getTime() / krok.ms) * krok.ms;
    for (let t = prvni; t < doo.getTime(); t += krok.ms) {
      ven.push(new Date(t));
      if (ven.length > 40) break;
    }
    return ven;
  }, [od, doo, krok]);

  function omez(kdy: Date): Date {
    const t = Math.min(
      Math.max(kdy.getTime(), dostupneOd.getTime()),
      nejpozdeji.getTime(),
    );
    return new Date(t);
  }

  function zXNaCas(clientX: number): Date | null {
    const prvek = pas.current;
    if (!prvek) return null;
    const r = prvek.getBoundingClientRect();
    const p = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return new Date(od.getTime() + p * rozsah);
  }

  // ── Posun tažením, přiblížení dvěma prsty ─────────────────────
  function zacniTah(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    prsty.current.set(e.pointerId, e.clientX);

    if (prsty.current.size === 2) {
      // Druhý prst ruší rozjeté tažení: co začalo jako posun, je od
      // téhle chvíle přiblížení.
      tah.current = null;
      const [a, b] = [...prsty.current.values()];
      stisk.current = {
        rozestup: Math.max(Math.abs(a - b), 1),
        rozsah,
        stred: stred.getTime(),
      };
      return;
    }

    if (prsty.current.size === 1) {
      tah.current = { x: e.clientX, stred: stred.getTime(), tazeno: false };
    }
  }

  function tahni(e: React.PointerEvent) {
    const prvek = pas.current;
    if (!prvek) return;
    if (prsty.current.has(e.pointerId)) prsty.current.set(e.pointerId, e.clientX);

    // Dva prsty: rozestup určuje, jak široký časový rámec je vidět.
    const s = stisk.current;
    if (s && prsty.current.size >= 2) {
      const [a, b] = [...prsty.current.values()];
      const rozestup = Math.max(Math.abs(a - b), 1);
      const novy = Math.min(
        DEN_MS,
        Math.max(NEJUZSI_MS, (s.rozsah * s.rozestup) / rozestup),
      );
      setRozsah(novy);
      // Střed drží místo mezi prsty, ať se pod nimi obraz osy nehýbe.
      const r = prvek.getBoundingClientRect();
      const podilStredu = ((a + b) / 2 - r.left) / r.width;
      setStred(new Date(s.stred + (0.5 - podilStredu) * (novy - s.rozsah)));
      return;
    }

    const t = tah.current;
    if (!t) return;
    const posun = e.clientX - t.x;
    if (Math.abs(posun) > 3) t.tazeno = true;
    if (!t.tazeno) return;
    const r = prvek.getBoundingClientRect();
    setStred(new Date(t.stred - (posun / r.width) * rozsah));
  }

  function skonciTah(e: React.PointerEvent) {
    prsty.current.delete(e.pointerId);
    if (prsty.current.size < 2) stisk.current = null;

    const t = tah.current;
    tah.current = null;
    // Klepnutí bez tažení = skok na místo. Tahle podmínka je celý
    // rozdíl mezi „posouvám osu“ a „vybírám čas“. Po přiblížení dvěma
    // prsty se neskáče nikam — `tah` je v tu chvíli už zrušené.
    if (t && !t.tazeno && prsty.current.size === 0) {
      const kdy = zXNaCas(e.clientX);
      if (kdy) onZmena(omez(kdy));
    }
  }

  // ── Přiblížení ────────────────────────────────────────────────
  function zoom(smer: number, kolem?: Date) {
    const novy = Math.min(DEN_MS, Math.max(NEJUZSI_MS, rozsah * (smer > 0 ? 0.6 : 1 / 0.6)));
    if (kolem) {
      // Přiblížit se má k místu pod prstem, ne ke středu — jinak to,
      // na co člověk míří, uteče pryč.
      const p = podil(kolem);
      setStred(new Date(kolem.getTime() + (0.5 - p) * novy));
    }
    setRozsah(novy);
  }

  const zelenyOd = Math.max(podil(dostupneOd), 0);
  const zelenyDo = Math.min(podil(nejpozdeji), 1);

  return (
    <div className="select-none">
      {/* ── Datum ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        <div className="flex items-center border border-[var(--line)]">
          <button
            type="button"
            aria-label="Předchozí den"
            onClick={() => {
              const novy = omez(new Date(hodnota.getTime() - DEN_MS));
              onZmena(novy);
              setStred(novy);
            }}
            className="px-2 py-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <input
            type="date"
            value={`${den.getFullYear()}-${String(den.getMonth() + 1).padStart(2, "0")}-${String(den.getDate()).padStart(2, "0")}`}
            min={`${dostupneOd.getFullYear()}-${String(dostupneOd.getMonth() + 1).padStart(2, "0")}-${String(dostupneOd.getDate()).padStart(2, "0")}`}
            max={`${nejpozdeji.getFullYear()}-${String(nejpozdeji.getMonth() + 1).padStart(2, "0")}-${String(nejpozdeji.getDate()).padStart(2, "0")}`}
            onChange={(e) => {
              const [r, m, d] = e.target.value.split("-").map(Number);
              if (!r || !m || !d) return;
              const novy = omez(
                new Date(r, m - 1, d, hodnota.getHours(), hodnota.getMinutes()),
              );
              onZmena(novy);
              setStred(novy);
            }}
            className="bg-transparent px-2 py-1 text-sm tabular-nums text-[var(--text)] outline-none"
          />
          <button
            type="button"
            aria-label="Následující den"
            onClick={() => {
              const novy = omez(new Date(hodnota.getTime() + DEN_MS));
              onZmena(novy);
              setStred(novy);
            }}
            className="px-2 py-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

      </div>

      {/* ── Bublina s vybraným časem ──────────────────────────── */}
      <div className="flex justify-center pb-2">
        <span className="border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-1 text-sm tabular-nums text-[var(--text)]">
          {cas(hodnota)}
        </span>
      </div>

      {/* ── Vlastní osa ───────────────────────────────────────── */}
      <div
        ref={pas}
        onPointerDown={zacniTah}
        onPointerMove={tahni}
        onPointerUp={skonciTah}
        onPointerCancel={(e) => {
          prsty.current.delete(e.pointerId);
          tah.current = null;
          stisk.current = null;
        }}
        onWheel={(e) => {
          const kdy = zXNaCas(e.clientX);
          zoom(e.deltaY < 0 ? 1 : -1, kdy ?? undefined);
        }}
        role="slider"
        tabIndex={0}
        aria-label="Čas záznamu"
        aria-valuemin={dostupneOd.getTime()}
        aria-valuemax={nejpozdeji.getTime()}
        aria-valuenow={hodnota.getTime()}
        aria-valuetext={cas(hodnota)}
        onKeyDown={(e) => {
          // Klávesnicí po minutě, se Shiftem po hodině — jinak je osa
          // ovladatelná jen myší a to je u nástroje k prohledávání
          // záznamu málo.
          const skok = e.shiftKey ? 3_600_000 : 60_000;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onZmena(omez(new Date(hodnota.getTime() - skok)));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onZmena(omez(new Date(hodnota.getTime() + skok)));
          }
        }}
        className="relative h-24 cursor-grab touch-none border-y border-[var(--line)] bg-[var(--surface-2)] active:cursor-grabbing"
      >
        {/* dostupný záznam */}
        {zelenyDo > zelenyOd ? (
          <div
            className="absolute top-8 h-10 bg-[var(--accent)]/35 border-y border-[var(--accent-bright)]/50"
            style={{
              left: `${zelenyOd * 100}%`,
              width: `${(zelenyDo - zelenyOd) * 100}%`,
            }}
            aria-hidden="true"
          />
        ) : null}

        {/* popisky a rysky */}
        {znacky.map((z) => {
          const p = podil(z);
          if (p < 0 || p > 1) return null;
          return (
            <div
              key={z.getTime()}
              className="absolute inset-y-0"
              style={{ left: `${p * 100}%` }}
              aria-hidden="true"
            >
              <div className="absolute top-0 h-3 w-px bg-[var(--line-strong)]" />
              <span className="absolute top-3 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-[var(--text-muted)]">
                {popisek(z, krok.tvar)}
              </span>
              <div className="absolute bottom-0 h-3 w-px bg-[var(--line-strong)]" />
            </div>
          );
        })}

        {/* detekce */}
        {detekce.map((d) => {
          const p = podil(d);
          if (p < 0 || p > 1) return null;
          return (
            <div
              key={d.getTime()}
              title={`Detekce v ${cas(d)}`}
              className="absolute top-8 h-10 w-0.5 -translate-x-1/2 bg-[var(--warning)]"
              style={{
                left: `${p * 100}%`,
                boxShadow: "0 0 6px rgba(255, 134, 5, 0.7)",
              }}
              aria-hidden="true"
            />
          );
        })}

        {/* ukazatel */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-[var(--accent-bright)]"
          style={{
            left: `${Math.min(Math.max(podil(hodnota), 0), 1) * 100}%`,
            boxShadow: "0 0 8px rgba(0, 153, 255, 0.8)",
          }}
          aria-hidden="true"
        >
          <div className="absolute -top-px left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[var(--accent-bright)]" />
        </div>
      </div>

      <p className="px-4 py-2 text-[11px] text-[var(--text-muted)] sm:px-6">
        Tažením se osa posouvá, dvěma prsty (nebo kolečkem) přibližuje,
        klepnutím se skáče. Zeleně je, kam sahá karta v kameře;
        oranžově detekce.
      </p>
    </div>
  );
}
