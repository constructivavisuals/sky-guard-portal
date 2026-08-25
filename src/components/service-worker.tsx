"use client";

import { useEffect } from "react";

/**
 * Registrace service workeru. Jen zapíná offline fallback — cachování
 * dat záměrně nedělá, viz public/sw.js.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Registrace až po načtení, ať nesoupeří o pásmo s první stránkou.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("Registrace service workeru selhala", error);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
