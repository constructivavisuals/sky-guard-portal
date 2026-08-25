import { normalizePlate } from "../plates.ts";

// Čtení SPZ ze snímku od brány.
//
// Systémový prompt je převzatý z constructiva-portal beze změny
// významu, včetně instrukce NEHÁDAT — nejistá značka je null, ne
// domyšlený český tvar. Je to jediné, co brání tomu, aby model
// „doplnil“ chybějící znak a vjezd se spároval s cizím autem.
//
// Volá se přes fetch, ne přes @anthropic-ai/sdk: kvůli jednomu
// požadavku by přibyla závislost i s celým jejím stromem. Tvar
// požadavku je stabilní veřejné API.

const MODEL = "claude-haiku-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Model odpovídá pár desítkami znaků; delší čekání nemá smysl. */
const TIMEOUT_MS = 20_000;

export interface PlateReading {
  /** Přečtená značka v porovnávacím tvaru, nebo null když čitelná není. */
  plate: string | null;
  /** Jistota modelu 0–1. Null, když značku nepřečetl. */
  confidence: number | null;
}

const SYSTEM_PROMPT = `Jsi systém pro čtení registračních značek (SPZ) z kamerových snímků.

Dostaneš snímek vozidla od kamery na bráně areálu.

Odpověz VÝHRADNĚ validním JSON objektem bez markdown bloků a bez komentářů.

Schema (všechny klíče povinné):
{
  "plate": string | null,  // SPZ velkými písmeny bez mezer a pomlček, např. "1AB2345". null, když není spolehlivě čitelná
  "confidence": number     // 0.0-1.0, jak jistý si čtením jsi. 0 když plate je null
}

Pravidla:
- Když SPZ nevidíš, je rozmazaná, oříznutá nebo si nejsi jistý každým znakem, vrať "plate": null. Nehádej.
- Nedoplňuj chybějící znaky a nedomýšlej formát podle toho, jak české SPZ vypadají.
- Když je čitelných vozidel víc, vrať to s nejlépe čitelnou značkou.
- Vracej POUZE JSON, nic jiného.`;

/**
 * Rozebere odpověď modelu.
 *
 * Vystavené kvůli testům: chování na pokažené odpovědi je to
 * podstatné, a volat kvůli němu API by test udělalo pomalým
 * a závislým na síti.
 */
export function parseReading(text: string): PlateReading | null {
  try {
    const clean = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed: unknown = JSON.parse(clean);
    // Pole je stejně rozbitá odpověď jako text — bez téhle větve by
    // z něj vyšlo „přečteno, ale nečitelné“, což je jiné tvrzení.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const raw = (parsed as { plate?: unknown }).plate;
    // Model má vracet porovnávací tvar, ale spoléhat se na to nebudeme —
    // projede se toutéž normalizací jako všechno ostatní.
    const plate = typeof raw === "string" ? normalizePlate(raw) : "";

    if (!plate) return { plate: null, confidence: null };

    const rawConfidence = Number(
      (parsed as { confidence?: unknown }).confidence,
    );
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : null;

    return { plate, confidence };
  } catch {
    return null;
  }
}

/**
 * Přečte značku ze snímku.
 *
 * Vrací null, jen když volání selhalo (chybí klíč, chyba API, nečitelná
 * odpověď). „Vozidlo tam je, ale značka čitelná není“ je regulérní
 * výsledek s plate: null, ne chyba — vjezd se v obou případech zapíše.
 */
export async function readPlateFromImage(
  image: { base64: string; mediaType: string },
): Promise<PlateReading | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY chybí — čtení značky se přeskakuje");
    return null;
  }

  const abort = AbortSignal.timeout(TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      signal: abort,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
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
              { type: "text", text: "Přečti SPZ vozidla a vrať JSON podle schématu." },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      // Tělo chyby se neloguje celé — může nést kus odeslaného obsahu.
      console.error("Čtení značky: API vrátilo", response.status);
      return null;
    }

    const data: unknown = await response.json();
    const content = (data as { content?: { type: string; text?: string }[] })
      .content;
    const block = content?.find((c) => c.type === "text");
    if (!block?.text) return null;

    return parseReading(block.text);
  } catch (error) {
    console.error("Čtení značky selhalo", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
