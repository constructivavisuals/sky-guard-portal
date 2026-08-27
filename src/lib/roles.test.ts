import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { roleChangeError } from "./roles.ts";

// Pojistka proti kroku, ze kterého nevede cesta zpět. Obojí se dá
// opravit jedině v SQL Editoru, takže se to musí zastavit dřív.

const zaklad = {
  isSelf: false,
  currentRole: "viewer" as const,
  newRole: "viewer" as const,
  adminCount: 3,
};

describe("roleChangeError", () => {
  it("běžná změna role klienta projde", () => {
    assert.equal(roleChangeError({ ...zaklad, newRole: "operator" }), null);
  });

  it("povýšení na admina projde vždycky", () => {
    // Adminů přibývat smí; ubývat jen pod dohledem.
    assert.equal(roleChangeError({ ...zaklad, newRole: "admin" }), null);
    assert.equal(
      roleChangeError({ ...zaklad, isSelf: true, currentRole: "admin", newRole: "admin" }),
      null,
    );
  });

  it("sám sobě roli změnit nejde", () => {
    // Stalo se to naostro: účet se proměnil v klienta a /klienti už
    // na sebe nepustila.
    const e = roleChangeError({
      ...zaklad,
      isSelf: true,
      currentRole: "admin",
      newRole: "viewer",
    });
    assert.match(String(e), /Vlastní roli/);
  });

  it("poslední admin se degradovat nedá", () => {
    const e = roleChangeError({
      ...zaklad,
      currentRole: "admin",
      newRole: "operator",
      adminCount: 1,
    });
    assert.match(String(e), /poslední administrátor/);
  });

  it("předposlední admin se degradovat dá", () => {
    assert.equal(
      roleChangeError({
        ...zaklad,
        currentRole: "admin",
        newRole: "operator",
        adminCount: 2,
      }),
      null,
    );
  });

  it("nezjištěný počet adminů změnu zastaví", () => {
    // Fail-closed: špatně spočítaný poslední admin znamená portál bez
    // správce, kdežto odmítnutá změna se dá zopakovat.
    const e = roleChangeError({
      ...zaklad,
      currentRole: "admin",
      newRole: "viewer",
      adminCount: null,
    });
    assert.match(String(e), /Počet administrátorů/);
  });

  it("nezjištěná současná role změnu zastaví", () => {
    const e = roleChangeError({ ...zaklad, currentRole: null, newRole: "viewer" });
    assert.match(String(e), /Současnou roli/);
  });

  it("u účtu, který adminem není, se počet adminů neřeší", () => {
    assert.equal(
      roleChangeError({ ...zaklad, currentRole: "operator", newRole: "viewer", adminCount: null }),
      null,
    );
  });

  it("degradace sebe sama má přednost před počtem adminů", () => {
    // Kdyby se pořadí prohodilo, admin mezi ostatními by si sám sebe
    // degradovat mohl.
    const e = roleChangeError({
      isSelf: true,
      currentRole: "admin",
      newRole: "operator",
      adminCount: 5,
    });
    assert.match(String(e), /Vlastní roli/);
  });
});
