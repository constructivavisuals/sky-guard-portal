// PostgREST vrací sloupec geography jako hex EWKB ("0101000020E6100000…"),
// ne jako GeoJSON. Pro odeslání waypointu do FlightHubu z něj potřebujeme
// jen zeměpisnou šířku a délku, takže si Point rozebereme sami — je to
// pevný layout a ušetří to závislost na plnotučné geo knihovně.

export interface LatLon {
  latitude: number;
  longitude: number;
}

const WKB_POINT = 1;
const EWKB_SRID_FLAG = 0x20000000;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Rozebere hex EWKB bod na lat/lon. Vrací null pro cokoli, co není
 * validní 2D Point — volající to musí ošetřit, protože zóna bez
 * souřadnic znamená, že se nemá kam letět.
 */
export function parsePointEwkbHex(value: string | null): LatLon | null {
  if (!value) return null;

  const bytes = hexToBytes(value.trim());
  // Nejkratší platný Point: 1 + 4 + 8 + 8 bajtů (bez SRID).
  if (!bytes || bytes.length < 21) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = view.getUint8(0);
  if (byteOrder !== 0 && byteOrder !== 1) return null;
  const littleEndian = byteOrder === 1;

  const type = view.getUint32(1, littleEndian);
  if ((type & 0xff) !== WKB_POINT) return null;

  // Se SRID příznakem se před souřadnicemi čtou 4 bajty navíc.
  let offset = 5;
  if ((type & EWKB_SRID_FLAG) !== 0) {
    if (bytes.length < 25) return null;
    offset += 4;
  }

  if (bytes.length < offset + 16) return null;

  // PostGIS ukládá X = zeměpisná délka, Y = šířka.
  const longitude = view.getFloat64(offset, littleEndian);
  const latitude = view.getFloat64(offset + 8, littleEndian);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  return { latitude, longitude };
}
