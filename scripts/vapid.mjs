#!/usr/bin/env node
// Vygeneruje dvojici VAPID klíčů pro push notifikace.
//
// Klíče se NIKAM nezapisují — ani do .env, ani do repozitáře. Skript je
// vypíše na obrazovku a zbytek je na člověku. Privátní klíč je jediná
// věc, kterou push služba (Google, Mozilla, Apple) používá k ověření,
// že notifikace opravdu posílá tenhle portál; kdyby se dostal do
// gitu, může komukoli s přihlášeným zařízením poslat cokoli.
//
// Bez závislosti na web-push schválně: je to dvacet řádků nad Web
// Crypto a skript má jít pustit i ve chvíli, kdy node_modules nejsou.
//
// Formát je daný RFC 8292 (VAPID) a Push API:
//   veřejný  — nekomprimovaný bod P-256, 65 bajtů, base64url
//              (tenhle tvar čeká applicationServerKey v prohlížeči)
//   privátní — samotné „d“ z JWK, 32 bajtů, base64url

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

const pair = await subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const jwk = await subtle.exportKey("jwk", pair.privateKey);

const publicKey = Buffer.from(raw).toString("base64url");
const privateKey = jwk.d;

// Pojistka proti tichému nesmyslu: nekomprimovaný bod začíná 0x04
// a má přesně 65 bajtů. Kratší klíč prohlížeč odmítne až při subscribe,
// tedy o dvě obrazovky později.
if (raw.length !== 65 || raw[0] !== 0x04) {
  console.error(`Veřejný klíč má ${raw.length} B, čekalo se 65. Nepoužívat.`);
  process.exit(1);
}

console.log(`
VAPID klíče vygenerovány. Zkopírujte je do prostředí (.env.local
lokálně, proměnné projektu na Vercelu). Nikam je necommitujte.

NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}

Veřejný klíč jde do prohlížeče, proto NEXT_PUBLIC_. Privátní zůstává
na serveru — kdyby unikl, může jménem portálu poslat notifikaci komukoli
s přihlášeným zařízením.

Až se klíče změní, přestanou platit VŠECHNY existující odběry: push
služba je váže na veřejný klíč, kterým byly založené. Uživatelé si
budou muset notifikace povolit znovu.
`);
