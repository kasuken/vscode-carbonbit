# World art: "Two Rooms, One Wire"

The design philosophy behind the pixel world in `media/world/` (`scene.js`, `effects.js`, `renderer.js`).

## Philosophy

**Two Rooms, One Wire** is pastoral machinery: a quiet landscape holding two rooms with their walls cut
away, joined by a single sagging wire. On the left is a warm wooden room where a person works. On the
right is a cool concrete hall where machines answer. Nothing is hidden behind metaphor. The cable, the
power line, the water pipe and the vapour are the actual plumbing of a request, drawn plainly enough to
point at. The work should look like a hand-built cartridge scene: placed pixel by pixel, the kind of
image that only comes from painstaking hours at the grid.

**Form** comes from silhouettes that hold up at one pixel per unit. Every object is built from a few
deliberate runs, never from a soft shape that happened to come out of an algorithm. A head is eight
pixels of hair with an ear on each side. A server is a dark frame with five two-pixel drawers. A fan is a
ring with a cross inside it. Where something round is needed (foliage, clouds, vapour), it is made of
lobes shaded from the upper left, so the rounding stays crafted and does not turn into mush. Each sprite
should look finished at 1x before it is ever scaled up.

**Palette** is a master palette of about 35 colours in eight short ramps: slate, earth, green, teal,
rose, skin, signal blue and signal amber/yellow. Intermediate tones come from ordered 4x4 Bayer
dithering, never from new colours: the sky bands, the haze at the foot of the mountains and the
industrial veil are all made this way. Time of day is a palette swap in the old console sense. Each
phase (dawn, day, dusk, night) brings its own five-step sky and cloud ramp, and every outdoor ramp is
tinted toward that sky. The two interiors keep their own light, so at night they glow like lanterns.
Signal colours mean one thing each: cyan is a request, green is a reply or "done", yellow is power,
blue is water and amber is a problem. There is no red anywhere.

**Composition** is a triptych on a 160x90 grid. House and hall are the outer panels, and the open
meadow between them is a window onto deep space: mountains, then hills, then a pine line, then the
meadow, with a cut-away band of soil underneath. The wire droops from the house to a lone pole and
then to the hall, and a bird sits on it. Everything that moves is in the middle ground or the sky. The
foreground stays still, so the eye has somewhere to rest.

**Rhythm and motion** follow one rule: motion is information. When the world is idle it is almost
still. Clouds drift a pixel every couple of seconds, the cursor blinks, a standby light walks slowly
along the racks and the bird sometimes looks the other way, all at about one frame per second. Load
then shows up as more of the same vocabulary, and nothing new is invented for it. More racks light up,
more fans turn, more puffs rise, current pulses faster and more packets ride the wire. Warnings are
slow (a 0.7 s amber pulse) and nothing ever flashes. Every animated element is a pure function of
time, so the world can be stopped on any frame and still read correctly, and that is how it appears
under reduced motion.

## How states map to visuals

| State | What changes (still frame shows the same idea) |
| --- | --- |
| Idle | A bird sits on the wire and the clouds drift. The screen shows code with a slow cursor. One standby LED walks the dark hall. |
| RequestStarting | The developer types (shoulders bob) and a prompt line fills the screen. Cyan packets leave the router and ride the wire. The bird flies off, the first racks light up and the status lamp turns cyan. |
| ProcessingLight | Two racks are lit, with one fan, a little vapour, a slow water trickle and one pulse of current. The screen shows thinking dots. |
| ProcessingMedium | Four racks and two fans run, with steady vapour, faster water and current, and more traffic on the wire. |
| ProcessingHeavy | All six racks and every fan run, with large plumes, fast water, several pulses of current and a small spark at the floor riser. In `environmental` mode only, a static dithered haze fades in behind the buildings. |
| ResponseArriving | Green packets ride back to the house and green reply lines fill the screen, ending with a small check. The racks dim and the lamp turns green. |
| Failed | The amber lamp pulses slowly, one rack LED shows amber and the screen shows a short amber line. The last cyan packet stalls on the wire and fades out. No red, no shaking. |

- **Concurrency** (`activeCount`): each extra in-flight request (up to two) lights one more rack and adds
  one more packet and current pulse.
- **Settling**: after any state, Idle draws a short tail (the bird glides back, the amber lamp dims, the
  check lingers). After `IDLE_SETTLE_MS` the frame is identical whatever came before.
- **Modes**: `neutral` draws exactly the `environmental` frame without the haze. `minimal` hides the world
  and draws nothing.
- **Time of day**: `frame.hour` picks the phase (dawn 5–7, day 7–18, dusk 18–20, night 20–5). The
  renderer reads the clock on every state or visibility change and at most once a minute while
  animating. It caches one background per phase.

## Craft rules for future changes

- Draw only integer `fillRect` runs from palette keys. Never use gradients, alpha, `arc`, images or
  smoothing.
- Add colours to a ramp only when dithering cannot produce the tone you need. Keep signal colours
  single-purpose.
- New moving parts must be pure functions of the frame, must have a meaningful still pose and must not
  flash.
- Put anything static into `scene.js`, because it is cached. Keep per-frame work in `effects.js` small.
