"""Create bounded, lossless detail crops in memory; never load paths or URLs."""
import base64
import io
import json
import math
import sys
import warnings
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)


def main(data):
    raw = base64.b64decode(data['data'], validate=True)
    if not 0 < len(raw) <= 32 * 1024 * 1024:
        raise ValueError('size')
    limit, max_crops = data['maxBytes'], data['maxCrops']
    if not 0 < limit <= 24 * 1024 * 1024 or not 0 <= max_crops <= 8:
        raise ValueError('limits')
    source = Image.open(io.BytesIO(raw))
    mime = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp', 'GIF': 'image/gif'}.get(source.format)
    if not mime or source.width * source.height > 40_000_000:
        raise ValueError('image')
    animated = getattr(source, 'is_animated', False)
    image = ImageOps.exif_transpose(source)
    width, height = image.size
    result = {'width': width, 'height': height, 'overview': None, 'crops': [], 'limited': False, 'partial': False, 'animated': animated}
    used = 0
    if max(width, height) <= 8192:
        if len(raw) <= limit // 2:
            result['overview'] = {'mime': mime, 'data': data['data']}
            used = len(raw)
    else:
        # Only the overview is reduced to meet the model's edge limit. Crops stay 1:1.
        overview = image.copy()
        overview.thumbnail((1280, 1280))
        output = io.BytesIO(); overview.save(output, format='PNG')
        if output.tell() > limit:
            overview.thumbnail((1024, 1024))
            output = io.BytesIO(); overview.save(output, format='PNG')
        result['overview'] = {'mime': 'image/png', 'data': base64.b64encode(output.getvalue()).decode('ascii')}
        used = output.tell()
    if width * height <= 1_600_000 and max(width, height) <= 8192 or not max_crops:
        return result
    target = 1280
    cols, rows = max(1, math.ceil((width - 64) / (target - 64))), max(1, math.ceil((height - 64) / (target - 64)))
    if cols * rows > max_crops:
        candidates = [(c, r) for c in range(1, max_crops + 1) for r in range(1, max_crops // c + 1)]
        cols, rows = min(candidates, key=lambda pair: ((math.ceil(width / pair[0]) + 64) * (math.ceil(height / pair[1]) + 64), -pair[0] * pair[1]))
        result['limited'] = True
    tile_width, tile_height = min(width, math.ceil(width / cols) + (64 if cols > 1 else 0)), min(height, math.ceil(height / rows) + (64 if rows > 1 else 0))
    if max(tile_width, tile_height) > 8192:
        result['partial'] = True
        return result
    for row in range(rows):
        top = round(row * (height - tile_height) / max(1, rows - 1))
        for col in range(cols):
            left = round(col * (width - tile_width) / max(1, cols - 1))
            box = [left, top, left + tile_width, top + tile_height]
            crop = image.crop(box)
            if crop.mode not in ('RGB', 'RGBA', 'L', 'LA', 'P'):
                crop = crop.convert('RGB')
            output = io.BytesIO(); crop.save(output, format='PNG', compress_level=6)
            if used + output.tell() > limit:
                result['partial'] = True
                return result
            used += output.tell()
            result['crops'].append({'box': box, 'data': base64.b64encode(output.getvalue()).decode('ascii')})
    return result


if __name__ == '__main__':
    try:
        if sys.platform == 'linux':
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({'error': '图片细节处理失败'})); sys.exit(1)
