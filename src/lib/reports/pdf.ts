import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { DISPATCH_OUTCOME_LABELS } from "../../types/database.ts";

import { SKIP_REASON_LABELS, type MonthlyReport } from "./data.ts";

// Měsíční report jako PDF.
//
// ═══ Proč pdf-lib a ne jsPDF ═══════════════════════════════════════
// Vzor je převzatý z constructiva-portal, kde jsou obě cesty vedle
// sebe — a rozdíl je právě v diakritice. Starší report na jsPDF stojí
// na Helvetice z PDF standardu, která české znaky nemá, a řeší to
// přepisem „ě“ na „e“. Report pro klienta, ve kterém stojí „Vysoke
// Veseli“, vypadá jako chyba, protože to chyba je.
//
// pdf-lib s @pdf-lib/fontkit umí vložit vlastní TTF. Vkládá se DM Sans,
// tedy totéž písmo, kterým mluví portál i web.
//
// K subsettingu: v constructiva-portal je u Interu VYPNUTÝ, protože
// subsetter v @pdf-lib/fontkit si tam neporadil se složenými glyfy
// písmen s diakritikou — generování prošlo, ale znaky se vykreslily
// prázdné.
//
// U DM Sans to změřeno neplatí: se subsetem se „Příliš žluťoučký kůň
// úpěl ďábelské ódy“ vykreslí i vyextrahuje správně a font zabere
// 4 kB místo 29. Vzor se proto přebírá s touhle jednou odchylkou —
// kopírovat výhradu, která pro tenhle font neplatí, by znamenalo
// tahat v každém reportu 50 kB navíc kvůli cizímu problému.
//
// Kdyby se písmo měnilo, je potřeba to přeměřit znovu; není to
// vlastnost pdf-lib, ale toho konkrétního fontu.
// ═══════════════════════════════════════════════════════════════════

const FONT_DIR = path.join(process.cwd(), "src", "lib", "fonts");

/** A4 na výšku v bodech (1 pt = 1/72"). */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Barvy z portálu, převedené na světlý podklad: report se tiskne
// a černá stránka spolyká toner i čitelnost.
const TEXT = rgb(0.05, 0.06, 0.09);
const MUTED = rgb(0.45, 0.47, 0.55);
const RULE = rgb(0.85, 0.86, 0.9);
const ACCENT = rgb(0.0, 0.35, 0.75);
const DANGER = rgb(0.78, 0.15, 0.2);
const WARNING = rgb(0.85, 0.45, 0.02);
const SUCCESS = rgb(0.0, 0.5, 0.35);

/**
 * Kolik nálezů se do reportu vejde i se snímkem.
 *
 * Useknutí se VYPÍŠE do reportu — tichý ořez by vypadal jako „víc jich
 * nebylo“, což je u bezpečnostního přehledu to nejhorší možné tvrzení.
 */
const MAX_THREAT_ROWS = 12;

/** Šířka náhledu před vložením. Bez zmenšení má jedna fotka z dronu
 *  klidně 6 MB a report by se nedal poslat mailem. */
const THUMB_W = 320;

