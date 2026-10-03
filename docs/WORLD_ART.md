# Pale Blue Pixel: art direction for the CarbonBit world

The sidebar shows one small planet: the Earth seen from space, drawn at 160 × 90 logical pixels in a
16-bit style. Code: [media/world/scene.js](../media/world/scene.js) (space, globe, moon),
[media/world/effects.js](../media/world/effects.js) (everything that moves) and
[media/world/renderer.js](../media/world/renderer.js) (layers, frame scheduling, accessibility).

## Philosophy

**One planet, one gesture.** CarbonBit is about what AI coding costs the Earth, so the Earth is the
picture. A single round shape reads at a glance in a narrow sidebar, where a diorama of small
props turns into noise. Everything else is a thin line of light on its surface.

**True, not decorative.** Day and night follow the real position of the sun for the current time and
season. City lights come on along the night side. The moon shows its real phase. Your pin sits at
your timezone's longitude. The data center is a real cloud region: one of a dozen places where large
data centers cluster, chosen about 70° from you so the arc reads well. It is illustrative and never
claims to be where your requests ran.

**Calm by default.** The planet does not spin, because spinning would hide your pin. Clouds drift, stars
twinkle, and now and then a satellite crosses. Work is shown as light and vapour at the data center,
never as damage to the planet. There is no red, no smoke and no flashing. Heavy load in
`environmental` mode warms the colour of the atmosphere, and the tint fades in once and then holds still.

**Pixel discipline.** The palette is limited. Shading uses three bands per surface (lit, shade and
night), joined by 4 × 4 ordered dithering, and the limb is one step darker so the sphere reads round.
Continents are coarse polygons rasterised to 2° cells, because recognisable beats accurate at this
size. Every mark is an integer `fillRect` run.

## Layers

| Layer | Redrawn | Content |
| --- | --- | --- |
| Space | Once | Night gradient, a faint glow hugging the planet, a deterministic starfield. |
| Globe | When the sun or clouds move (every 4 s) | Orthographic Earth with real day and night, drifting clouds, city lights, atmosphere rim and moon. |
| Moving | Every frame | Twinkles, satellite, your pin, the arc, packets, data-center glow and vapour, haze. |

The wall clock is read at most once a minute and extrapolated in between.

## States

| State | What you see |
| --- | --- |
| Idle | The planet, your white pin and a quiet data center. Stars twinkle, clouds drift, a satellite passes. |
| Request starting | Your pin's head turns cyan, and a cyan light runs along the arc toward the data center. |
| Processing (light, medium, heavy) | Light streams along the arc (more streams for more concurrent requests). The data center's windows light up, a gold glow spreads around it, and cooling vapour rises. All of it grows with load. |
| Response arriving | The arc turns green and a green light returns to your pin, which lands with a soft ring. |
| Failed | The data center shows a slow amber light, and the request stops halfway. |

With reduced motion, or with animation turned off, each state has its own still frame. Moving elements
freeze at representative positions and the time-dependent ones (twinkles, satellite) are left out.

## Colour meanings

| Colour | Meaning |
| --- | --- |
| Cyan | A request on its way. |
| Green | A reply. |
| Gold | Power at the data center. |
| White-grey | Cooling vapour. |
| Amber | Something needs attention. |
| Warm brown (environmental mode only) | Atmosphere under heavy load. |
