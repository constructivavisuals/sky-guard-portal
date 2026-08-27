import type { UserRole } from "../types/database.ts";

// Pravidla pro změnu role. Čistá funkce, aby šla otestovat bez
// databáze — vstupy si obstarává akce v klienti/actions.ts.
//
// ═══ Dvě cesty, jak si zavřít portál ═══════════════════════════════
// 1) Administrátor změní roli SÁM SOBĚ. Stalo se to naostro: účet se
//    proměnil v klienta a zpátky ho vrátil až zásah v SQL Editoru,
//    protože /klienti už na sebe nepustila.
// 2) Administrátor degraduje POSLEDNÍHO admina. Výsledek je stejný,
//    jen o krok dál — v portálu nezůstane nikdo, kdo umí zakládat účty
//    a nastavovat lokality.
//
// Obojí je zevnitř portálu nevratné. Není to bezpečnostní hranice —
// kdo je admin, může skoro všechno — je to pojistka proti kroku, ze
// kterého nevede cesta zpět.
// ═══════════════════════════════════════════════════════════════════

export interface RoleChangeInput {
  /** Mění admin roli svému vlastnímu účtu? */
  isSelf: boolean;
  /** Jakou roli má účet teď. null = nepodařilo se zjistit. */
  currentRole: UserRole | null;
  newRole: UserRole;
  /** Kolik je v portálu adminů. null = nepodařilo se spočítat. */
  adminCount: number | null;
}

/** Hláška k poli `role`, nebo null když je změna v pořádku. */
export function roleChangeError(input: RoleChangeInput): string | null {
  const { isSelf, currentRole, newRole, adminCount } = input;

  if (isSelf && newRole !== "admin") {
    return "Vlastní roli si změnit nemůžete. Požádejte jiného administrátora.";
  }

  // Účet, který adminem není, nebo jím zůstává — není co hlídat.
  if (newRole === "admin") return null;

  if (currentRole === null) {
    return "Současnou roli účtu se nepodařilo zjistit. Zkuste to prosím znovu.";
  }
  if (currentRole !== "admin") return null;

  // Nezjištěný počet změnu zastaví. Fail-closed: špatně spočítaný
  // poslední admin znamená portál bez správce, což se zevnitř
  // neopraví — kdežto odmítnutá změna role se dá zopakovat.
  if (adminCount === null) {
    return "Počet administrátorů se nepodařilo ověřit. Zkuste to prosím znovu.";
  }

  if (adminCount <= 1) {
    return "Tohle je poslední administrátor. Nejdřív povyšte jiný účet.";
  }

  return null;
}
