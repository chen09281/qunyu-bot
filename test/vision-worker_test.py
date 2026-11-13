import base64
import io
from pathlib import Path
import runpy
import unittest
from PIL import Image, ImageDraw

worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'src/vision-worker.py'))['main']


def prepare(image, max_crops=8, limit=24*1024*1024, fmt='PNG'):
    buffer = io.BytesIO(); image.save(buffer, format=fmt)
    encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
    return worker({'data': encoded, 'maxCrops': max_crops, 'maxBytes': limit}), encoded


class DetailCrops(unittest.TestCase):
    def test_dense_screenshot_preserves_original_and_every_crop_pixel(self):
        image = Image.new('RGB', (4000, 2400), 'white'); draw = ImageDraw.Draw(image)
        for y in range(20, 2400, 70):
            draw.text((y % 3500, y), 'Small text VISION-CHECK-739204', fill='black')
        result, original = prepare(image)
        self.assertEqual(result['overview']['data'], original)
        self.assertGreater(len(result['crops']), 1)
        self.assertLessEqual(len(result['crops']), 8)
        covered = Image.new('L', image.size); mask = ImageDraw.Draw(covered)
        for crop in result['crops']:
            decoded = Image.open(io.BytesIO(base64.b64decode(crop['data'])))
            expected = image.crop(crop['box'])
            self.assertEqual(decoded.size, expected.size)
            self.assertEqual(decoded.tobytes(), expected.tobytes())
            x, y, right, bottom = crop['box']; mask.rectangle((x, y, right-1, bottom-1), fill=255)
        self.assertEqual(covered.getextrema(), (255, 255))
        self.assertFalse(result['partial'])

    def test_small_jpeg_is_forwarded_byte_for_byte(self):
        result, original = prepare(Image.new('RGB', (900, 900), '#abc123'), fmt='JPEG')
        self.assertEqual(result['overview'], {'mime': 'image/jpeg', 'data': original})
        self.assertEqual(result['crops'], [])

    def test_thin_long_image_gets_full_size_crops_despite_small_pixel_count(self):
        result, _ = prepare(Image.new('RGB', (50, 20000), 'white'))
        self.assertGreater(len(result['crops']), 1)
        self.assertEqual(result['crops'][0]['box'][1], 0)
        self.assertEqual(result['crops'][-1]['box'][3], 20000)
        self.assertTrue(all(crop['box'][2] == 50 for crop in result['crops']))
        self.assertTrue(all(crop['box'][3] - crop['box'][1] <= 8192 for crop in result['crops']))

    def test_tile_budget_keeps_whole_image_covered_and_marks_large_tiles(self):
        result, _ = prepare(Image.new('RGB', (4000, 4000), 'white'), max_crops=2)
        self.assertEqual(len(result['crops']), 2)
        self.assertTrue(result['limited']); self.assertFalse(result['partial'])

    def test_output_budget_does_not_silently_shrink_detail_images(self):
        result, _ = prepare(Image.effect_noise((1800, 1800), 100), limit=100000)
        self.assertTrue(result['partial'])
        self.assertEqual(result['crops'], [])


if __name__ == '__main__':
    unittest.main()
