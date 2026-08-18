import datetime
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import commute_weather  # noqa: E402


class CommuteWeatherTests(unittest.TestCase):
    def test_bundled_calendar_loads_without_site_install(self):
        self.assertIsNone(commute_weather.CALENDAR_IMPORT_ERROR)
        self.assertEqual(commute_weather.CALENDAR_SOURCE, "bundled")
        commute_weather.ensure_calendar_available(datetime.date(2026, 8, 18))

    def test_bundled_calendar_preserves_holiday_api(self):
        holiday, name = commute_weather.get_holiday_detail(
            datetime.date(2018, 4, 30)
        )
        self.assertTrue(holiday)
        self.assertIsNotNone(name)
        self.assertFalse(commute_weather.is_workday(datetime.date(2018, 4, 30)))


if __name__ == "__main__":
    unittest.main()
