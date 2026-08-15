import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
SPEC = importlib.util.spec_from_file_location("dual_weather", ROOT / "scripts" / "weather.py")
weather = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(weather)


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class WeatherFixtureTests(unittest.TestCase):
    def test_qweather_alert_request_uses_current_v1_path(self):
        captured = {}
        original = weather.qweather_json

        def fake_qweather_json(path, params, *, timeout):
            captured.update(path=path, params=params, timeout=timeout)
            return fixture("qweather_alert_current.json")

        weather.qweather_json = fake_qweather_json
        try:
            tasks = weather.qweather_tasks(
                ("alerts",), 113.883115, 22.55371, 12, 3, "20260815", 8
            )
            tasks["alerts"]()
        finally:
            weather.qweather_json = original

        self.assertEqual(
            captured["path"], "/weatheralert/v1/current/22.55/113.88"
        )
        self.assertEqual(captured["params"], {"localTime": "true", "lang": "zh"})

    def test_qweather_alert_fixture_normalization_preserves_attribution(self):
        normalized = weather.normalize_qweather(
            {"alerts": fixture("qweather_alert_current.json")},
            ("alerts",),
            12,
            3,
        )
        self.assertEqual(normalized["alerts"][0]["eventType"], "暴雨")
        self.assertEqual(normalized["alerts"][0]["severity"], "severe")
        self.assertEqual(normalized["alerts"][0]["instruction"], "请远离低洼地带并关注官方更新。")
        self.assertFalse(normalized["alertMetadata"]["zeroResult"])
        self.assertTrue(normalized["alertMetadata"]["attributions"])

    def test_geo_ranking_selects_district_without_false_ambiguity(self):
        original = weather.qweather_json
        weather.qweather_json = lambda *args, **kwargs: fixture("qweather_geo_lookup.json")
        try:
            result = weather.qweather_geocode("深圳市宝安区", 8)
        finally:
            weather.qweather_json = original

        self.assertEqual(result["name"], "宝安区")
        self.assertNotIn("ambiguous", result)

    def test_geo_ranking_keeps_genuinely_ambiguous_names(self):
        original = weather.qweather_json
        weather.qweather_json = lambda *args, **kwargs: fixture(
            "qweather_geo_ambiguous.json"
        )
        try:
            result = weather.qweather_geocode("朝阳区", 8)
        finally:
            weather.qweather_json = original

        self.assertTrue(result["ambiguous"])
        self.assertEqual(result["candidateCount"], 2)

    def test_caiyun_probability_scales_are_not_conflated(self):
        normalized = weather.normalize_caiyun(
            fixture("caiyun_weather_metric_v2.json"),
            ("current", "hourly", "daily", "minutely"),
            12,
            1,
        )
        self.assertEqual(normalized["current"]["precipitationIntensity"], 1.25)
        self.assertEqual(normalized["hourly"][0]["precipitationProbability"], 1)
        self.assertEqual(normalized["minutely"]["probability"][0]["probability"], 100)
        self.assertEqual(normalized["daily"][0]["precipitationProbabilityRaw"], 0.25)
        self.assertNotIn("precipitationProbability", normalized["daily"][0])

    def test_skill_metadata_and_documented_alert_path(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        description = re.search(r"^description: (.+)$", skill, re.MULTILINE)
        self.assertIsNotNone(description)
        self.assertLessEqual(len(description.group(1)), 160)
        self.assertIn("/weatheralert/v1/current/{lat}/{lng}", skill)
        self.assertNotIn("/v7/warning/now", skill)


if __name__ == "__main__":
    unittest.main()
