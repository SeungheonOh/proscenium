# Motion as response curves

**Status:** proposed, not implemented. A prototype, run against today's
[`motion.c`](../src/motion.c), produced the numbers [below](#measured).
[PROTOCOL.md](PROTOCOL.md#motions) and [GUIDE.md](GUIDE.md#animation) still
describe the motions as they are.

## Why

The compositor knows four motions: `spring`, `tween`, `curve` and the decay a
fling uses. Each is a branch in `motion_state`, a set of fields in
`struct motion` and a case in `decode_motion`, so a new kind of movement, such
as a smoother that never overshoots or a friction curve, changes the protocol
and both of its ends. The aim is one general shape a world can write itself:

```ts
type Motion =
  | { type: "curve"; duration: number; curve: Curve }
  | { type: "dynamic"; initialize(from: number, velocity: number): State;
      step(state: State, target: number, dt: number): State };
type State = { position: number; velocity: number };
```

There are two constraints:

- **No slowdown.** A settled channel asks for nothing, and a moving one is
  sampled every frame. A spring today is a closed form, exact at any frame rate,
  at 9 to 24 ns a sample.
- **No code from the director.** Shaders could be general because GLSL is a
  language the compositor already runs. Motion has no such language. Sending
  `step` as a formula or as bytecode means an interpreter on the frame clock.

### Rejected: running the step in the compositor

An interpreted RK4 step costs about 121 ns. At 240 steps a second, that is
about 29 µs per channel per second of animation, against about 2 µs for
today's closed form at the same rate. Cheaper steps are not accurate enough: a
semi-implicit Euler step at 240 Hz is 3.7% off the exact spring, and at 60 Hz a
stiff spring (stiffness 4000) diverges. Running the step would also replace an
exact closed form with an approximation.

## The idea: a linear motion is two curves

Every motion the compositor runs today is *linear*:

- from twice the distance it moves twice as far;
- a move that starts with both distance and speed is the two moves added.

A linear motion is therefore known completely by two responses:

- **D(t):** how it leaves distance 1 at rest;
- **V(t):** how it leaves the target at speed 1.

A move from distance `d` at velocity `v` is then

```
value(t)    = target + d·D(t)  + v·V(t)
velocity(t) =          d·D′(t) + v·V′(t)
```

What a channel keeps when retargeted is what it keeps today: where the value is
and how fast it goes. Only `start_value` becomes `start_distance`. Each existing
kind is a pair of curves:

| Motion | D | V |
| --- | --- | --- |
| spring | the closed form from (1, 0) | the closed form from (0, 1) |
| tween | 1 − ease(t / duration) | 0: a tween ignores the speed it starts with, as today |
| curve | 1 − points, straight between them | 0 |
| decay (fling) | e^(−t/τ) | 0: first order, so the fling sets its target to x + v·τ |
| dynamic | the world's `step`, simulated from (1, 0) | simulated from (0, 1) |

The compositor then plays curves and never formulas. Springs, tweens and flings
build theirs inside the compositor from today's parameters, so the wire does
not change for them. A world's own dynamic is simulated once in the SDK and sent
as numbers.

Motions that are not linear are excluded:

- bouncing off the target;
- clamping at the target;
- speed limits.

The SDK refuses them when they are defined, and they stay director-driven, as
they are today.

## Writing a dynamic

The SDK accepts the shape above. `State` may carry state of its own besides
position and velocity:

```ts
export interface DynamicDefinition<S extends State = State> {
  initialize?(from: number, velocity: number): S;
  step(state: S, target: number, dt: number): S;
}
```

When a move is interrupted, only position and velocity carry over into the next
one. `initialize` therefore rebuilds the extra state from those two. For
example, three smoothers in a row give an S-shaped follow that starts softer
than any spring and never overshoots:

```ts
const follow = (seconds: number): DynamicDefinition<State & { inner: number; outer: number }> => ({
  initialize(from, velocity) {
    // The stage before the value is where its velocity leads; the one before that, the same.
    const inner = from + seconds * velocity;
    return { position: from, velocity, inner, outer: inner };
  },
  step(state, target, dt) {
    const k = dt / seconds;
    const outer = state.outer + (target - state.outer) * k;
    const inner = state.inner + (outer - state.inner) * k;
    const position = state.position + (inner - state.position) * k;
    return { position, velocity: (inner - position) / seconds, inner, outer };
  },
});

const trailing = follow(0.05);
const trail = dynamic(trailing);  // built and checked here, once

<Rect x={x} y={y} transition={{ x: trail, y: trail, opacity: tween(0.15, "ease-out") }} />
<Group x={-offset} transition={dynamic(trailing, { velocity: released })} />
```

`dynamic(definition, {delay, velocity, rate})` builds the definition's response
the first time it sees that definition object, caches it, and returns a motion.
`spring`, `tween` and `instant` are unchanged. Building takes five steps:

1. **Simulate.** Run `step` toward a target at 0, in steps of 1/8000 s, from
   (1, 0) for D and from (0, 1) for V. Sample both `rate` times a second
   (default 240) as value and slope pairs. Slopes come from the positions
   (central differences), not from the velocity the step reports. The curve is
   then its own derivative, so the velocity a new move inherits is the one
   that was on screen.
2. **Check linearity.** Run two more moves, from (−2, 0) and from (1, 1). They
   must equal −2·D and D + V within 1e-6, or `dynamic` throws a `TypeError`
   that names the rule.
3. **Trim at rest.** Cut both curves once each stays within 1e-5 of zero, with
   V judged against its own peak. A motion not at rest within 10 seconds is
   refused.
4. **Name it.** The id is a hash of the curves, so equal definitions share one
   response.
5. **Send it.** As for shaders, the host sends the `response` op before the
   first commit that uses it, once per compositor, and again after a resync.

## Wire

A director defines a response once by id:

```json
{"op":"response","id":"y1c6pk","rate":240,"d":[1,0,0.99990,-0.0658,…],"v":[0,1,0.0040,0.9167,…]}
```

| Field | Rule |
| --- | --- |
| `rate` | Samples per second, 30 to 1000. |
| `d`, `v` | Value and slope pairs, `[D(0), D′(0), D(1/rate), D′(1/rate), …]`. Both have the same number of pairs, at least 2, covering at most 10 seconds. All are finite. |

A motion uses it by id:

```json
{"type":"response","id":"y1c6pk","delay":0,"velocity":-1200}
```

`delay` and `velocity` mean what they mean for a spring. An unknown id is a
protocol error. Past its last pair a response is at rest. A response that does
not end near zero ends with a jump to the target, which the SDK never sends.

`spring`, `tween` and `curve` keep their wire form. Both additions are a new op
and a new motion type, which old directors never send, so the protocol stays at
version 3. Responses live as long as the compositor, as shader definitions do.

## Compositor

### Storage

A response keeps D and V as cubic segments, one for each 1/rate seconds:

```c
struct response {
    int references;
    int segments;
    double rate;
    /* Per segment: the curve as a cubic in u = 0..1 across it. */
    double (*d)[4], (*v)[4];
};
```

Value and slope pairs become segments by cubic Hermite interpolation. Over a
segment `h` seconds long, from `y0` at slope `s0` to `y1` at slope `s1`, the
coefficients are:

```
c0 = y0
c1 = h·s0
c2 = 3(y1 − y0) − h(2·s0 + s1)
c3 = 2(y0 − y1) + h(s0 + s1)
```

The built-in kinds build their responses in the compositor:

| Builder | From | Rate |
| --- | --- | --- |
| `response_spring(stiffness, damping, mass)` | today's `spring_state`, at (1, 0) and (0, 1); the last 16 are cached | max(120, 6·ω) a second: six samples a radian |
| `response_tween(duration, ease)` | today's bezier solver | at least 120 a second, in whole segments over the duration, so repeats start on a segment's edge |
| `response_points(duration, count, points)` | `curve` points, as straight segments (c2 = c3 = 0) | one segment per point: exactly today's curves, `steps()` included |
| `response_decay(τ)` | e^(−t/τ) | max(120, 6/τ) a second |
| `response_from_samples(rate, count, d, v)` | the `response` op | as sent |

The tween's slope at its ends uses the ratio of second derivatives where both
first derivatives vanish, as at the start of `ease-out`. Today's tween reports
a velocity of 0 there.

### Sampling

`struct motion` keeps only what is not the curve: the response (NULL for an
instant change), `delay`, `repeat`, the optional start `velocity` and the fling's
`rest`. One function replaces the per-kind switch:

```c
static bool response_sample(const struct response *response, double distance, double velocity,
                            double elapsed, double *offset, double *speed) {
    double position = elapsed * response->rate;
    int index = (int)position;
    if (index >= response->segments) return false;
    double u = position - index, rate = response->rate;
    const double *d = response->d[index], *v = response->v[index];
    *offset = distance * (((d[3] * u + d[2]) * u + d[1]) * u + d[0]) +
              velocity * (((v[3] * u + v[2]) * u + v[1]) * u + v[0]);
    *speed = rate * (distance * ((3 * d[3] * u + 2 * d[2]) * u + d[1]) +
                     velocity * ((3 * v[3] * u + 2 * v[2]) * u + v[1]));
    return true;
}
```

`channel_sample` handles the rest once for every kind:

- **Delay:** it holds the starting value.
- **Repeat:** it starts each run of a repeating tween over.
- **Rest:** a motion settles past the last segment, or, if it does not repeat,
  once it is within the channel's tolerance (or the fling's `rest`) and nearly
  still, as springs settle today.

`channel_retarget` stores `value − target` and the velocity (the motion's own
`velocity` if it has one). `channel_fling` retargets with a decay response, to
`value + velocity·τ`. `channel_jump`, `channel_inherit`, keeping the trajectory
when the destination is unchanged, and keyframe tracks stay as they are.

### What moves where

| Where | Change |
| --- | --- |
| `motion.c`, `motion.h` | `struct response` and its builders. `struct motion` slims to the fields above. `motion_state` and its kinds go. `spring_state` and the bezier solver now run only when a response is built. A little larger than today, for the builders. |
| `props.c` | `decode_motion` builds a response for each kind and looks up `response` ids. |
| `link.c` | The `response` op and a registry by id, like the shaders'. |
| `sdk/src/motion.ts` | `DynamicDefinition`, `dynamic`, the builder, and a `response` member of `Motion`. |
| `sdk/src/host.ts` | Sends definitions before use, like `shaderOps`. |
| `PROTOCOL.md`, `GUIDE.md` | The op, the motion type, `dynamic`. |

## Measured

These numbers are from the prototype: the proposed `motion.c` linked beside
today's unchanged one, both channels run through the same moves and compared
every millisecond.

**Fidelity.** Each spring went 0 → 1000 px, was turned toward 300 px at 120 ms,
then handed over toward 600 px at −6000 px/s at 300 ms. Each tween ran 0 → 1
and was turned back halfway.

| Motion | Segments | Largest difference from today | Settles |
| --- | --- | --- | --- |
| niri's spring, stiffness 800, critically damped | 95 at 170 Hz | 0.005 px | the same millisecond |
| stiffness 1000, critically damped | 95 at 190 Hz | 0.005 px | the same |
| stiffness 500, damping ratio 0.6 | 130 at 135 Hz | 0.003 px | the same |
| stiffness 4000, critically damped | 95 at 380 Hz | 0.005 px | the same |
| react-spring's default (170, 26) | 143 at 120 Hz | 0.001 px | the same |
| `ease`, `linear` tweens | | 0.00001 | the same |
| `ease-out` tween, 150 ms | | 0.0002 | the same |
| `easeOutExpo` and `steps(4)` curves | | 0 | the same |
| fling, 3000 px/s, τ = 325 ms | | 0 | the same |

**Dynamics.** A response played by the compositor was compared with the
world's own `step` run directly, through the same interrupted moves:

| Dynamic | Samples (240 Hz) | At rest after | Largest difference |
| --- | --- | --- | --- |
| a spring by Newton, semi-implicit Euler, stiffness 800 | 132 | 0.55 s | 0.008 px |
| `follow(0.05)` | 207 | 0.86 s | 0.010 px |

The Euler spring is itself 1.08 px off the exact spring. That is its
integrator's error, and the response reproduces it.

**Cost.** One `channel_sample` in the middle of a move:

| Motion | Response | Today |
| --- | --- | --- |
| spring, critically damped | 7.2 ns | 8.7 ns |
| spring, damping ratio 0.6 | 5.6 ns | 23.9 ns |

Every kind costs the same two cubic evaluations, whatever made it.

**Memory and wire.**

- A spring's response takes about 6 KB, shared by every channel using it.
- In the SDK, building a dynamic takes about 8 ms, once per definition.
- A definition is about 18 KB of JSON, sent once per compositor.

## Questions for review

- **Linear only.** Bounces, clamps and speed limits are refused when defined.
  They stay director-driven, or would have to come back as built-in kinds.
- **Extra state at interruptions.** Only position and velocity carry over, so a
  third-order dynamic like `follow` loses its acceleration when retargeted. The
  velocity stays continuous, and `initialize` decides how the extra state is
  rebuilt.
- **Tweens ignore speed.** V = 0 keeps today's behaviour: an interrupted tween
  starts from the value shown at rest. A V that absorbs the incoming speed over
  the tween's first part would make tweens continuous too, but it changes how
  they look.
- **Rate for dynamics.** 240 Hz suits motions up to about 40 radians a second.
  A stiffer dynamic needs `rate`, or the builder could choose one itself by
  building twice and comparing.
- **Build time and size.** Simulating stops at 10 seconds, not at rest:
  stopping at rest would cut a build to about 1 ms. Rounding the numbers to
  seven significant digits would about halve a definition.
- **Spring cache.** The compositor keeps the last 16 springs. A world making
  new spring parameters every render (for example `spring({duration})` from
  live values) builds a response each time, which costs tens of microseconds and
  about 6 KB for as long as it is used.
- **Registry lifetime.** Definitions are never collected, as with shaders.
