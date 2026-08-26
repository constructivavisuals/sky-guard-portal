import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { AreaMap } from "@/components/area-map.tsx";
import { BlockTitle, EmptyState, PageHeader, Section } from "@/components/ui.tsx";
import { orDash } from "@/lib/format.ts";
import { MapPin } from "lucide-react";

import { nactiAreal } from "./site.ts";
import { ArealTabs } from "./tabs.tsx";

// Rám areálu: cesta zpět, název, mapa a karty.
//
// Mapa je nahoře pro všechny karty schválně — právě na ní jsou vidět
// zóny i záběry kamer, takže při jejich úpravě je po ruce to jediné,
// podle čeho se dá poznat, jestli sedí.

export default async function Layout({ children, params }: LayoutProps<"/arealy/[id]">) {
  const { id } = await params;
  const { site, map, failed } = await nactiAreal(id);

  if (failed) {
    return (
      <>
        <BackLink />
        <PageHeader title="Areál" />
        <EmptyState
          icon={<MapPin className="h-5 w-5" aria-hidden="true" />}
          title="Areál se nepodařilo načíst"
          description="Zkuste to za chvíli znovu. Pokud potíž trvá, zkontrolujte připojení k databázi."
        />
      </>
    );
  }

  if (!site) notFound();

  return (
    <>
      <BackLink />
      <PageHeader title={site.name} description={orDash(site.address)} />

      <Section flush className="px-5 py-5 sm:px-8 sm:py-6">
        <BlockTitle>Areál</BlockTitle>
        {/* Omezená šířka schválně: podklad má poměr stran skoro čtverec,
            takže přes celou stránku by byl vysoký přes celou obrazovku
            a karty pod ním by se ocitly pod záhybem. Tady je to kontext
            k tomu, co se upravuje, ne hlavní obsah. */}
        <div className="max-w-[30rem]">
          <AreaMap
            imageUrl={map?.imageUrl ?? null}
            bounds={map?.bounds ?? null}
            points={map?.points ?? []}
            siteName={site.name}
          />
        </div>
      </Section>

      <ArealTabs id={id} />

      {children}
    </>
  );
}

function BackLink() {
  return (
    <div className="border-b border-[var(--line)] px-5 py-2.5 sm:px-8">
      <Link
        href="/arealy"
        className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Areály
      </Link>
    </div>
  );
}
