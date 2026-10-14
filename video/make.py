#!/usr/bin/env python3
"""Adds narration and captions to a screen recording of one FOREMAN chit run.

The narration is written after the run, from what actually happened: each line is tied to a moment in the
app's own log (the first debit, the first hammer, the declined instalment, ...), so voice and captions follow the
picture, and the figures spoken are the figures on screen.

    python3 video/make.py --video export.mp4 --rec-start-ms 1791170000000 --state state.json --out final.mp4

--rec-start-ms is the wall-clock time (epoch ms) of the recording's first frame.
--state is a saved copy of GET /api/state taken after the run.
With no --speed, the picture is paced to the narration automatically: quiet stretches are sped up and
moments that pass too quickly are slowed down. --speed 40:95:2.5 sets the stretches by hand instead.
Needs macOS, ffmpeg, and Google Chrome for drawing the caption images. The voice is macOS `say` by default,
or a local VoiceStudio server (https://github.com/debpalash/VoiceStudio) with --voicestudio-profile.
"""
import argparse, array, json, os, re, subprocess, time, wave
from datetime import datetime

VOICE, RATE = "Samantha", "178"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H, FPS = 1920, 1080, 30
REVEAL_GAP = 0.42  # the page shows log entries one at a time, this far apart


def inr(paise):
    """Indian grouping: ₹3,72,500."""
    n = round(paise / 100)
    s = str(n)
    if len(s) <= 3:
        return "₹" + s
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:]); head = head[:-2]
    if head:
        groups.insert(0, head)
    return "₹" + ",".join(groups) + "," + tail


def reveal_times(state, rec_start_ms):
    """When each log entry appeared on screen, in seconds from the start of the recording (the page polls each second)."""
    out = []
    for e in state["events"]:
        if e["month"] is None:
            continue
        at = datetime.fromisoformat(e["at"].replace("Z", "+00:00")).timestamp() * 1000
        out.append(((at - rec_start_ms) / 1000 + 0.6, e))
    return out


