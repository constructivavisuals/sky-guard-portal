// Podepisování požadavků do S3 kompatibilního úložiště (SigV4).
//
// ═══ Proč vlastní, a ne AWS SDK ════════════════════════════════════
// Potřebujeme čtyři operace: podepsat PUT, podepsat GET, zjistit
// velikost a smazat dávku. To je pár desítek řádků nad `node:crypto`
// proti závislosti, která do serverless funkce přitáhne megabajty
// a vlastní strom balíčků. Portál drží stejnou úvahu jako relay: co se
// neinstaluje, to se nedá kompromitovat skrz závislost.
//
// ═══ Co se podepisuje a co ne ══════════════════════════════════════
// Adresa pro relay se podepisuje QUERY parametry (presigned URL) —
// relay je hloupý klient, který umí jen PUT na adresu, a žádné
// hlavičky navíc počítat nemusí. Do `X-Amz-SignedHeaders` proto jde
// JEN `host`: kdyby se podepisoval i Content-Type, rozbil by podpis
// každý klient, který pošle hlavičku o znak jinak.
//
// Operace portálu (HEAD, DELETE) se naopak podepisují HLAVIČKOU —
// jsou to volání server–server, kde je adresa jedno a podpis nemá
// zůstávat v logu proxy.

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

/** Prázdné tělo. Konstanta z definice SHA-256, ne magické číslo. */
const PRAZDNE_TELO_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface S3Config {
  /** Bez schématu a bez lomítka, např. `fsn1.your-objectstorage.com`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /**
   * `https://endpoint/bucket/klíč` místo `https://bucket.endpoint/klíč`.
   *
   * Hetzner umí obojí; výchozí je virtual-hosted, protože ho mají
   * v dokumentaci a některé S3 klienty path-style už nepodporují.
   */
  pathStyle?: boolean;
}

/**
 * Kódování podle RFC 3986, jak ho žádá SigV4.
 *
 * `encodeURIComponent` nestačí: nechává `!'()*` nezakódované a S3 by
 * pak spočítalo jiný kanonický požadavek než my. Jede se po BAJTECH,
 * aby diakritika v názvu souboru vyšla stejně.
 */
function uriEncode(input: string, encodeSlash = true): string {
  let out = "";
  for (const b of Buffer.from(input, "utf8")) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += "/";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Časy v SigV4: `20260828T185700Z` a `20260828`. */
export function amzDates(now: Date): { amzDate: string; datum: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, datum: amzDate.slice(0, 8) };
}

/**
 * Podpisový klíč. Odvozuje se ze čtyř HMACů, ne přímo z tajemství —
 * výsledek platí jen pro jeden den, region a službu, takže uniklý
 * podpisový klíč je omezená škoda.
 */
function signingKey(secret: string, datum: string, region: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(datum).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(SERVICE).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

function host(cfg: S3Config): string {
  return cfg.pathStyle ? cfg.endpoint : `${cfg.bucket}.${cfg.endpoint}`;
}

/** Cesta v adrese. Lomítka v klíči zůstávají oddělovači, zbytek se kóduje. */
function canonicalUri(cfg: S3Config, key: string): string {
  const cesta = cfg.pathStyle ? `${cfg.bucket}/${key}` : key;
  return "/" + uriEncode(cesta.replace(/^\/+/, ""), false);
}

function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): string {
  return [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
}

/**
 * Adresa s podpisem v query parametrech.
 *
 * Používá se pro nahrávací adresu relaye (PUT) i pro přehrávání (GET).
 * Tělo se nepodepisuje (`UNSIGNED-PAYLOAD`) — u PUT ho v době
 * podepsání ještě neznáme a u GET žádné není.
 */
export function presignUrl(
  cfg: S3Config,
  options: {
    method: "PUT" | "GET";
    key: string;
    expiresIn: number;
    now?: Date;
  },
): string {
  const { amzDate, datum } = amzDates(options.now ?? new Date());
  const scope = `${datum}/${cfg.region}/${SERVICE}/aws4_request`;
  const uri = canonicalUri(cfg, options.key);

  // Query parametry musí být seřazené podle kódovaného názvu.
  const parametry: [string, string][] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${cfg.accessKey}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = parametry
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    uri,
    query,
    `host:${host(cfg)}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const podpis = createHmac("sha256", signingKey(cfg.secretKey, datum, cfg.region))
    .update(stringToSign(amzDate, scope, canonicalRequest))
    .digest("hex");

  return `https://${host(cfg)}${uri}?${query}&X-Amz-Signature=${podpis}`;
}

/**
 * Podepíše požadavek hlavičkou `Authorization`.
 *
 * Vrací hlavičky, ne hotový požadavek — volající si sám rozhodne
 * o timeoutu a o tom, co s odpovědí.
 */
export function signedHeaders(
  cfg: S3Config,
  options: {
    method: string;
    key: string;
    query?: string;
    body?: Buffer;
    extra?: Record<string, string>;
    now?: Date;
  },
): Record<string, string> {
  const { amzDate, datum } = amzDates(options.now ?? new Date());
  const scope = `${datum}/${cfg.region}/${SERVICE}/aws4_request`;
  const telo = options.body ?? Buffer.alloc(0);
  const otisk = options.body ? sha256hex(telo) : PRAZDNE_TELO_SHA256;

  const hlavicky: Record<string, string> = {
    host: host(cfg),
    "x-amz-content-sha256": otisk,
    "x-amz-date": amzDate,
    ...Object.fromEntries(
      Object.entries(options.extra ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  const razene = Object.keys(hlavicky).sort();
  const canonicalHeaders = razene.map((k) => `${k}:${hlavicky[k].trim()}\n`).join("");
  const signed = razene.join(";");

  const canonicalRequest = [
    options.method,
    canonicalUri(cfg, options.key),
    options.query ?? "",
    canonicalHeaders,
    signed,
    otisk,
  ].join("\n");

  const podpis = createHmac("sha256", signingKey(cfg.secretKey, datum, cfg.region))
    .update(stringToSign(amzDate, scope, canonicalRequest))
    .digest("hex");

  return {
    ...hlavicky,
    Authorization:
      `${ALGORITHM} Credential=${cfg.accessKey}/${scope}, ` +
      `SignedHeaders=${signed}, Signature=${podpis}`,
  };
}

export function objectUrl(cfg: S3Config, key: string, query = ""): string {
  return `https://${host(cfg)}${canonicalUri(cfg, key)}${query ? `?${query}` : ""}`;
}
