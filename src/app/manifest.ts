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
    // Zamyká orientaci jen tam, kde to prohlížeč umí — tedy na
    // Androidu. iOS pole `orientation` IGNORUJE i v aplikaci přidané
    // na plochu a webu žádné API na zamčení nedává; kdo to na iPhonu
    // chce, musí použít zámek otáčení v ovládacím centru.
    //
    // Proto má přehrávač na celou obrazovku vlastní tlačítko a
    // nespoléhá na otočení.
    orientation: "portrait",
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