def script(state, shown):
    """The narration lines as (earliest time, text). Lines whose moment never happened are left out."""
    def first(kind, month=None):
        return next((t for t, e in shown if e["kind"] == kind and (month is None or e["month"] == month)), None)

    chit, draws, members = state["chit"], state["draws"], {m["id"]: m for m in state["members"]}
    name = lambda i: "the foreman" if i == "foreman" else members[i]["name"].split(" ")[0]
    gross, inst = chit["gross"], state["instalment"]
    d2 = next((d for d in draws if d["month"] == 2), None)
    last = draws[-1] if draws else None
    pct = lambda paise: f"{round(paise / gross * 10000) / 100:g} percent"
    done = state["chit"]["status"] == "complete"

    lines = [
        (1.0, f"Ten people in Lakshmi Nagar save together in a chit. {inr(inst)} a month each, and every month the {inr(gross)} pot goes to whoever gives up the biggest discount. In India this still runs on WhatsApp and trust."),
        (None, "FOREMAN runs it on Razorpay. Each subscriber has an AI agent that works only from its owner's own words."),
        (first("debit", 1) if first("debit", 1) is not None else first("link", 1), "Every month, every ticket gets a real Razorpay order, created live in test mode, and Hathi, the foreman, counts the instalments in as they are paid."),
        (first("hammer", 1), "Month one goes to the foreman at the floor discount, as the chit agreement says."),
        (first("auction", 2), "Month two, the agents bid. Meena needs a shop deposit now, so her agent goes high. Kamala is saving, so hers never bids."),
    ]
    if d2:
        lines.append((first("hammer", 2), f"The auction is settled in code: the winner pays one step above the runner-up. {name(d2['winner'])} takes {inr(d2['prize'])} at {pct(d2['discount'])}, and everyone's next instalment falls by {inr(d2['share'])}."))
    lines += [
        (first("payout", 2), "The prize goes out as a payout under an idempotency key. This merchant has no RazorpayX, so that leg runs on the simulated rail; with RazorpayX it is the same call."),
        (first("minutes", 2), "And the minutes the Chit Funds Act asks for are written from the same figures that moved."),
    ]
    if first("declined") is not None:
        lines.append((first("declined"), "A declined debit becomes a payment link with reminders, and that ticket sits out the auction until it pays."))
    if first("hammer", 4) is not None:
        lines.append((first("hammer", 4), "Month after month: Imran before Diwali, Priya for her oven, Fatima for the college fee. The agents decide how keen. The code decides the money."))
    if done and last:
        lines.append((first("done"), f"Ten months. Every rupee collected went out as prize or commission, every subscriber was prized once, and every draw stayed inside the Act. FOREMAN: AI agents run the chit, and Razorpay carries the money."))
    out = []
    for i, (t, text) in enumerate(lines):
        if t is None and i != 1:
            continue
        out.append((t, text))
    return out


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "- - twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n):
    """A whole number written out the Indian way (lakh, crore), so a speech model cannot misread the digits."""
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("-" + ONES[n % 10] if n % 10 else "")
    if n < 1000:
        return ONES[n // 100] + " hundred" + (" " + words(n % 100) if n % 100 else "")
    if n < 100000:
        return words(n // 1000) + " thousand" + (" " + words(n % 1000) if n % 1000 else "")
    if n < 10000000:
        return words(n // 100000) + " lakh" + (" " + words(n % 100000) if n % 100000 else "")
    return words(n // 10000000) + " crore" + (" " + words(n % 10000000) if n % 10000000 else "")


def spoken_form(text):
    text = re.sub(r"₹([\d,]+)", lambda m: words(int(m.group(1).replace(",", ""))) + " rupees", text)
    text = re.sub(r"(\d+)\.(\d+) percent", lambda m: f"{words(int(m.group(1)))} point {' '.join(ONES[int(c)] for c in m.group(2))} percent", text)
    return re.sub(r"\b(\d+)\b", lambda m: words(int(m.group(1))), text)


def speak(text, path, voice=VOICE, rate=RATE, profile=None):
    """Writes one narration line to a 44.1 kHz mono WAV and returns its length in seconds.

    With a profile, the line comes from a local VoiceStudio server (open source, runs on this machine):
    two takes, keeping the one whose length is closest to a natural speaking rate. Otherwise macOS `say`.
    """
    if not profile:
        subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", path, "--data-format=LEI16@44100", text], check=True)
    else:
        line = spoken_form(text)
        want, best = len(line.split()) / 2.75, None
        for seed in (11, 29):
            raw = f"{path}.{seed}.raw"
            subprocess.run(["curl", "-sS", "-f", "-m", "600", "-X", "POST", "http://127.0.0.1:3900/generate", "-F", "text=<-", "-F", "language=en",
                            "-F", f"profile_id={profile}", "-F", f"seed={seed}", "-F", "num_step=32", "-F", "guidance_scale=2.0",
                            "-F", "class_temperature=0.5", "-F", "effect_preset=raw", "-o", raw], input=line.encode(), check=True)
            take = f"{path}.{seed}.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", take], check=True)
            os.remove(raw)
            with wave.open(take) as w:
                length = w.getnframes() / w.getframerate()
            if best is None or abs(length - want) < abs(best[0] - want):
                best = (length, take)
        # Bring every line to the same peak level, so the narration does not jump in volume between lines.
        with wave.open(best[1]) as w:
            samples = array.array("h", w.readframes(w.getnframes()))
        gain = 0.85 * 32767 / max(1, max(abs(x) for x in samples))
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
            w.writeframes(array.array("h", (int(max(-32767, min(32767, x * gain))) for x in samples)).tobytes())
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def captions_for(text, start, duration):
    """Splits a line into sentence-sized captions, each on screen for its share of the speaking time."""
    parts = [p.strip() for p in re.split(r"(?<=[.])\s+", text) if p.strip()]
    total = sum(len(p) for p in parts)
    out, t = [], start
    for p in parts:
        d = duration * len(p) / total
        out.append((t, t + d, p))
        t += d
    return out


def draw_caption(text, png, workdir):
    html = os.path.join(workdir, "caption.html")
    safe = text.replace("&", "&amp;").replace("<", "&lt;")
    with open(html, "w") as f:
        f.write(f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;width:{W}px;height:{H}px;background:transparent;overflow:hidden}}
.c{{position:absolute;left:0;right:0;bottom:56px;display:flex;justify-content:center}}
.c span{{max-width:1560px;padding:14px 34px;border-radius:999px;background:rgba(10,10,10,.94);color:#f7d117;
font:600 36px/1.3 -apple-system,"SF Pro Display","Helvetica Neue",sans-serif;text-align:center}}
</style><div class="c"><span>{safe}</span></div>""")
    if os.path.exists(png):
        os.remove(png)
    # Headless Chrome writes the image and then sometimes fails to exit, so it is stopped once the file is there.
    proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={workdir}/chrome-profile",
                             f"--window-size={W},{H}", "--default-background-color=00000000", f"--screenshot={png}", f"file://{html}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        if os.path.exists(png) and os.path.getsize(png) > 0:
            break
        time.sleep(0.1)
    time.sleep(0.3)
    proc.kill()
    if not os.path.exists(png):
        raise RuntimeError(f"Chrome did not draw the caption: {text}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--rec-start-ms", type=float, required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speed", action="append", default=[], help="start:end:factor in source seconds")
    ap.add_argument("--end", type=float, help="cut the source here (seconds)")
    ap.add_argument("--voice", default=VOICE, help="a macOS voice name, as listed by: say -v '?'")
    ap.add_argument("--rate", default=RATE, help="speaking rate in words per minute")
    ap.add_argument("--voicestudio-profile", help="narrate with this voice profile from a VoiceStudio server on localhost:3900")
    ap.add_argument("--max-speed", type=float, default=8.0, help="fastest a quiet stretch may play when pacing automatically")
    args = ap.parse_args()

    workdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
    os.makedirs(workdir, exist_ok=True)
    state = json.load(open(args.state))
    shown = reveal_times(state, args.rec_start_ms)

    src_len = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", args.video]))
    end = min(args.end or src_len, src_len)
    lines = script(state, shown)
    spoken = [speak(text, os.path.join(workdir, f"line{n:02d}.wav"), args.voice, args.rate, args.voicestudio_profile) for n, (_, text) in enumerate(lines)]

    if args.speed:
        fast = sorted((float(a), float(b), float(f)) for a, b, f in (s.split(":") for s in args.speed))
        pieces, cursor = [], 0.0
        for a, b, f in fast:
            if a > cursor:
                pieces.append((cursor, a, 1.0))
            pieces.append((a, min(b, end), f))
            cursor = b
        if cursor < end:
            pieces.append((cursor, end, 1.0))
    else:
        # Pace the picture to the narration: the stretch between two narrated moments plays as fast (or as slow)
        # as it takes for the next moment to arrive just as the narrator finishes the lines before it.
        anchors = []  # (source time, seconds of narration that belong to this moment)
        for (t, _), d in zip(lines, spoken):
            if t is None:
                anchors[-1][1] += d + 0.3
            else:
                anchors.append([max(t, anchors[-1][0] + 0.05) if anchors else t, d + 0.3])
        pieces = [(0.0, anchors[0][0], 1.0)] if anchors[0][0] > 0 else []
        for (a, talk), nxt in zip(anchors, anchors[1:]):
            pieces.append((a, nxt[0], min(max((nxt[0] - a) / talk, 0.25), args.max_speed)))
        end = min(end, anchors[-1][0] + anchors[-1][1] + 1.0)
        pieces.append((anchors[-1][0], end, 1.0))

    def warp(t):
        out = 0.0
        for a, b, f in pieces:
            if t <= a:
                break
            out += (min(t, b) - a) / f
        return out

    # Lay the lines out in order: each starts at its moment (after speed-ups), never before the last one ends.
    timeline, clock = [], 0.0
    for n, ((t, text), dur) in enumerate(zip(lines, spoken)):
        wav = os.path.join(workdir, f"line{n:02d}.wav")
        start = max(warp(t) if t is not None else clock, clock)
        timeline.append((start, dur, text, wav))
        clock = start + dur + 0.3
    total = max(warp(end), clock + 0.5)

    # One audio track with every line in place.
    rate = 44100
    track = bytearray(int(total * rate) * 2)
    for start, dur, text, wav in timeline:
        with wave.open(wav) as w:
            data = w.readframes(w.getnframes())
        at = int(start * rate) * 2
        track[at:at + len(data)] = data[: len(track) - at]
    voice = os.path.join(workdir, "voice.wav")
    with wave.open(voice, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(track))

    caps = [c for start, dur, text, _ in timeline for c in captions_for(text, start, dur)]
    inputs, chain = ["-i", args.video, "-i", voice], []
    segs = []
    for i, (a, b, f) in enumerate(pieces):
        chain.append(f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{f}[s{i}]")
        segs.append(f"[s{i}]")
    chain.append(f"{''.join(segs)}concat=n={len(segs)}:v=1:a=0,fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0C0C0C,tpad=stop_mode=clone:stop_duration={max(0.0, total - warp(end)):.2f}[v0]")
    last = "[v0]"
    for n, (a, b, text) in enumerate(caps):
        png = os.path.join(workdir, f"cap{n:02d}.png")
        draw_caption(text, png, workdir)
        inputs += ["-i", png]
        chain.append(f"{last}[{n + 2}:v]overlay=0:0:enable='between(t,{a:.2f},{b:.2f})'[v{n + 1}]")
        last = f"[v{n + 1}]"

    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(chain),
                    "-map", last, "-map", "1:a", "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", args.out], check=True)

    for start, dur, text, _ in timeline:
        print(f"{start:6.1f}s  {dur:4.1f}s  {text}")
    print(f"\n{args.out}: {total:.1f}s" + ("  OVER THREE MINUTES" if total >= 180 else ""))


if __name__ == "__main__":
    main()
