"""
Klient portálu, sdílený watcherem a službou událostí.

═══ Proč sdílený modul ═════════════════════════════════════════════
Podepisování je bezpečnostní kód a dvě kopie téhle úvahy by se při
první změně rozešly. Rozešly by se navíc TIŠE: podpis, který sedí
o znak jinak, vypadá zvenčí přesně jako špatné tajemství.

Portál nemá žádnou závislost mimo standardní knihovnu — co se
neinstaluje, to se nedá kompromitovat skrz závislost.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request

log = logging.getLogger("portal")

PORTAL_URL = os.environ.get("PORTAL_URL", "").rstrip("/")
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")
HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT_SEC", "30"))


class PortalError(RuntimeError):
    """Portál odpověděl chybou. Nese stav, ať se pozná dočasné od trvalého."""

    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body

    @property
    def permanent(self) -> bool:
        """4xx kromě 429 opakováním nespraví — je to vada požadavku."""
        if self.status is None:
            return False
        if self.status == 429:
            return False
        return 400 <= self.status < 500


def sign(body: bytes, timestamp: str, secret: str = "") -> str:
    """
    Podpis `${timestamp}.${tělo}`.

    Čas se sváže s tělem schválně: odchycený požadavek se pak nedá
    přehrát s čerstvou hlavičkou, protože podpis by na nové dvojici
    neseděl. Tělo jsou BAJTY, ne objekt — serializuje se jednou
    a použije dvakrát, jinak by se podepsalo něco jiného, než se pošle.
    """
    return hmac.new(
        (secret or RELAY_SECRET).encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()


def _request(path: str, body: bytes | None, method: str, timeout: float) -> dict:
    if not PORTAL_URL:
        raise PortalError("PORTAL_URL není nastavená")
    if not RELAY_SECRET:
        raise PortalError("RELAY_SECRET není nastavený")

    payload = body if body is not None else b""
    timestamp = str(int(time.time()))
    headers = {
        "X-Timestamp": timestamp,
        "X-Signature": sign(payload, timestamp),
    }
    if body is not None:
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        f"{PORTAL_URL}{path}", data=body, method=method, headers=headers
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", "replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")[:500]
        raise PortalError(f"portál odpověděl {exc.code}", exc.code, text) from exc
    except urllib.error.URLError as exc:
        raise PortalError(f"portál nedostupný: {exc.reason}") from exc


def signed_post(path: str, payload: dict, timeout: float | None = None) -> dict:
    """POST na portál, podepsaný RELAY_SECRET."""
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return _request(path, body, "POST", timeout or HTTP_TIMEOUT)


def signed_get(path: str, timeout: float | None = None) -> dict:
    """
    GET na portál, podepsaný nad PRÁZDNÝM tělem.

    Konfigurace se čte a nic nemění, takže GET. Podepisuje se stejným
    vzorem — jen je tělo prázdný řetězec.
    """
    return _request(path, None, "GET", timeout or HTTP_TIMEOUT)


def ping_healthcheck(url: str, ok: bool) -> None:
    """
    Ohlásí průchod hlídači. Nikdy nevyhazuje.

    Je to smyčka, ne cron, takže ping patří na konec průchodu — ne do
    crontabu, který tu žádný není.
    """
    if not url:
        return
    target = url if ok else f"{url.rstrip('/')}/fail"
    try:
        with urllib.request.urlopen(target, timeout=10) as response:
            response.read()
    except Exception as exc:  # noqa: BLE001
        log.warning("Ping hlídači selhal: %s", exc)
