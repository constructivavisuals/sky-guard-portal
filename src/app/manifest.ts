import type { MetadataRoute } from "next";

// Manifest pro přidání na plochu. Next ho servíruje na
// /manifest.webmanifest a odkaz do <head> doplní sám.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sky Guard Hub",
    short_name: "Sky Guard",
    description: "Perimetrická ochrana dronem",
    lang: "cs",
    display: "standalone",
    // ═══ Orientace se NEZAMYKÁ ═══════════════════════════════════
    // Bývalo tu `portrait` a Android to u aplikace přidané na plochu
    // bere doslova: okno se neotočilo NIKDE, ani na stránce kamery.
    // Obraz tedy nešel roztáhnout otočením telefonu — a otočit telefon
    // je to první, co u videa každý zkusí.
    //
    // Na iPhonu se to neprojevilo: iOS pole `orientation` ignoruje.
    // Rozdíl mezi telefony pak vypadá jako vada kamery nebo Androidu,
    // a hledá se kdekoli jinde než v manifestu.
    //
    // Zamknout to zpátky nejde bez toho, aby se rozbilo otáčení
    // v přehrávači: `screen.orientation.unlock()` vrací orientaci na
    // tu z manifestu, takže ji stránka sama neobejde.
    //
    // Cena je, že se na Androidu otočí i ostatní stránky. Ty to
    // snesou — rozvržení je responzivní a telefon naležato je pro ně
    // totéž co úzké okno.
    //
    // Tlačítko na celou obrazovku v přehrávači zůstává: kdo má zamčené
    // otáčení v systému, otočením si obraz nezvětší — a na iPhonu se
    // takový zámek ze stránky obejít nedá vůbec.
    orientation: "any",
    theme_color: "#08090C",
    background_color: "#08090C",
    // Po spuštění z plochy nemá smysl začínat na rozcestníku —
    // nepřihlášeného stejně middleware pošle na /login.
    start_url: "/prehled",
    scope: "/",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Maskable má značku uvnitř bezpečné zóny, aby ji ořez do
      // kolečka nebo kapky nezakrojil.
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
