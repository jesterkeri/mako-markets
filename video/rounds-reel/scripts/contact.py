"""Contact sheet: for every shot, the approved storyboard still next to the film frame at the same time.
usage: python3 -I scripts/contact.py <film.mp4> <storyboard dir> <out.png>"""
import json, subprocess, sys, tempfile, os
from PIL import Image, ImageDraw, ImageFont

film, board, out = sys.argv[1:4]
shots = json.loads(sys.argv[4])  # [[id, time], ...]
TW, TH = 400, 225
cols = 3  # pairs per row
pad, lab = 16, 34
rows = (len(shots) + cols - 1) // cols
W = pad + cols * (2 * TW + 8 + pad)
H = 90 + rows * (TH + lab + pad) + pad
sheet = Image.new("RGB", (W, H), (235, 229, 217))
d = ImageDraw.Draw(sheet)
mono = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 18)
title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
d.text((pad, 24), "Mako Market Rounds · film vs approved board (left: approved still, right: film frame)", font=title, fill=(0, 0, 0))
tmp = tempfile.mkdtemp()
for i, (sid, t) in enumerate(shots):
    fn = os.path.join(tmp, f"{sid}.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.4f}", "-i", film, "-frames:v", "1", fn], check=True)
    a = Image.open(os.path.join(board, f"shot-{sid}.png")).convert("RGB").resize((TW, TH))
    b = Image.open(fn).convert("RGB").resize((TW, TH))
    r, c = divmod(i, cols)
    x = pad + c * (2 * TW + 8 + pad)
    y = 90 + r * (TH + lab + pad)
    sheet.paste(a, (x, y))
    sheet.paste(b, (x + TW + 8, y))
    d.text((x, y + TH + 6), f"{sid}   t={t:.2f}s", font=mono, fill=(0, 0, 0))
sheet.save(out)
