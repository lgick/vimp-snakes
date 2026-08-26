import { Container, Graphics } from 'pixi.js';
import { SNAKE_COLORS } from '../../data/palette.js';
import { SNAKE } from '../../data/theme.js';

// One snake on the main canvas. The engine builds it from the `s1` snapshot
// block (src/config/client.js -> parts.gameSets) and feeds it the field array
// of that block, in the order of src/config/snapshot.js:
//
//   [p0x, p0y, … p15x, p15y, angle, radius, crystals, colour, flags]
//
// `flags` is the byte the schema still calls `boost`, and it carries two bits
// (core/src/game.rs, `boost_byte`): bit 0 the boost, bit 1 the spawn grace —
// the two seconds a fresh snake stands still, kills nobody and cannot be
// killed. Blinking is the only thing that says so on screen, so it is not
// decoration: a rival has to be able to see whom it is allowed to ignore.
//
// p0 is the head. The 16 points are a resample of the body the core actually
// simulates, evenly spaced from head to tail, so the curve drawn here is the
// same shape the core kills people against.
//
// The very same layout also arrives from the local prediction (the predicted
// tail of the hot buffer), so this class never learns whether the row it got is
// authoritative or a guess — and must not care.
const SPINE_POINTS = 16;
const SPINE_LEN = SPINE_POINTS * 2;

const FIELD = {
  ANGLE: SPINE_LEN,
  RADIUS: SPINE_LEN + 1,
  CRYSTALS: SPINE_LEN + 2,
  COLOR: SPINE_LEN + 3,
  FLAGS: SPINE_LEN + 4,
};

const FLAG_BOOST = 1;
const FLAG_GRACE = 2;

// The blink of the spawn grace: a sine between the two alphas below, four
// times a second. Rows arrive far more often than that, so the pulse is
// sampled by the frames themselves — no ticker of its own.
const GRACE_BLINK_HZ = 4;
const GRACE_ALPHA_MIN = 0.25;
// deliberately below 1: «in grace» has to be readable at every instant of the
// pulse, and the tests read the same difference
const GRACE_ALPHA_MAX = 0.85;

/// Alpha of a blinking snake at the moment it is drawn.
function graceAlpha(now) {
  const phase = (Math.sin((now / 1000) * GRACE_BLINK_HZ * Math.PI * 2) + 1) / 2;

  return GRACE_ALPHA_MIN + (GRACE_ALPHA_MAX - GRACE_ALPHA_MIN) * phase;
}

/// Darkens a hex colour towards black by `amount` (0..1).
function darken(color, amount) {
  const r = Math.round(((color >> 16) & 0xff) * amount);
  const g = Math.round(((color >> 8) & 0xff) * amount);
  const b = Math.round((color & 0xff) * amount);

  return (r << 16) | (g << 8) | b;
}

/// Catmull-Rom through the spine, `steps` subdivisions per segment. The 16
/// points are far apart on a long snake — 60 units or more — and a raw
/// polyline through them reads as a folded ruler, not as an animal.
function smooth(points, steps) {
  const last = points.length - 1;

  if (last < 1) {
    return points;
  }

  const out = [points[0]];

  for (let i = 0; i < last; i += 1) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, last)];

    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }

  return out;
}

export default class Snake extends Container {
  constructor(data, _assets, dependencies = {}, context = {}) {
    super();

    // Paint order is `zIndex` and nothing else: the engine marks the stage
    // sortable and calls stage.sortChildren() on every addChild, and PixiJS v8
    // sorts by zIndex there. A `layer` property alone does nothing at all.
    this.zIndex = 3;

    this._sound = dependencies.soundManager;

    // 'is this snake mine?' — asked at the moment a cue fires, never cached:
    // parts are built from the first shot, which precedes the first player
    // block, so the local snake is created while the engine still answers
    // null. See docs/ai/04-client-plugin.md § localPlayer.
    this._localPlayer = dependencies.localPlayer;
    this._id = context.id ?? null;

    this._body = new Graphics();
    this._head = new Graphics();

    this.addChild(this._body, this._head);

    // the graphics hold world coordinates directly, so the container itself
    // never moves — the head position has to be remembered rather than read
    // back off `this.x` / `this.y`, which stay at zero forever
    this._headAt = [0, 0];
    this._crystals = null;

    this.update(data);
  }

