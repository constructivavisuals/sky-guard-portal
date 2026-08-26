"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { BellOff, BellRing, Smartphone } from "lucide-react";

import { Button } from "@/components/ui.tsx";
import { formatDateTime } from "@/lib/format.ts";
import { effectivePrefs, type EffectivePrefs } from "@/lib/push/rules.ts";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_COLUMNS,
  NOTIFICATION_KIND_HINTS,
  NOTIFICATION_KIND_LABELS,
} from "@/types/database.ts";

import {
  ulozitOdber,
  ulozitPredvolby,
  zrusitOdber,
  type PushActionResult,
} from "./actions.ts";

// Notifikace v nastavení.
//
// Celé je to klientské, protože bez `Notification`, `navigator` a
// `PushManager` se povolení ani odběr založit nedá. Server dodává jen
// veřejný klíč, seznam zařízení a uložené předvolby.

export interface DeviceRow {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface SiteOption {
  id: string;
  name: string;
  timezone: string;
}

/**
 * base64url → bajty pro applicationServerKey.
 *
 * Prohlížeč chce BufferSource, ne řetězec, a atob nezná `-` a `_`.
 */
function klicDoBajtu(base64url: string): Uint8Array {
  const doplnek = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + doplnek).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Hrubý název zařízení z user agenta. Přesnost tu nikdo nepotřebuje. */
function popisZarizeni(userAgent: string | null): string {
  if (!userAgent) return "Neznámé zařízení";
  const ua = userAgent;
  const system = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Macintosh/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "Neznámý systém";
  const prohlizec = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Prohlížeč";
  return `${prohlizec} · ${system}`;
}

type Stav =
  | "zjistuje"
  | "nepodporovano"
  | "zablokovano"
  | "vypnuto"
  | "zapnuto"
  | "pracuje";

export function NotificationSettings({
  vapidPublicKey,
  devices,
  sites,
  prefs,
}: {
  vapidPublicKey: string | null;
  devices: DeviceRow[];
  sites: SiteOption[];
  prefs: Record<string, EffectivePrefs>;
}) {
  const router = useRouter();
  const [stav, setStav] = useState<Stav>("zjistuje");
  const [chyba, setChyba] = useState<string | null>(null);
  const [tentoEndpoint, setTentoEndpoint] = useState<string | null>(null);

  // Zjištění stavu až po připojení: na serveru `Notification` není
  // a rozhodovat se podle něj při renderu by rozhodilo hydrataci.
  useEffect(() => {
    let zruseno = false;

    async function zjistit() {
      if (
        typeof Notification === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      ) {
        if (!zruseno) setStav("nepodporovano");
        return;
      }

      if (Notification.permission === "denied") {
        if (!zruseno) setStav("zablokovano");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existujici = await registration.pushManager.getSubscription();
      if (zruseno) return;

      setTentoEndpoint(existujici?.endpoint ?? null);
      setStav(existujici ? "zapnuto" : "vypnuto");
    }

    void zjistit().catch(() => {
      if (!zruseno) setStav("nepodporovano");
    });

    return () => {
      zruseno = true;
    };
  }, []);

  async function povolit() {
    setChyba(null);
    if (!vapidPublicKey) {
      setChyba("Server nemá nastavené VAPID klíče.");
      return;
    }

    setStav("pracuje");
    try {
      const povoleni = await Notification.requestPermission();
      if (povoleni !== "granted") {
        setStav(povoleni === "denied" ? "zablokovano" : "vypnuto");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Bez tohohle prohlížeč odběr odmítne: každá push zpráva musí
        // skončit viditelnou notifikací, ne tichým během na pozadí.
        userVisibleOnly: true,
        applicationServerKey: klicDoBajtu(vapidPublicKey) as BufferSource,
      });

      const json = subscription.toJSON();
      const result = await ulozitOdber({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        userAgent: navigator.userAgent,
      });

      if (!result.ok) {
        // Odběr v prohlížeči zůstal, ale server o něm neví — bez
        // úklidu by tlačítko říkalo „zapnuto“ a nic by nechodilo.
        await subscription.unsubscribe();
        setChyba(result.message ?? "Odběr se nepodařilo uložit.");
        setStav("vypnuto");
        return;
      }

      setTentoEndpoint(subscription.endpoint);
      setStav("zapnuto");
      router.refresh();
    } catch (error) {
      setChyba(error instanceof Error ? error.message : "Povolení selhalo.");
      setStav("vypnuto");
    }
  }

  async function odhlasit(device: DeviceRow) {
    setChyba(null);
    const result = await zrusitOdber(device.id);
    if (!result.ok) {
      setChyba(result.message ?? "Zařízení se nepodařilo odhlásit.");
      return;
    }

    // U tohohle zařízení je potřeba zrušit i odběr v prohlížeči.
    // Samotný řádek v databázi nestačí — prohlížeč by ho při dalším
    // povolení vrátil beze změny a uživatel by nepoznal rozdíl.
    if (device.endpoint === tentoEndpoint) {
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch {
        // Nevadí: řádek je pryč, takže se na tohle zařízení stejně
        // nic neodešle.
      }
      setTentoEndpoint(null);
      setStav("vypnuto");
    }

    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Prepinac
        stav={stav}
        chyba={chyba}
        maKlic={Boolean(vapidPublicKey)}
        onPovolit={povolit}
      />

      {devices.length > 0 ? (
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Přihlášená zařízení
          </h3>
          <ul className="mt-3">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Smartphone
                    className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {popisZarizeni(device.user_agent)}
                      {device.endpoint === tentoEndpoint ? (
                        <span className="ml-2 text-xs text-[var(--accent-bright)]">
                          toto zařízení
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-[var(--text-muted)]">
                      Přihlášeno {formatDateTime(device.created_at)}
                      {device.last_used_at
                        ? ` · naposledy použito ${formatDateTime(device.last_used_at)}`
                        : " · zatím nic nedostalo"}
                    </p>
                  </div>
                </div>
                <Button type="button" variant="secondary" onClick={() => void odhlasit(device)}>
                  Odhlásit
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sites.map((site) => (
        <PrefsForm
          key={site.id}
          site={site}
          prefs={prefs[site.id]}
          jedina={sites.length === 1}
        />
      ))}
    </div>
  );
}

function Prepinac({
  stav,
  chyba,
  maKlic,
  onPovolit,
}: {
  stav: Stav;
  chyba: string | null;
  maKlic: boolean;
  onPovolit: () => Promise<void>;
}) {
  const zprava: Record<Stav, string> = {
    zjistuje: "Zjišťuji stav…",
    nepodporovano:
      "Tenhle prohlížeč push notifikace neumí. Na iPhonu je potřeba portál nejdřív přidat na plochu.",
    zablokovano:
      "Notifikace máte v prohlížeči zablokované. Povolit se dají jen v jeho nastavení, portál na to nemá dosah.",
    vypnuto: "Zapněte a portál vám dá vědět, i když ho nemáte otevřený.",
    zapnuto: "Na tomhle zařízení notifikace chodí.",
    pracuje: "Zařizuji…",
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={stav === "zapnuto" ? "text-[var(--success)]" : "text-[var(--text-muted)]"}
          aria-hidden="true"
        >
          {stav === "zapnuto" ? (
            <BellRing className="h-5 w-5" />
          ) : (
            <BellOff className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm">{zprava[stav]}</p>
          {chyba ? (
            <p className="mt-1 text-sm text-[var(--danger)]">{chyba}</p>
          ) : null}
          {!maKlic && stav !== "zjistuje" ? (
            <p className="mt-1 text-xs text-[var(--warning)]">
              Server nemá nastavené VAPID klíče, takže se odběr nedá založit.
            </p>
          ) : null}
        </div>
      </div>

      {stav === "vypnuto" || stav === "pracuje" ? (
        <Button
          type="button"
          onClick={() => void onPovolit()}
          disabled={stav === "pracuje" || !maKlic}
        >
          Povolit notifikace
        </Button>
      ) : null}
    </div>
  );
}

const PRAZDNY: PushActionResult = { ok: false };

function PrefsForm({
  site,
  prefs,
  jedina,
}: {
  site: SiteOption;
  prefs: EffectivePrefs | undefined;
  jedina: boolean;
}) {
  const [state, formAction] = useActionState(ulozitPredvolby, PRAZDNY);
  // Kdo předvolby ještě neuložil, nemá řádek — a přepínače by pak
  // stály na „vypnuto“, ačkoli notifikace ve skutečnosti chodí.
  // Uložením by je tím omylem doopravdy vypnul.
  const hodnoty = effectivePrefs(prefs);

  return (
    <form action={formAction} className="border-t border-[var(--line)] pt-5">
      <input type="hidden" name="site_id" value={site.id} />

      {!jedina ? (
        <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {site.name}
        </h3>
      ) : null}

      <ul className="space-y-3">
        {NOTIFICATION_KINDS.map((kind) => {
          const column = NOTIFICATION_KIND_COLUMNS[kind];
          const checked = Boolean(hodnoty[column as keyof EffectivePrefs]);
          return (
            <li key={kind}>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  name={column}
                  defaultChecked={checked}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-sm">{NOTIFICATION_KIND_LABELS[kind]}</span>
                  <span className="block text-xs leading-relaxed text-[var(--text-muted)]">
                    {NOTIFICATION_KIND_HINTS[kind]}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <fieldset className="mt-5">
        <legend className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Tiché hodiny
        </legend>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
          V tomhle okně se neozve nic kromě potvrzeného nálezu. Počítá se
          v čase lokality ({site.timezone}). Nevyplněné = neruší se nikdy.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-muted)]">Od</span>
            <input
              type="time"
              name="quiet_from"
              defaultValue={hodnoty.quiet_from?.slice(0, 5) ?? ""}
              className="h-9 border border-[var(--line-strong)] bg-[var(--bg)] px-2"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-muted)]">do</span>
            <input
              type="time"
              name="quiet_to"
              defaultValue={hodnoty.quiet_to?.slice(0, 5) ?? ""}
              className="h-9 border border-[var(--line-strong)] bg-[var(--bg)] px-2"
            />
          </label>
        </div>
      </fieldset>

      <div className="mt-5 flex items-center gap-3">
        <Button type="submit">Uložit předvolby</Button>
        {state.ok ? (
          <span className="text-sm text-[var(--success)]">Uloženo.</span>
        ) : state.message ? (
          <span className="text-sm text-[var(--danger)]">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
