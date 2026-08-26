// Potvrzení nebezpečí z fotek letu.
//
// Po dokončení letu se fotky pošlou modelu s jedinou otázkou: je na
// nich člověk nebo vozidlo? Odpověď doplňuje to, co hlásila kamera —
// ta viděla pohyb v jednom výřezu, dron obletěl celé místo.
//
// ═══ Nejistý výsledek je NULL, ne FALSE ════════════════════════════
// Tohle čte člověk, který se rozhoduje, jestli se jde podívat.
// „Model si myslí, že tam asi nikdo není“ vypadá na obrazovce stejně
// jako „prošel to a nic tam není“, ale znamená něco úplně jiného.
// Pod prahem jistoty se proto odpověď zahazuje — stejně jako u SPZ,
// kde nejistá značka nejde ani na porovnání se seznamem.
// ═══════════════════════════════════════════════════════════════════
//
// Volá se přes fetch, ne přes @anthropic-ai/sdk — stejný důvod jako
// u čtení značek.

const MODEL = "claude-haiku-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Jeden snímek, pár desítek znaků odpovědi. */
const TIMEOUT_MS = 25_000;

/** Pod tímhle prahem se odpověď bere jako nejistá. Jako u SPZ. */
export const THREAT_CONFIDENCE_MIN = 0.7;

/**
 * Kolik fotek z letu se posílá.
 *
 * Strop je kvůli ceně a času — jeden let umí nasypat stovky snímků
 * a rozhodnutí „někdo tam je“ padne na prvním. Co se nevešlo, se
 * zaloguje: tiché useknutí by vypadalo jako „prošli jsme všechno“.
 */
export const MAX_THREAT_PHOTOS = 8;

/**
 * Strop na jeden snímek. Anthropic API bere obrázky do 5 MB; větší
 * se přeskočí a zaloguje, protože zmenšit ho tady nemáme čím.
 */
export const MAX_THREAT_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ThreatReading {
  /** Je na snímku člověk nebo vozidlo? null = model si není jistý. */
  threat: boolean | null;
  /** Co model viděl, česky. Prázdné, když nic neřekl. */
  note: string | null;
  /** Jistota 0–1, nebo null. */
  confidence: number | null;
}

const SYSTEM_PROMPT = `Jsi systém pro kontrolu snímků z bezpečnostního dronu.

Dostaneš snímek pořízený dronem nad areálem, který hlídá perimetr.
Tvůj jediný úkol je odpovědět, jestli je na snímku ČLOVĚK nebo VOZIDLO.

Odpověz VÝHRADNĚ validním JSON objektem bez markdown bloků a bez komentářů.

Schema (všechny klíče povinné):
{
  "threat": boolean,     // true = na snímku je člověk nebo vozidlo, false = není
  "note": string,        // stručně česky, co vidíš. Max 120 znaků.
  "confidence": number   // 0.0-1.0, jak jistý si odpovědí jsi
}

Pravidla:
- Nehádej. Když je snímek rozmazaný, tmavý, zakrytý nebo si nejsi jistý, dej nízkou confidence. Neodhaduj podle toho, jak podobné snímky obvykle vypadají.
- Vozidlo je auto, dodávka, nákladní auto, motorka, traktor, stavební stroj. Zaparkované vozidlo je taky vozidlo.
- Člověk se počítá i částečně viditelný nebo v odrazu.
- Zvíře, stín, keř ani sloup nejsou člověk ani vozidlo.
- Vracej POUZE JSON, nic jiného.`;

/**
 * Rozebere odpověď modelu.
 *
 * Vystavené kvůli testům — chování na pokažené odpovědi je to
 * podstatné a volat kvůli němu API by test udělalo pomalým.
 *
 * Jistota pod prahem sráží `threat` na null už tady, aby se nikde
 * dál nedalo omylem sáhnout na nejistou hodnotu jako na výsledek.
 */
