"""
Оплата пополнения баланса: QR-код платёжной ссылки в формате ST00012 (ГОСТ Р 56042),
который понимают банковские приложения РФ и СБП-сканер. Сумма в копейках.
Подтверждение оплаты делает администратор (см. balance.py), пока нет эквайринга.
"""
import base64
import io

import qrcode

from app.config import settings


def is_configured() -> bool:
    return bool(settings.SBP_MERCHANT_ID and settings.SBP_ACCOUNT)


def _clean(value: str) -> str:
    return value.replace("|", " ").replace("=", " ").strip()


def build_st00012(name: str, account: str, amount_kop: int, purpose: str, bic: str = "") -> str:
    fields = [("Name", _clean(name)), ("PersonalAcc", _clean(account))]
    if bic:
        fields.append(("BIC", _clean(bic)))
    fields.append(("Sum", str(int(amount_kop))))
    fields.append(("Purpose", _clean(purpose)[:210]))
    return "ST00012|" + "|".join(f"{k}={v}" for k, v in fields)


def qr_data_url(payload: str) -> str:
    img = qrcode.make(payload, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def make_payment(amount_kop: int, comment: str) -> dict:
    payload = build_st00012(settings.SBP_MERCHANT_ID, settings.SBP_ACCOUNT,
                            amount_kop, comment, settings.SBP_BIC)
    return {"payload": payload, "qr": qr_data_url(payload)}
