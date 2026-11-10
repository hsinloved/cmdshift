import random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONTS = '/root/.claude/skills/canvas-design/canvas-fonts/'
OUT = sys.argv[1]
W, H = 2400, 3200          # final size
S = 3                      # supersample factor
w, h = W * S, H * S

PAPER = (241, 236, 226)
INK = (34, 32, 30)
INK2 = (34, 32, 30, 120)   # light ink
INK3 = (34, 32, 30, 60)
ACCENT = (172, 78, 52)

img = Image.new('RGBA', (w, h), PAPER + (255,))
d = ImageDraw.Draw(img, 'RGBA')
u = lambda v: int(round(v * S))

def font(name, size): return ImageFont.truetype(FONTS + name, u(size))
serif_it = lambda s: font('InstrumentSerif-Italic.ttf', s)
mono = lambda s: font('DMMono-Regular.ttf', s)
thin = lambda s: font('Jura-Light.ttf', s)

def text(xy, s, f, fill=INK, anchor='la', spacing=0):
    if spacing:
        x, y = xy
        for ch in s:
            d.text((u(x), u(y)), ch, font=f, fill=fill, anchor=anchor)
            x += d.textlength(ch, font=f) / S + spacing
        return x
    d.text((u(xy[0]), u(xy[1])), s, font=f, fill=fill, anchor=anchor)

def hline(x0, x1, y, fill=INK3, wdt=1.0): d.rectangle([u(x0), u(y - wdt / 2), u(x1), u(y + wdt / 2)], fill=fill)
def vline(x, y0, y1, fill=INK3, wdt=1.0): d.rectangle([u(x - wdt / 2), u(y0), u(x + wdt / 2), u(y1)], fill=fill)
def dot(x, y, r, fill=None, outline=None, wdt=1.4):
    d.ellipse([u(x - r), u(y - r), u(x + r), u(y + r)], fill=fill, outline=outline, width=u(wdt) if outline else 0)

M = 200                              # outer margin
rnd = random.Random(7)

# --- header -------------------------------------------------------------------
text((M, M), 'PL. 07', mono(22), INK2)
text((W - M, M), 'TASTE · OBSERVED', mono(22), INK2, anchor='ra')
hline(M, W - M, M + 52, INK3)

# --- the field ----------------------------------------------------------------
sections = [5, 7, 6, 8, 6]           # dishes per section
ROW = 56
GAP = 70
DOT_X0, DOT_STEP = 470, 46
BAR_X0, BAR_W = 1180, 1020
CEIL = BAR_X0 + 0.7 * BAR_W
y = M + 150
picks = {(1, 2): 1, (3, 0): 2, (3, 5): 3, (4, 3): 4}
confirmed = {(0, 1), (2, 4), (3, 5)}
field_top = y - 40
numerals = ['I', 'II', 'III', 'IV', 'V']
for si, n in enumerate(sections):
    text((M, y), numerals[si], mono(20), INK2, anchor='lm')
    for ri in range(n):
        cy = y + ri * ROW
        k = rnd.randint(3, 9)
        printed = rnd.randint(1, k)
        order = [True] * printed + [False] * (k - printed)
        for j, is_menu in enumerate(order):
            x = DOT_X0 + j * DOT_STEP
            if is_menu: dot(x, cy, 7.5, fill=INK)
            else: dot(x, cy, 7.5, outline=INK, wdt=1.5)
        key = (si, ri)
        if key in confirmed:
            val = rnd.uniform(0.78, 0.94)
        else:
            val = rnd.uniform(0.12, 0.64)
        x1 = BAR_X0 + val * BAR_W
        pick = picks.get(key)
        col = ACCENT if pick else (INK if key in confirmed else INK2)
        hline(BAR_X0, x1, cy, col, 2.2 if pick or key in confirmed else 1.6)
        vline(x1, cy - 9, cy + 9, col, 2.2 if pick else 1.6)
        if pick:
            dot(M + 150, cy, 15, outline=ACCENT, wdt=2)
            text((M + 150, cy + 1), f'{pick}', mono(18), ACCENT, anchor='mm')
    y += n * ROW
    if si < len(sections) - 1:
        hline(DOT_X0 - 20, W - M, y + GAP / 2 - ROW / 2, INK3)
        y += GAP
field_bottom = y - ROW + 40

# ceiling: dashed vertical threshold at 0.7
yy = field_top
while yy < field_bottom:
    vline(CEIL, yy, min(yy + 10, field_bottom), INK, 1.4)
    yy += 22
text((CEIL, field_top - 28), '0.70', mono(20), INK, anchor='ms')
text((BAR_X0, field_top - 28), '0', mono(20), INK2, anchor='ls')
text((BAR_X0 + BAR_W, field_top - 28), '1', mono(20), INK2, anchor='rs')

# --- foot ---------------------------------------------------------------------
foot = H - M
hline(M, W - M, foot - 520, INK3)
text((M, foot - 330), 'Was gibts?', serif_it(210), INK, anchor='ls')
text((M + 6, foot - 230), 'Fig. 1 — a menu, read through one person’s taste.', serif_it(42), INK2, anchor='ls')

# legend (right column)
lx, ly, st = 1600, foot - 452, 74
dot(lx, ly, 7.5, fill=INK); text((lx + 34, ly), 'stated on the menu', mono(22), INK, anchor='lm')
dot(lx, ly + st, 7.5, outline=INK, wdt=1.5); text((lx + 34, ly + st), 'typical, assumed', mono(22), INK, anchor='lm')
yy = ly + 2 * st - 9
while yy < ly + 2 * st + 9: vline(lx, yy, yy + 5, INK, 1.4); yy += 9
text((lx + 34, ly + 2 * st), 'ceiling of the unconfirmed', mono(22), INK, anchor='lm')
dot(lx, ly + 3 * st, 11, outline=ACCENT, wdt=2); text((lx + 34, ly + 3 * st), 'chosen', mono(22), ACCENT, anchor='lm')

hline(M, W - M, foot - 60, INK3)
text((M, foot - 20), 'ONLY FEEDBACK TEACHES', thin(22), INK2, spacing=6)
text((W - M, foot - 20), 'MÜNCHEN · MMXXVI', thin(22), INK2, anchor='ra')

# --- finish: downsample, grain ------------------------------------------------
out = img.convert('RGB').resize((W, H), Image.LANCZOS)
a = np.asarray(out).astype(np.float32)
rng = np.random.default_rng(3)
grain = rng.normal(0, 2.2, (H, W, 1))
a = np.clip(a + grain, 0, 255).astype(np.uint8)
Image.fromarray(a).save(OUT, optimize=True)
print('saved', OUT)