export interface ReportImage {
  /** JPEG bajty náhledu; null, když se snímek nepodařilo načíst. */
  bytes: Uint8Array | null;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * DM Sans jako TTF. Kdyby soubory v běhovém prostředí chyběly (chybí
 * outputFileTracingIncludes v next.config), spadneme na Helveticu —
 * report bez diakritiky je pořád lepší než 500.
 */
async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  try {
    const [regular, bold] = await Promise.all([
      readFile(path.join(FONT_DIR, "DMSans-400.ttf")),
      readFile(path.join(FONT_DIR, "DMSans-700.ttf")),
    ]);
    return {
      regular: await doc.embedFont(regular, { subset: true }),
      bold: await doc.embedFont(bold, { subset: true }),
    };
  } catch (error) {
    console.error("DM Sans se nepodařilo načíst, jedu na Helvetice", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  }
}

/** Ořízne text tak, aby se vešel do dané šířky, s výpustkou. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

const CAS = new Intl.DateTimeFormat("cs-CZ", {
  day: "numeric",
  month: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export async function buildMonthlyReportPdf(
  report: MonthlyReport,
  images: {
    /** Logo klienta, PNG nebo JPEG. */
    logo: Uint8Array | null;
    /** Náhledy nálezů ve stejném pořadí jako report.threats. */
    threats: (Uint8Array | null)[];
  },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await embedFonts(doc);

  doc.setTitle(`Měsíční report — ${report.site.name} — ${report.period.label}`);
  doc.setCreator("Sky Guard");

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const novaStrana = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  /** Zbývá na stránce místo? Jinak založ novou. */
  const misto = (potreba: number) => {
    if (y - potreba < MARGIN) novaStrana();
  };

  const text = (
    value: string,
    options: {
      x?: number;
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
    } = {},
  ) => {
    const size = options.size ?? 10;
    const pouzity = options.bold ? font.bold : font.regular;
    page.drawText(
      options.maxWidth ? fit(value, pouzity, size, options.maxWidth) : value,
      {
        x: options.x ?? MARGIN,
        y,
        size,
        font: pouzity,
        color: options.color ?? TEXT,
      },
    );
  };

  const nadpis = (value: string) => {
    misto(40);
    y -= 22;
    text(value, { size: 13, bold: true });
    y -= 8;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.75,
      color: RULE,
    });
    y -= 14;
  };

  // ── Hlavička ────────────────────────────────────────────────────
  if (images.logo) {
    try {
      const embedded = await (images.logo[0] === 0x89
        ? doc.embedPng(images.logo)
        : doc.embedJpg(images.logo));
      const scale = Math.min(120 / embedded.width, 40 / embedded.height);
      page.drawImage(embedded, {
        x: MARGIN,
        y: y - embedded.height * scale,
        width: embedded.width * scale,
        height: embedded.height * scale,
      });
      y -= embedded.height * scale + 14;
    } catch {
      // Logo je ozdoba. Report kvůli němu nepadá.
    }
  }

  y -= 18;
  text("Měsíční report ostrahy", { size: 20, bold: true });
  y -= 16;
  text(`${report.site.name} · ${report.period.label}`, { size: 11, color: MUTED });
  if (report.client.companyName) {
    y -= 13;
    text(report.client.companyName, { size: 10, color: MUTED });
  }
  y -= 6;

  // ── Souhrn ──────────────────────────────────────────────────────
  nadpis("Souhrn");

  const bunky: [string, string][] = [
    ["Detekcí", String(report.summary.detections)],
    ["Zásahů", String(report.summary.dispatches)],
    ["Letů", String(report.summary.flights)],
    ["Nalétaných minut", String(report.summary.flightMinutes)],
    ["Potvrzených nálezů", String(report.summary.threats)],
  ];

  misto(56);
  const sirka = CONTENT_W / bunky.length;
  for (const [index, [popisek, hodnota]] of bunky.entries()) {
    const x = MARGIN + index * sirka;
    page.drawText(popisek.toUpperCase(), {
      x,
      y: y - 2,
      size: 7,
      font: font.regular,
      color: MUTED,
    });
    page.drawText(hodnota, {
      x,
      y: y - 24,
      size: 18,
      font: font.bold,
      // Nález je jediné číslo, které se zvýrazňuje: znamená, že na
      // pozemku někdo byl.
      color: popisek === "Potvrzených nálezů" && report.summary.threats > 0 ? DANGER : TEXT,
    });
  }
  y -= 40;

  // ── Graf detekcí ────────────────────────────────────────────────
  nadpis("Detekce po dnech");
  y = kresliGraf(page, font, y, report.detectionsByDay);

  // ── Zásahy ──────────────────────────────────────────────────────
  nadpis("Zásahy podle výsledku");
  if (report.dispatchOutcomes.length === 0) {
    text("Za tenhle měsíc nevznikl žádný zásah.", { size: 10, color: MUTED });
    y -= 16;
  } else {
    for (const row of report.dispatchOutcomes) {
      misto(18);
      const barva =
        row.outcome === "sent"
          ? SUCCESS
          : row.outcome === "failed"
            ? DANGER
            : row.outcome === "suppressed_unknown"
              ? WARNING
              : MUTED;
      text(DISPATCH_OUTCOME_LABELS[row.outcome], { size: 10, color: barva, maxWidth: 380 });
      page.drawText(String(row.count), {
        x: PAGE_W - MARGIN - font.bold.widthOfTextAtSize(String(row.count), 10),
        y,
        size: 10,
        font: font.bold,
        color: TEXT,
      });
      y -= 16;
    }
  }

  // ── Nálezy ──────────────────────────────────────────────────────
  nadpis("Potvrzené nálezy");
  if (report.threats.length === 0) {
    text("Model na snímcích z letů nikoho nenašel.", { size: 10, color: MUTED });
    y -= 16;
  } else {
    const zobrazeno = report.threats.slice(0, MAX_THREAT_ROWS);
    for (const [index, threat] of zobrazeno.entries()) {
      misto(64);
      const bytes = images.threats[index] ?? null;
      const top = y;

      if (bytes) {
        try {
          const embedded = await doc.embedJpg(bytes);
          const scale = Math.min(96 / embedded.width, 54 / embedded.height);
          page.drawImage(embedded, {
            x: PAGE_W - MARGIN - embedded.width * scale,
            y: top - embedded.height * scale + 8,
            width: embedded.width * scale,
            height: embedded.height * scale,
          });
        } catch {
          // Poškozený snímek nesmí shodit celý report.
        }
      }

      text(threat.at ? CAS.format(new Date(threat.at)) : "Bez času", {
        size: 10,
        bold: true,
        maxWidth: 380,
      });
      y -= 14;
      text(threat.zoneName ?? "Zóna neuvedena", { size: 9, color: MUTED, maxWidth: 380 });
      if (threat.note) {
        y -= 12;
        text(threat.note, { size: 9, color: MUTED, maxWidth: 380 });
      }
      y -= 26;
      page.drawLine({
        start: { x: MARGIN, y: y + 8 },
        end: { x: PAGE_W - MARGIN, y: y + 8 },
        thickness: 0.5,
        color: RULE,
      });
    }

    const vynechano = report.threats.length - zobrazeno.length;
    if (vynechano > 0) {
      misto(20);
      text(
        `Do reportu se vešlo ${zobrazeno.length} nálezů z ${report.threats.length}; zbylých ${vynechano} najdete v portálu.`,
        { size: 9, color: WARNING, maxWidth: CONTENT_W },
      );
      y -= 16;
    }
  }

  // ── Vjezdy ──────────────────────────────────────────────────────
  nadpis("Vjezdy");
  const vjezdy: [string, number][] = [
    ["Celkem vozidel", report.passages.total],
    ["Z toho ohlášených předem", report.passages.announced],
    ["Z toho s neznámou značkou", report.passages.unknownPlates],
  ];
  for (const [popisek, hodnota] of vjezdy) {
    misto(18);
    text(popisek, { size: 10, color: MUTED });
    page.drawText(String(hodnota), {
      x: PAGE_W - MARGIN - font.bold.widthOfTextAtSize(String(hodnota), 10),
      y,
      size: 10,
      font: font.bold,
      color: TEXT,
    });
    y -= 16;
  }

  // ── Provoz (jen admin) ──────────────────────────────────────────
  if (report.operations) {
    nadpis("Provoz systému");

    const dostupnost =
      report.operations.availability === null
        ? "neměřeno"
        : `${Math.round(report.operations.availability * 100)} %`;
    text("Dostupnost automatiky", { size: 10, color: MUTED });
    page.drawText(dostupnost, {
      x: PAGE_W - MARGIN - font.bold.widthOfTextAtSize(dostupnost, 10),
      y,
      size: 10,
      font: font.bold,
      color:
        (report.operations.availability ?? 1) < 0.9 ? WARNING : SUCCESS,
    });
    y -= 14;
    text(
      "Podíl skutečných běhů plánovače k očekávaným. Nižší číslo znamená, že cron nejel, ne že se něco stalo v areálu.",
      { size: 8, color: MUTED, maxWidth: CONTENT_W },
    );
    y -= 20;

    for (const job of report.operations.cronRuns) {
      misto(16);
      text(job.label, { size: 9, color: MUTED, maxWidth: 380 });
      const hodnota = `${job.runs} / ${job.expected}`;
      page.drawText(hodnota, {
        x: PAGE_W - MARGIN - font.regular.widthOfTextAtSize(hodnota, 9),
        y,
        size: 9,
        font: font.regular,
        color: TEXT,
      });
      y -= 14;
    }

    y -= 6;
    misto(20);
    text(`Přeskočených hlídek: ${report.operations.skippedPatrols}`, {
      size: 10,
      bold: true,
    });
    y -= 16;

    if (report.operations.skipReasons.length === 0) {
      text(
        report.operations.skippedPatrols > 0
          ? "Důvody se u těchhle běhů ještě nezaznamenávaly."
          : "Žádná hlídka se nepřeskočila.",
        { size: 9, color: MUTED, maxWidth: CONTENT_W },
      );
      y -= 14;
    } else {
      for (const row of report.operations.skipReasons) {
        misto(16);
        text(SKIP_REASON_LABELS[row.reason] ?? row.reason, {
          size: 9,
          color: MUTED,
          maxWidth: 380,
        });
        page.drawText(String(row.count), {
          x: PAGE_W - MARGIN - font.regular.widthOfTextAtSize(String(row.count), 9),
          y,
          size: 9,
          font: font.regular,
          color: TEXT,
        });
        y -= 14;
      }
    }
  }

  // ── Patička na každou stranu ────────────────────────────────────
  const stran = doc.getPageCount();
  for (const [index, strana] of doc.getPages().entries()) {
    strana.drawText(
      `Sky Guard · ${report.site.name} · ${report.period.label} · strana ${index + 1}/${stran}`,
      {
        x: MARGIN,
        y: MARGIN - 18,
        size: 7,
        font: font.regular,
        color: MUTED,
      },
    );
  }

  return doc.save();
}

