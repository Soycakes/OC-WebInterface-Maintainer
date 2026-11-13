import sys
from pathlib import Path
from PIL import Image

TILE = 512
atlas = Image.open(sys.argv[1])
out = Path(__file__).resolve().parent.parent / 'client' / 'public' / 'atlas'
out.mkdir(exist_ok=True)

for x in range(0, atlas.width, TILE):
    for y in range(0, atlas.height, TILE):
        tile = atlas.crop((x, y, x + TILE, y + TILE))
        if tile.getbbox():
            tile.save(out / f'{x // TILE}_{y // TILE}.webp', 'WEBP', lossless=True, method=6)
