"use client";

import { useEffect } from "react";

// Srovnání okna po startu aplikace z plochy.
//
// ═══ Co se děje ════════════════════════════════════════════════════
// Po tvrdém startu z domovské obrazovky sedí spodní lišta výš, než má,
// a pod ní zbývá pruh pozadí. Přechod na jinou stránku a zpátky to
// srovná — a právě to je ta stopa: markup je v pořádku, špatně je
// OKNO, které iOS v tu chvíli hlásí.
//
// Než se uplatní `viewport-fit: cover`, je okno o bezpečnou zónu
// kratší. Lišta je připnutá k jeho spodku (`fixed bottom-0`), takže
// sedí výš. Jakmile cokoli vynutí přeuspořádání, iOS okno přeměří
// a lišta padne, kam patří — přesně to dělá i ta navigace.
//
// ═══ Proč to nejde vyřešit v CSS ═══════════════════════════════════
// Protože o rozměr okna se nepřeme s pravidlem, ale s tím, kdy si ho
// prohlížeč přečte. Žádná jednotka ani `env()` to neurychlí; je to
// otázka pořadí, ne hodnoty. Zkoušelo se `h-dvh` s pevnou výškou
// a bylo to horší: bez posouvání se to nemělo jak srovnat vůbec.
//
// ═══ Proč dvakrát přes rAF ═════════════════════════════════════════
// Změna a její vrácení musí padnout do dvou různých snímků, jinak je
// prohlížeč slije do jednoho a přeuspořádání se nekoná. Sahá se jen
// na `min-height` těla, tedy na vlastnost, která na vzhledu nic
// nemění — po druhém snímku je stav přesně takový jako předtím.
export function SrovnatOkno() {
  useEffect(() => {
    const prvni = requestAnimationFrame(() => {
      document.body.style.minHeight = "100.01dvh";
      requestAnimationFrame(() => {
        document.body.style.minHeight = "";
      });
    });
    return () => cancelAnimationFrame(prvni);
  }, []);

  return null;
}