/**
 * Sloupcový graf detekcí po dnech.
 *
 * Kreslí se obdélníky, ne knihovnou: je to jedna série a závislost na
 * grafické knihovně by kvůli ní přibyla do celého balíku.
 */
function kresliGraf(
  page: PDFPage,
  font: Fonts,
  yStart: number,
  values: number[],
): number {
  const H = 90;
  const y0 = yStart - H;
  const max = Math.max(1, ...values);
  const krok = CONTENT_W / values.length;
  const sirkaSloupce = Math.max(2, krok - 2);

  // Základna a popisek maxima, ať jde graf vůbec číst.
  page.drawLine({
    start: { x: MARGIN, y: y0 },
    end: { x: PAGE_W - MARGIN, y: y0 },
    thickness: 0.75,
    color: RULE,
  });
  page.drawText(String(max), {
    x: MARGIN,
    y: yStart - 8,
    size: 7,
    font: font.regular,
    color: MUTED,
  });

  for (const [index, value] of values.entries()) {
    if (value <= 0) continue;
    const vyska = Math.max(1, (value / max) * (H - 12));
    page.drawRectangle({
      x: MARGIN + index * krok,
      y: y0,
      width: sirkaSloupce,
      height: vyska,
      color: ACCENT,
    });
  }

  // Popisky dnů po pěti; každý den by se slil.
  for (let den = 1; den <= values.length; den += 5) {
    page.drawText(String(den), {
      x: MARGIN + (den - 1) * krok,
      y: y0 - 10,
      size: 7,
      font: font.regular,
      color: MUTED,
    });
  }

  return y0 - 20;
}

export { THUMB_W };
