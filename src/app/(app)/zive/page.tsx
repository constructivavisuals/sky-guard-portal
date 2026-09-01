import { redirect } from "next/navigation";

// Sloučeno do /kamery.
//
// Živý obraz, časová osa i záznamy byly tři stránky téže věci. Adresa
// tu zůstává, aby uložený odkaz nespadl do 404 — s kamerou v dotazu
// vede rovnou do jejího detailu, bez ní na přehled.

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ kamera?: string }>;
}) {
  const { kamera } = await searchParams;
  redirect(kamera ? `/kamery/${kamera}` : "/kamery");
}