export function parseThreatReading(text: string): ThreatReading | null {
  try {
    const clean = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed: unknown = JSON.parse(clean);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const raw = parsed as { threat?: unknown; note?: unknown; confidence?: unknown };

    // Cokoli jiného než boolean je rozbitá odpověď, ne „ne“.
    const threat = typeof raw.threat === "boolean" ? raw.threat : null;
    if (threat === null) return null;

    const cislo = Number(raw.confidence);
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(cislo)
        ? Math.min(1, Math.max(0, cislo))
        : null;

    const note =
      typeof raw.note === "string" && raw.note.trim() !== ""
        ? raw.note.trim().slice(0, 200)
        : null;

    // Bez jistoty se odpověď nedá vážit, takže platí totéž co pod prahem.
    const jisty = confidence !== null && confidence >= THREAT_CONFIDENCE_MIN;

    return { threat: jisty ? threat : null, note, confidence };
  } catch {
    return null;
  }
}

export interface ThreatVerdict {
  confirmed: boolean | null;
  note: string;
}

/**
 * Souhrn přes všechny snímky z letu.
 *
 * Pravidla, v tomhle pořadí:
 *
 *   1. Stačí JEDEN jistý nález a je potvrzeno. Dron obletí místo
 *      z různých úhlů; že člověk není vidět na šesti snímcích ze
 *      sedmi, o ničem nesvědčí.
 *   2. Bez nálezu je „nic tam není“ jen tehdy, když se PODAŘILO
 *      přečíst všechny snímky. Jediný nejistý stačí na null —
 *      nepřečtený snímek je přesně to místo, kde by ten člověk mohl
 *      být.
 *   3. Bez snímků není co tvrdit.
 */
export function combineThreatReadings(
  readings: readonly ThreatReading[],
  options: { skipped?: number } = {},
): ThreatVerdict {
  const skipped = options.skipped ?? 0;
  const nalezy = readings.filter((r) => r.threat === true);
  const ciste = readings.filter((r) => r.threat === false);
  const nejiste = readings.filter((r) => r.threat === null).length + skipped;

  if (nalezy.length > 0) {
    const co = nalezy
      .map((r) => r.note)
      .filter((note): note is string => note !== null);
    const uvod = `Model našel člověka nebo vozidlo na ${nalezy.length} z ${
      readings.length + skipped
    } snímků.`;
    return { confirmed: true, note: co.length > 0 ? `${uvod} ${co[0]}` : uvod };
  }

  if (ciste.length === 0) {
    return {
      confirmed: null,
      note:
        readings.length + skipped === 0
          ? "Z letu nejsou žádné fotky, nebylo co kontrolovat."
          : "Žádný snímek se nepodařilo spolehlivě přečíst.",
    };
  }

  if (nejiste > 0) {
    return {
      confirmed: null,
      note: `Na ${ciste.length} snímcích nic není, ale ${nejiste} se nepodařilo spolehlivě přečíst.`,
    };
  }

  return {
    confirmed: false,
    note: `Na ${ciste.length} snímcích z letu není člověk ani vozidlo.`,
  };
}

/**
 * Je čtení snímků vůbec nastavené?
 *
 * Chybějící klíč není selhání běhu, ale konfigurace. Bez tohohle
 * rozlišení by cron hlásil chybu při každém spuštění, dokud klíč
 * někdo nedoplní — a `curl -f` by to poslal mailem pokaždé.
 */
export function threatCheckConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Zeptá se modelu na jeden snímek.
 *
 * Vrací null, když volání selhalo (chybí klíč, chyba API, nečitelná
 * odpověď). To je něco jiného než odpověď „nevím“ — obojí sice končí
 * jako nejistý snímek, ale do logu patří rozdílně.
 */
export async function readThreatFromImage(
  image: { base64: string; mediaType: string },
): Promise<ThreatReading | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY chybí — kontrola snímků se přeskakuje");
    return null;
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mediaType,
                  data: image.base64,
                },
              },
              {
                type: "text",
                text: "Je na snímku člověk nebo vozidlo? Vrať JSON podle schématu.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      // Tělo chyby se neloguje celé — může nést kus odeslaného obsahu.
      console.error("Kontrola snímku: API vrátilo", response.status);
      return null;
    }

    const data: unknown = await response.json();
    const content = (data as { content?: { type: string; text?: string }[] }).content;
    const block = content?.find((c) => c.type === "text");
    if (!block?.text) return null;

    return parseThreatReading(block.text);
  } catch (error) {
    console.error("Kontrola snímku selhala", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
