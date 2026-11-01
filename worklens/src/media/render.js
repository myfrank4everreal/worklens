// Timeline → one ffmpeg command. The Node successor to media-lab/stitch_video.py, generalised for
// the Studio editor:
//
//   {
//     width: 1080, height: 1920, fps: 30,
//     clips:    [{ src, in?: 0, out?: null, duration?: 3 }],  // main track, in order; a still
//                                                            // image needs `duration`
//     overlays: [{ src, start, end, x?: 0, y?: 0 }],          // PNGs (captions are drawn as PNGs
//                                                            // by the editor), timed on output
//     audio:    [{ src, start?: 0, in?: 0, out?: null, volume?: 1 }],  // voice, music…
//     clipAudio: { keep: true, volume: 1 },
//     endCard:  { src, duration: 3 } | null,
//     output:   'C:/…/render.mp4'
//   }
//
// Every clip is scaled/cropped to fill the frame (no letterboxing), normalised to one fps and
// pixel format, and given a silent track if it has none, so concat never fails on a mismatch.
// Extra audio is delayed to its start time and mixed over the clips' own sound.
import { probe, runFfmpeg } from './ffmpeg.js';

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export async function planTimeline(timeline) {
  const width = Math.round(num(timeline.width, 1080) / 2) * 2;
  const height = Math.round(num(timeline.height, 1920) / 2) * 2;
  const fps = Math.min(Math.max(num(timeline.fps, 30), 12), 60);
  const clips = [...(timeline.clips || [])];
  if (timeline.endCard?.src) clips.push({ src: timeline.endCard.src, duration: num(timeline.endCard.duration, 3), fadeIn: 0.4, isEndCard: true });
  if (!clips.length) throw new Error('The timeline has no clips.');

  const segments = [];
  for (const clip of clips) {
    const info = await probe(clip.src);
    if (!info.hasVideo) throw new Error(`Not a video or image: ${clip.src}`);
    const start = Math.max(0, num(clip.in, 0));
    let length;
    if (info.isImage) length = num(clip.duration, 3);
    else {
      const end = clip.out != null ? Math.min(num(clip.out, info.duration), info.duration) : info.duration;
      length = end - start;
    }
    if (!(length > 0.05)) throw new Error(`Clip has no length after trimming: ${clip.src}`);
    segments.push({ ...clip, info, start, length });
  }
  const total = segments.reduce((s, x) => s + x.length, 0);
  return { width, height, fps, segments, total };
}

export function buildArgs(timeline, plan) {
  const { width: W, height: H, fps, segments, total } = plan;
  const keepClipAudio = timeline.clipAudio?.keep !== false;
  const clipVolume = num(timeline.clipAudio?.volume, 1);
  const args = [];
  const filters = [];
  let input = 0;

  segments.forEach((seg, i) => {
    if (seg.info.isImage) args.push('-loop', '1', '-t', seg.length.toFixed(3), '-i', seg.src);
    else args.push('-ss', seg.start.toFixed(3), '-t', seg.length.toFixed(3), '-i', seg.src);
    const fade = seg.fadeIn ? `,fade=t=in:st=0:d=${seg.fadeIn}` : '';
    filters.push(`[${input}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1,trim=duration=${seg.length.toFixed(3)},setpts=PTS-STARTPTS${fade}[v${i}]`);
    if (keepClipAudio && seg.info.hasAudio && !seg.info.isImage) {
      filters.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${seg.length.toFixed(3)},asetpts=PTS-STARTPTS,volume=${clipVolume}[a${i}]`);
    } else {
      filters.push(`aevalsrc=0:c=stereo:s=44100:d=${seg.length.toFixed(3)}[a${i}]`);
    }
    input++;
  });
  filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);

  let vLabel = 'vcat';
  (timeline.overlays || []).forEach((ov, k) => {
    const s = Math.max(0, num(ov.start, 0)), e = Math.min(total, num(ov.end, total));
    if (!(e > s)) return;
    args.push('-loop', '1', '-t', total.toFixed(3), '-i', ov.src);
    const next = `vo${k}`;
    filters.push(`[${input}:v]format=rgba[ovs${k}]`);
    filters.push(`[${vLabel}][ovs${k}]overlay=${Math.round(num(ov.x, 0))}:${Math.round(num(ov.y, 0))}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'[${next}]`);
    vLabel = next;
    input++;
  });

  const mix = ['[acat]'];
  (timeline.audio || []).forEach((track, j) => {
    const startMs = Math.round(Math.max(0, num(track.start, 0)) * 1000);
    const from = Math.max(0, num(track.in, 0));
    if (from) args.push('-ss', from.toFixed(3));
    if (track.out != null) args.push('-t', Math.max(0.05, num(track.out, 0) - from).toFixed(3));
    args.push('-i', track.src);
    filters.push(`[${input}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${num(track.volume, 1)},adelay=${startMs}|${startMs}[ax${j}]`);
    mix.push(`[ax${j}]`);
    input++;
  });
  if (mix.length > 1) filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  const aLabel = mix.length > 1 ? 'aout' : 'acat';

  args.push('-filter_complex', filters.join(';'), '-map', `[${vLabel}]`, '-map', `[${aLabel}]`,
    '-t', total.toFixed(3),
    // veryfast + crf 20: good quality without making a modest laptop wait minutes per reel.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', timeline.output);
  return args;
}

export async function renderTimeline(timeline, { onProgress, signal } = {}) {
  if (!timeline.output) throw new Error('The timeline needs an output path.');
  const plan = await planTimeline(timeline);
  const args = buildArgs(timeline, plan);
  await runFfmpeg(args, { signal, onProgress: secs => onProgress?.(Math.min(1, secs / plan.total)) });
  return { output: timeline.output, duration: plan.total, width: plan.width, height: plan.height };
}

// The final frame of a clip, e.g. to use as the start image for the next AI-generated clip.
export async function lastFrame(src, outPng) {
  await runFfmpeg(['-sseof', '-0.1', '-i', src, '-frames:v', '1', '-update', '1', outPng]);
  return outPng;
}
