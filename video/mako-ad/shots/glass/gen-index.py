import sys
shots=[("s04",2.0),("s12",2.0),("s13",1.5),("s15",1.5),("s16",1.5),("s23",2.5),("s26",1.5),("s30",1.5),("s33",1.5),("s36",1.5),("s39",1.5)]
only=sys.argv[1].split(",") if len(sys.argv)>1 and sys.argv[1]!="all" else None
if only: shots=[s for s in shots if s[0] in only]
t=0;slots=[]
for sid,d in shots:
    slots.append(f'    <div id="el-{sid}" data-composition-id="{sid}" data-composition-src="compositions/{sid}.html" data-start="{t:g}" data-duration="{d:g}" data-track-index="1" data-width="1920" data-height="1080"></div>')
    print(sid, "start", round(t,2), file=sys.stderr)
    t+=d
html=f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <!-- GLASS storyboard host: shots back to back only so they can be linted / snapshotted. -->
    <script src="assets/gsap.min.js"></script>
    <style>
      body {{ margin: 0; background: #000; }}
      #root {{ position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }}
      [data-composition-id="root"] > div[data-composition-src] {{ position: absolute; inset: 0; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="{t:g}">
{chr(10).join(slots)}
    </div>
    <script>
      window.__timelines["root"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
'''
open(sys.argv[2] if len(sys.argv)>2 else "index.html","w").write(html)
