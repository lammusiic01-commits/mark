from datetime import date

import pytest

from app.ai.advisor import script_advice
from app.payments import sbp
from app.security import SecretError, decrypt_text, encrypt_text, mask_secret
from app.services import yandex_direct
from app.services.url_guard import UnsafeUrlError, normalize_url, _check_sync
from app.engine.seo_analyzer import audit
from app.engine.competitor_tracker import content_fingerprint


def test_fernet_roundtrip_and_tamper():
    token = encrypt_text("y0_secret_token")
    assert "y0_secret" not in token
    assert decrypt_text(token) == "y0_secret_token"
    with pytest.raises(SecretError):
        decrypt_text(token[:-4] + "abcd")


def test_mask_secret():
    assert mask_secret("abcdefgh").endswith("efgh")
    assert mask_secret("") == ""


def test_st00012_payload_format():
    payload = sbp.build_st00012("ООО Ромашка", "40702810000000000001", 150000, "Пополнение AIM7", "044525225")
    assert payload.startswith("ST00012|Name=ООО Ромашка|PersonalAcc=40702810000000000001|BIC=044525225")
    assert "Sum=150000" in payload and payload.endswith("Purpose=Пополнение AIM7")


def test_st00012_sanitizes_separators():
    payload = sbp.build_st00012("A|B=C", "1", 100, "x|y")
    assert "A B C" in payload and "x y" in payload


def test_tsv_parsing_with_conversions_and_junk_lines():
    tsv = (
        '"CAMPAIGN_PERFORMANCE_REPORT (2026-10-01 - 2026-10-02)"\n'
        "Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCost\tConversions_1000_LSCCD\n"
        "2026-10-01\t77\tBrand\t1000\t40\t1234.5\t3\n"
        "2026-10-02\t77\tBrand\t--\t--\t0\t--\n"
        "bad-date\t1\tX\t1\t1\t1\t0\n"
        "Total rows: 2\n"
    )
    rows = yandex_direct._parse_tsv(tsv)
    assert len(rows) == 2
    assert rows[0] == {"conversions": 3, "date": date(2026, 10, 1), "campaign_id": 77,
                       "name": "Brand", "impressions": 1000, "clicks": 40, "cost_kop": 123450}
    assert rows[1]["impressions"] == 0 and rows[1]["conversions"] == 0


def test_url_guard_blocks_internal_addresses():
    with pytest.raises(UnsafeUrlError):
        _check_sync("http://127.0.0.1:8000/")
    with pytest.raises(UnsafeUrlError):
        _check_sync("http://10.0.0.1/")
    with pytest.raises(UnsafeUrlError):
        _check_sync("file:///etc/passwd")


def test_normalize_url():
    assert normalize_url("example.ru") == "https://example.ru"
    assert normalize_url("http://a.ru") == "http://a.ru"
    with pytest.raises(UnsafeUrlError):
        normalize_url("   ")


GOOD_PAGE = """<html lang="ru"><head>
<title>Кухни на заказ в Москве — производство и доставка по всей России</title>
<meta name="description" content="Кухни на заказ от производителя: замеры, дизайн-проект, доставка и сборка за 30 дней. Гарантия пять лет.">
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="https://example.ru/">
<meta property="og:title" content="Кухни">
</head><body><h1>Кухни на заказ</h1>""" + ("<p>слово </p>" * 320) + "</body></html>"


def test_seo_audit_good_page_scores_high():
    result = audit(GOOD_PAGE, "https://example.ru/")
    assert result["score"] >= 95
    assert result["facts"]["h1_count"] == 1


def test_seo_audit_empty_page_has_errors():
    result = audit("<html><body>hi</body></html>", "https://x.ru")
    severities = [i["severity"] for i in result["issues"]]
    assert "error" in severities and result["score"] < 60


def test_competitor_fingerprint_ignores_whitespace_case():
    assert content_fingerprint("Hello   World") == content_fingerprint("hello world")


def test_script_advice_always_has_content():
    summary = {"cpa_kop": None, "ctr": 0.0}
    funnel = {"advice": "Данных недостаточно"}
    risk = {"risk_count": 0, "wasted_kop": 0}
    assert script_advice(summary, [], risk, funnel)
