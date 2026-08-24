import Image from "next/image";

import markWhite from "../../public/sky-guard-mark.png";
import logoWhite from "../../public/sky-guard-logo.png";

// Bílá varianta loga pro tmavé UI. Zdroj je rastr, ne vektor — import
// přes next/image drží rozměry i optimalizaci. Kdyby přišel originál
// v SVG, mění se jen tyhle dva importy.

/** Samotný znak (štít s rameny dronu) — pro úzká místa a dlaždice. */
export function DroneMark({ className = "" }: { className?: string }) {
  return (
    <Image
      src={markWhite}
      alt=""
      aria-hidden="true"
      priority
      className={`h-8 w-auto ${className}`}
    />
  );
}

/** Celá značka: znak + nápis SKY GUARD. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <Image
      src={logoWhite}
      alt="Sky Guard"
      priority
      className={`h-7 w-auto ${className}`}
    />
  );
}