  update(data) {
    const radius = data[FIELD.RADIUS] || 1;
    const angle = data[FIELD.ANGLE] || 0;
    const crystals = data[FIELD.CRYSTALS] || 0;
    const flags = data[FIELD.FLAGS] || 0;
    const boosting = (flags & FLAG_BOOST) !== 0;
    const inGrace = (flags & FLAG_GRACE) !== 0;

    // the index is free-running on the wire, so the palette can grow without
    // the core ever learning how long it is
    const color = SNAKE_COLORS[(data[FIELD.COLOR] || 0) % SNAKE_COLORS.length];

    const points = [];

    for (let i = 0; i < SPINE_POINTS; i += 1) {
      points.push([data[i * 2] || 0, data[i * 2 + 1] || 0]);
    }

    // the whole snake pulses, head included — half a blinking snake reads as
    // a rendering bug rather than as a rule of the game
    this.alpha = inGrace ? graceAlpha(performance.now()) : 1;

    this._drawBody(points, radius, color, boosting);
    this._drawHead(points[0], angle, radius, color);

    // This snake just ate. The cue is played for the local player only —
    // everyone else's pickups are drawn but silent. Rows only arrive when the
    // count changed, so this cannot fire twice for one crystal.
    if (this._crystals !== null && crystals > this._crystals) {
      this._play('pickup', points[0]);
    }

    this._crystals = crystals;
    this._headAt = points[0];
  }

  _drawBody(points, radius, color, boosting) {
    const curve = smooth(points, SNAKE.smoothing);
    const graphics = this._body;

    graphics.clear();
    graphics.moveTo(curve[0][0], curve[0][1]);

    for (let i = 1; i < curve.length; i += 1) {
      graphics.lineTo(curve[i][0], curve[i][1]);
    }

    if (boosting) {
      // a wide soft halo under the body — the only tell that a snake is
      // burning crystals, and the reason to get out of its way
      graphics.stroke({
        color: SNAKE.boostGlow,
        width: radius * 2.6,
        alpha: 0.22,
        cap: 'round',
        join: 'round',
      });
    }

    graphics.stroke({
      color,
      width: radius * 2,
      cap: 'round',
      join: 'round',
    });

    // a darker core along the same path: cheaper than a gradient and enough to
    // stop a long snake reading as a flat ribbon
    graphics.stroke({
      color: darken(color, SNAKE.innerDarken),
      width: radius * 2 * SNAKE.innerScale,
      alpha: 0.45,
      cap: 'round',
      join: 'round',
    });
  }

  _drawHead([x, y], angle, radius, color) {
    const graphics = this._head;

    graphics.clear();

    graphics.circle(x, y, radius);
    graphics.fill(color);

    // eyes: perpendicular to the facing, pushed forward so the snake looks
    // where it is going
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const side = radius * 0.5;
    const forward = radius * 0.42;
    const eye = radius * 0.32;

    for (const sign of [-1, 1]) {
      const ex = x + nx * forward - ny * side * sign;
      const ey = y + ny * forward + nx * side * sign;

      graphics.circle(ex, ey, eye);
      graphics.fill(SNAKE.eye);

      graphics.circle(ex + nx * eye * 0.35, ey + ny * eye * 0.35, eye * 0.5);
      graphics.fill(SNAKE.pupil);
    }
  }

  /// True while this part draws the snake of the player sitting at this tab.
  /// A missing service means an engine older than the one this game is built
  /// against: say so once, out loud, and stay silent rather than play back
  /// the whole arena. Log, never throw — a part runs inside the render tick,
  /// and nothing on that path catches.
  _isLocal() {
    if (!this._localPlayer) {
      if (!this._warned) {
        this._warned = true;
        console.error(
          '[snakes] the `localPlayer` service is missing: engine too old, ' +
            'game cues stay silent',
        );
      }

      return false;
    }

    return this._localPlayer.is(this._id);
  }

  _play(name, [x, y]) {
    // Positional even though only the local snake is audible: the listener
    // sits on the head, so the pan is neutral and the distance ~0 — the same
    // call stays correct the day a cue is played for somebody else again.
    // The pool is 30 world voices ranked by priority² / distance².
    if (!this._sound || !this._isLocal()) {
      return;
    }

    this._sound.registerSound(name, { position: { x, y } });
  }

  destroy() {
    // A snake only leaves the canvas by crashing (the core sends a null row) —
    // or on a map change, which also resets the sound engine, so the burst of
    // cues that would produce never reaches the speakers. Audible for the
    // local player only: it is the sound of YOUR crash, not of the arena's.
    this._play('death', this._headAt);

    super.destroy({ children: true });
  }
}
