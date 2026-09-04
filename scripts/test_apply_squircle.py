import unittest

from apply_squircle import squircle_layout


class SquircleLayoutTests(unittest.TestCase):
    def test_centers_a_scaled_image_on_its_original_canvas(self):
        new_size, offset = squircle_layout((100, 80), 0.5)

        self.assertEqual(new_size, (50, 40))
        self.assertEqual(offset, (25, 20))


if __name__ == "__main__":
    unittest.main()
