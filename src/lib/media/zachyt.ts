// Vyfocení snímku a natočení klipu z běžícího obrazu.
//
// ═══ Co který prohlížeč umí ════════════════════════════════════════
// Snímek umí každý: `<video>` se vykreslí do plátna a z něj vypadne
// JPEG. Nahrávání potřebuje `captureStream()` a `MediaRecorder`, které
// Safari na iOS nemá.
//
// Proto se schopnosti ZJIŠŤUJÍ a tlačítko, které by na daném zařízení
// nefungovalo, se vůbec nenabídne. Mrtvé tlačítko je horší než
// chybějící: člověk ho zmáčkne, nic se nestane a hledá chybu u sebe.
//
// ═══ Kam se soubor uloží ═══════════════════════════════════════════
// Přes systémový dialog sdílení (`navigator.share`), když je
// k dispozici — na iPhonu je to jediná cesta, jak se dostat do Fotek.
// Jinak se soubor stáhne odkazem, což je chování stolního prohlížeče.

/** Umí tenhle prohlížeč natočit klip z běžícího obrazu? */
export function umiNahravat(): boolean {
  if (typeof window === "undefined") return false;
  const video = document.createElement("video") as HTMLVideoElement & {
    captureStream?: () => MediaStream;
  };
  return (
    typeof window.MediaRecorder === "function" &&
    typeof video.captureStream === "function"
  );
}

/** Umí prohlížeč nabídnout systémové sdílení souboru? */
export function umiSdilet(soubor: File): boolean {
  if (typeof navigator === "undefined" || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [soubor] });
  } catch {
    return false;
  }
}

/**
 * Uloží soubor tak, jak to na daném zařízení jde.
 *
 * Na telefonu systémovým dialogem — jinak by snímek skončil v Souborech
 * a ne ve Fotkách, kde ho člověk hledá. Na stolním prohlížeči odkazem.
 */
export async function uloz(soubor: File): Promise<void> {
  if (umiSdilet(soubor)) {
    try {
      await navigator.share({ files: [soubor] });
      return;
    } catch (chyba) {
      // Zrušený dialog není závada; při čemkoli jiném se zkusí stažení.
      if (chyba instanceof DOMException && chyba.name === "AbortError") return;
    }
  }

  const adresa = URL.createObjectURL(soubor);
  const odkaz = document.createElement("a");
  odkaz.href = adresa;
  odkaz.download = soubor.name;
  odkaz.click();
  // Až po kliknutí, jinak si prohlížeč nestihne soubor převzít.
  setTimeout(() => URL.revokeObjectURL(adresa), 10_000);
}

/** Jméno souboru z názvu kamery a času — ať se dá v galerii najít. */
export function jmenoSouboru(
  kamera: string,
  pripona: string,
  kdy = new Date(),
): string {
  const dv = (n: number) => String(n).padStart(2, "0");
  const razitko =
    `${kdy.getFullYear()}${dv(kdy.getMonth() + 1)}${dv(kdy.getDate())}` +
    `-${dv(kdy.getHours())}${dv(kdy.getMinutes())}${dv(kdy.getSeconds())}`;
  const ocistene = kamera.replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return `${ocistene || "kamera"}-${razitko}.${pripona}`;
}

/**
 * Vyfotí aktuální snímek.
 *
 * Kreslí se v NATIVNÍM rozlišení proudu, ne v tom, jak je video velké
 * na obrazovce — jinak by snímek z telefonu měl 390 pixelů na šířku
 * a byl by k ničemu jako důkaz.
 */
export async function vyfot(
  video: HTMLVideoElement,
  kamera: string,
): Promise<void> {
  const sirka = video.videoWidth;
  const vyska = video.videoHeight;
  if (!sirka || !vyska) throw new Error("Obraz ještě neběží.");

  const platno = document.createElement("canvas");
  platno.width = sirka;
  platno.height = vyska;
  const ctx = platno.getContext("2d");
  if (!ctx) throw new Error("Plátno se nepodařilo připravit.");
  ctx.drawImage(video, 0, 0, sirka, vyska);

  const blob = await new Promise<Blob | null>((hotovo) =>
    platno.toBlob(hotovo, "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Snímek se nepodařilo uložit.");

  await uloz(new File([blob], jmenoSouboru(kamera, "jpg"), { type: "image/jpeg" }));
}

/** Běžící nahrávání. `stop()` klip uzavře a nabídne k uložení. */
export interface Nahravani {
  stop: () => void;
}

/**
 * Začne nahrávat, co je na obraze.
 *
 * Bere proud z `<video>`, ne ze sítě: nahraje se přesně to, co divák
 * vidí, a nemusí se kvůli tomu otevírat druhé spojení na kameru.
 */
export function zacniNahravat(
  video: HTMLVideoElement,
  kamera: string,
  hotovo: (chyba?: Error) => void,
): Nahravani {
  const prvek = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
  };
  if (!prvek.captureStream) throw new Error("Tenhle prohlížeč nahrávat neumí.");

  const proud = prvek.captureStream();
  // Typ se vybírá podle toho, co prohlížeč přijme; prázdný řetězec
  // znamená „vyber si sám" a je to poslední záchrana.
  const typ =
    ["video/mp4", "video/webm;codecs=h264", "video/webm"].find((t) =>
      window.MediaRecorder.isTypeSupported?.(t),
    ) ?? "";

  const rekorder = new MediaRecorder(proud, typ ? { mimeType: typ } : undefined);
  const kusy: Blob[] = [];
  rekorder.ondataavailable = (e) => {
    if (e.data.size > 0) kusy.push(e.data);
  };
  rekorder.onstop = () => {
    const mime = rekorder.mimeType || "video/mp4";
    const pripona = mime.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(kusy, { type: mime });
    uloz(new File([blob], jmenoSouboru(kamera, pripona), { type: mime }))
      .then(() => hotovo())
      .catch((chyba) => hotovo(chyba as Error));
  };
  rekorder.onerror = () => hotovo(new Error("Nahrávání selhalo."));
  rekorder.start();

  return {
    stop: () => {
      if (rekorder.state !== "inactive") rekorder.stop();
    },
  };
}
