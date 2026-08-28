// Operace nad S3 kompatibilním úložištěm: velikost a mazání.
//
// Odděleno od `s3.ts` schválně — tam je jen počítání podpisu, které jde
// otestovat proti zveřejněnému vektoru bez sítě. Tady se volá ven.

import { createHash } from "node:crypto";

import { objectUrl, signedHeaders, type S3Config } from "./s3.ts";

/** Kolik se čeká na úložiště. Je to server–server ve stejném datacentru. */
const TIMEOUT_MS = 20_000;

export class StorageError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "StorageError";
  }
}

async function call(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: abort, cache: "no-store" });
  } catch (caught) {
    throw new StorageError(
      caught instanceof Error ? caught.message : String(caught),
    );
  }
}

/**
 * Velikost objektu, nebo null když tam není.
 *
 * Rozdíl mezi „není“ a „nešlo se zeptat“ se nesmí slít: prvním se
 * potvrzení záznamu odmítne, druhé je výpadek a má se zkusit znovu.
 * Proto null jen u 404, jinak výjimka.
 */
export async function headObject(
  cfg: S3Config,
  key: string,
): Promise<{ size: number | null } | null> {
  const response = await call(objectUrl(cfg, key), {
    method: "HEAD",
    headers: signedHeaders(cfg, { method: "HEAD", key }),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new StorageError(`HEAD selhal: ${response.status}`, response.status);
  }

  const delka = response.headers.get("content-length");
  const velikost = delka === null ? null : Number(delka);
  return { size: Number.isFinite(velikost) ? velikost : null };
}

/** Escapování do XML. Klíč je z databáze, ale doslovné `&` by rozbilo tělo. */
function xml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!,
  );
}

/**
 * Smaže dávku objektů jedním voláním (DeleteObjects).
 *
 * Po jednom by to bylo 500 požadavků za běh retence a serverless
 * funkce má konečný čas. Vrací klíče, které úložiště odmítlo — ty se
 * NESMÍ v databázi označit za smazané, jinak by soubor zůstal ležet
 * a nikdo by o něm nevěděl.
 *
 * Chybějící objekt selhání NENÍ: S3 bere mazání jako idempotentní
 * a druhý pokus o týž klíč má projít.
 */
export async function deleteObjects(
  cfg: S3Config,
  keys: readonly string[],
): Promise<{ deleted: string[]; failed: string[] }> {
  if (keys.length === 0) return { deleted: [], failed: [] };

  const body = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      keys.map((k) => `<Object><Key>${xml(k)}</Key></Object>`).join("") +
      // Quiet: úložiště pak vrátí jen to, co NEšlo.
      "<Quiet>true</Quiet></Delete>",
    "utf8",
  );

  // Content-MD5 je u DeleteObjects povinný — bez něj vrací S3 400.
  const md5 = createHash("md5").update(body).digest("base64");

  const response = await call(objectUrl(cfg, "", "delete="), {
    method: "POST",
    body,
    headers: signedHeaders(cfg, {
      method: "POST",
      key: "",
      query: "delete=",
      body,
      extra: { "Content-MD5": md5, "Content-Type": "application/xml" },
    }),
  });

  if (!response.ok) {
    throw new StorageError(
      `mazání selhalo: ${response.status}`,
      response.status,
    );
  }

  // V Quiet režimu je v odpovědi jen <Error>. Parsovat celé XML kvůli
  // jednomu elementu by byla další závislost.
  const text = await response.text();
  const failed = [...text.matchAll(/<Error>[\s\S]*?<Key>([\s\S]*?)<\/Key>/g)].map(
    (m) => m[1],
  );
  const failedSet = new Set(failed);

  return {
    deleted: keys.filter((k) => !failedSet.has(k)),
    failed: keys.filter((k) => failedSet.has(k)),
  };
}
