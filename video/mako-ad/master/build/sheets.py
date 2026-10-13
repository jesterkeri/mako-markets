#!/usr/bin/env python3
"""Review sheets. usage:
  sheets.py contact <snapdir> <out.jpg>     storyboard still vs master frame at each key time
  sheets.py seams <snapdir> <out.jpg> [cut ...]  5 frames across each seam
Frames are matched by the time in the snapshot file name (frame-NN-at-<t>s.png)."""
import sys, os, re, glob
from PIL import Image, ImageDraw, ImageFont

AD = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KEYS = [("01",1.6),("02",3.2),("03",4.7),("04",6.4),("05",7.7),("06",8.7),("07",9.7),("08",10.4),("09",10.9),("10",11.4),
        ("11",12.8),("12",14.4),("13",16.2),("14",17.4),("15",19.0),("16",20.6),("17",21.7),("18",23.2),("19",25.6),("21",27.6),
        ("22",29.0),("23",31.2),("24",33.2),("25",34.6),("26",36.2),("27",37.7),("28",39.4),("29",41.4),("30",43.1),("31",45.4),
        ("32",47.2),("33",48.6),("34",50.4),("35",52.0),("36",53.5),("37",55.4),("38",57.8),("39",59.6)]
CUTS = [2.0,3.5,5.0,7.0,8.0,9.0,10.0,10.5,11.0,11.5,13.0,15.0,16.5,18.0,19.5,21.0,22.0,24.0,26.5,28.0,29.5,32.0,33.5,35.0,
        36.5,38.0,40.0,42.0,43.5,46.0,47.5,49.0,51.0,52.5,54.0,56.0,58.5]
OFFS = [-0.2,-0.1,0.0,0.1,0.2]

def frames(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.png")):
        m = re.search(r"at-([0-9.]+)s\.png$", f)
        if m: out[round(float(m.group(1)), 3)] = f
    return out

def font(sz):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:
        if os.path.exists(p): return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

def thumb(p, w, h):
    if p and os.path.exists(p): return Image.open(p).convert("RGB").resize((w, h), Image.LANCZOS)
    im = Image.new("RGB", (w, h), (90, 0, 0)); return im

def contact(d, out):
    fr = frames(d); w, h = 288, 162; cols = 4; pw = w * 2 + 6; ph = h + 22
    rows = (len(KEYS) + cols - 1) // cols
    S = Image.new("RGB", (cols * (pw + 14), rows * (ph + 10)), (24, 24, 24)); dr = ImageDraw.Draw(S); f = font(14)
    for i, (sid, t) in enumerate(KEYS):
        x = (i % cols) * (pw + 14) + 7; y = (i // cols) * (ph + 10) + 5
        S.paste(thumb(os.path.join(AD, "storyboard", "s%s.png" % sid), w, h), (x, y + 20))
        S.paste(thumb(fr.get(round(t, 3)), w, h), (x + w + 6, y + 20))
        dr.text((x, y + 2), "s%s  t=%.1f   board | master" % (sid, t), fill=(250, 204, 21), font=f)
    S.save(out, quality=85)

def seams(d, out, cuts):
    fr = frames(d); w, h = 192, 108; cols = 2; sw = 5 * (w + 3) + 70; sh = h + 6
    rows = (len(cuts) + cols - 1) // cols
    S = Image.new("RGB", (cols * (sw + 16), rows * sh + 6), (24, 24, 24)); dr = ImageDraw.Draw(S); f = font(13)
    for i, c in enumerate(cuts):
        x = (i % cols) * (sw + 16) + 6; y = (i // cols) * sh + 4
        dr.text((x, y + 44), "%.1f" % c, fill=(250, 204, 21), font=f)
        for j, o in enumerate(OFFS):
            S.paste(thumb(fr.get(round(c + o, 3)), w, h), (x + 64 + j * (w + 3), y))
    S.save(out, quality=85)

if __name__ == "__main__":
    if sys.argv[1] == "contact": contact(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "times":
        which = sys.argv[2]
        if which == "keys": print(",".join("%g" % t for _, t in KEYS))
        else:
            cs = [float(x) for x in sys.argv[3:]] or CUTS
            print(",".join(sorted({"%g" % round(c + o, 3) for c in cs for o in OFFS}, key=float)))
    else: seams(sys.argv[2], sys.argv[3], [float(x) for x in sys.argv[4:]] or CUTS)
