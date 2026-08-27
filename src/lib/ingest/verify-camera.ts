import { cameraKeyFingerprint, deriveCameraKey } from "./camera-key.ts";
import type { IngestCameraRow } from "./camera-lookup.ts";
import {
  verifySignature,
  type SignatureFailure,
  type SignatureResult,
} from "./signature.ts";

// Ověření podpisu proti klíči kamery. Sdílené oběma ingest cestami —
// detekce i vjezd se podepisují stejně a dvě kopie téhle úvahy by se
// při první změně rozešly.
//
// ═══ Dvě tajemství při rotaci ══════════════════════════════════════
// Klíč každé kamery se odvozuje z INGEST_SECRET. Kdyby se ověřovalo
// jen proti jedné hodnotě, výměna tajemství by naráz zneplatnila klíče
// VŠECH kamer — a než by je někdo objel a přehrál, ingest by nepřijal
// jedinou detekci. Nepoznalo by se to: kamera zmlkne stejně, jako když
// jí někdo utrhne kabel.
//
// Zkouší se proto v pořadí nové → předchozí. Kamera, která už je
// přepnutá, projde na první pokus; ta, na kterou ještě nikdo nesáhl,
// projde na druhý a zaloguje se — z logu je pak vidět, kolik jich
// zbývá.
//
// ═══ Za FTP kameru mluví relay ═════════════════════════════════════
// Stavební kamera se nepodepisuje: neumí to. Události z ní přeposílá
// relay na VPS, který drží vlastní RELAY_SECRET a kameru pojmenuje
// sériovým číslem v těle.
//
// Rozhoduje o tom `ingest_mode` v databázi, ne hlavička požadavku.
// Kdyby si volající směl vybrat, kterým tajemstvím se ověří, stačila
// by kompromitace VPS k podvržení detekce z LIBOVOLNÉ kamery
// v portálu — včetně těch u brány, na které visí otevírání závory.
// Kamera, která se umí podepsat sama, si relay mluvit za sebe nenechá;
// je to táž hranice jako u ohlášení záznamu.
// ═══════════════════════════════════════════════════════════════════

/**
 * Výsledek ověření.
 *
 * `usedPrevious` je tu jen u úspěchu: znamená, že podpis sedl až proti
 * PŘEDCHOZÍMU tajemství, tedy že kamera ještě čeká na přehrání.
 */
export type CameraVerification =
  | { valid: true; usedPrevious: boolean; actor: VerifiedActor }
  | { valid: false; reason: SignatureFailure };

/**
 * Čím byl požadavek podepsaný. Jde to do `detections.ingest_key_id`,
 * takže po rotaci klíčů je z evidence vidět, co ještě jede na čem.
 */
export type VerifiedActor = "camera" | "shared" | "relay";

export function verifyForCamera(options: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now: Date;
  /** Nové tajemství první, předchozí druhé. Viz env.ingestSecrets(). */
  secrets: readonly string[];
  /**
   * Tajemství relaye, taky nové → předchozí. Prázdné pole = relay není
   * nastavený; FTP kamera pak neprojde. To je správně: bez tajemství
   * není čím ověřit, a přijmout to bez ověření by znamenalo otevřený
   * endpoint.
   */
  relaySecrets?: readonly string[];
  camera: IngestCameraRow | null;
}): CameraVerification {
  const { rawBody, signature, timestamp, now, secrets, camera } = options;
  const base = { rawBody, signature, timestamp, now };

  // ── FTP kamera: podepisuje se relay ──────────────────────────────
  if (camera?.ingest_mode === "ftp") {
    const relay = options.relaySecrets ?? [];
    if (relay.length === 0) {
      console.error("FTP kamera hlásí, ale RELAY_SECRET není nastavený", {
        camera_id: camera.id,
        site_id: camera.site_id,
      });
      return { valid: false, reason: "signature_mismatch" };
    }

    let posledniRelay: SignatureResult = {
      valid: false,
      reason: "signature_mismatch",
    };
    for (const [index, secret] of relay.entries()) {
      const result = verifySignature({ ...base, secret });
      if (result.valid) {
        if (index > 0) {
          console.warn("Relay jede na PŘEDCHOZÍM tajemství — čeká na přepnutí", {
            camera_id: camera.id,
            site_id: camera.site_id,
          });
        }
        return { valid: true, usedPrevious: index > 0, actor: "relay" };
      }
      posledniRelay = result;
    }
    return posledniRelay;
  }

  const serial = camera?.serial_number;
  /** Kamera bez otisku se ověřuje společným tajemstvím — jako dřív. */
  const spolecne = !camera || !camera.ingest_secret_hash || !serial;

  if (camera && spolecne) {
    // Loguje se, aby bylo vidět, které kamery ještě čekají na vlastní
    // klíč — bez toho by se na ně při rotaci zapomnělo.
    console.warn("Kamera se podepisuje společným INGEST_SECRET", {
      camera_id: camera.id,
      site_id: camera.site_id,
    });
  }

  /** Poslední důvod selhání. Bez tajemství by se nevrátil žádný. */
  let posledni: SignatureResult = { valid: false, reason: "signature_mismatch" };
  /** Sedl otisk aspoň u jednoho tajemství? Rozlišuje dvě různé závady. */
  let otiskSedl = false;

  for (const [index, secret] of secrets.entries()) {
    const previous = index > 0;

    if (spolecne) {
      const result = verifySignature({ ...base, secret });
      if (result.valid) return { valid: true, usedPrevious: previous, actor: "shared" };
      posledni = result;
      continue;
    }

    let derived: string;
    try {
      derived = deriveCameraKey(secret, serial as string, camera!.ingest_key_version);
    } catch (error) {
      // Vadné sériové číslo nebo verze — na jiném tajemství to nebude
      // lepší, ale zkusit ho nic nestojí.
      console.error("Klíč kamery nejde odvodit", {
        camera_id: camera!.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Otisk nesedí = tímhle tajemstvím se kamera nezakládala. Není to
    // závada, jen špatná polovina rotace — zkouší se další.
    if (cameraKeyFingerprint(derived) !== camera!.ingest_secret_hash) continue;

    otiskSedl = true;
    const result = verifySignature({ ...base, secret: derived });
    if (result.valid) {
      if (previous) {
        // Tohle je ta věta, kvůli které rotace nekončí poslepu.
        console.warn("Kamera jede na PŘEDCHOZÍM tajemství — čeká na přehrání", {
          camera_id: camera!.id,
          site_id: camera!.site_id,
          serial,
        });
      }
      return { valid: true, usedPrevious: previous, actor: "camera" };
    }
    posledni = result;
  }

  if (!spolecne && !otiskSedl) {
    // Uložený otisk nepatří ke klíči odvozenému ze žádného tajemství,
    // které známe. Typicky rotace hlavního tajemství bez přegenerování
    // kamer — a bez tohohle hlášení by kamera jen tiše přestala hlásit.
    console.error("Otisk klíče kamery nesedí na žádné známé tajemství", {
      camera_id: camera?.id,
      key_version: camera?.ingest_key_version,
    });
    return { valid: false, reason: "signature_mismatch" };
  }

  return posledni;
}
