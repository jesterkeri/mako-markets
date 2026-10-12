#!/usr/bin/env bash
# render.md pipeline: 240 fps master -> subframe motion blur (180 degree shutter) -> BT.709 H.264 deliverables.
set -euo pipefail
F=out/film
CONV="scale=in_range=tv:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709"
ENC="-c:v libx264 -preset slow -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv -movflags +faststart -an"
# 60 fps: average 2 subframes of 1/240 s (1/120 s = 180 degrees at 60 fps), keep 1 in 4; shutter opens on each 60 fps frame.
ffmpeg -v error -y -i $F/master-240.mp4 -vf "tmix=frames=2,select='eq(mod(n\,4)\,1)',setpts=N/60/TB,$CONV" -r 60 $ENC -crf 15 $F/mako-rounds-1080p60.mp4
# 30 fps: average 4 subframes (1/60 s = 180 degrees at 30 fps), keep 1 in 8.
ffmpeg -v error -y -i $F/master-240.mp4 -vf "tmix=frames=4,select='eq(mod(n\,8)\,3)',setpts=N/30/TB,$CONV" -r 30 $ENC -crf 16 $F/mako-rounds-1080p30.mp4
for f in $F/mako-rounds-1080p60.mp4 $F/mako-rounds-1080p30.mp4; do
  ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,r_frame_rate,width,height,pix_fmt,color_space -show_entries format=duration,size -of compact $f
  ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 $f | wc -l | sed 's/^/audio streams: /'
done
