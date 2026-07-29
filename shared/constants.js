// Shared tuning constants. Imported as an ES module by both the Node server
// and the browser client, so gameplay numbers can never drift apart.

export const TICK_RATE = 20; // server snapshots per second
export const TICK_MS = 1000 / TICK_RATE;

// ---------------------------------------------------------------- world
export const CITY = {
  GRID: 7, // city blocks per side
  BLOCK: 70, // buildable footprint of a block
  ROAD: 24, // road width between blocks
  HIGHWAY_Y: 30, // deck height of the elevated highways
};
CITY.CELL = CITY.BLOCK + CITY.ROAD;
CITY.SIZE = CITY.GRID * CITY.CELL;
CITY.HALF = CITY.SIZE / 2;

export const GRAVITY = 30;
export const PLAYER = {
  RADIUS: 0.75,
  HEIGHT: 3.4,
  EYE: 2.9,
  WALK: 13,
  SPRINT: 21,
  ACCEL: 90,
  AIR_ACCEL: 26,
  FRICTION: 11,
  JUMP: 13.5,
  MAX_FALL: 90,
  WALL_SLIDE: 4.5, // downward speed while clinging to a wall
  WALL_JUMP: 15,
};

// ---------------------------------------------------------------- camera
// Third-person shoulder rig, Fortnite style. The arm still points along the
// aim direction — that is what keeps the crosshair honest — but it is offset
// to the right and slightly up so the hero sits low and left of centre instead
// of squatting on top of the reticle.
export const CAMERA = {
  SHOULDER: 2.15, // offset to the camera's right
  RISE: 0.5, // pivot height above the eye
  MIN_DISTANCE: 2.4, // closest the collision spring arm may pull in
  HIDE_HERO: 3.6, // hide the model once the arm is shorter than this
  FOV: 66,
  FOV_SPEED_FROM: 20, // speed where the FOV starts to widen
  FOV_SPEED_GAIN: 0.34,
  FOV_SPEED_MAX: 13, // how much extra FOV top speed can buy
};

// ---------------------------------------------------------------- webbing
export const WEB = {
  MAX_LENGTH: 110, // how far a swing line can reach
  // Shortest the line can ever get. A rope of a few metres is a pirouette, not
  // a swing — this is the floor that keeps arcs wide.
  MIN_LENGTH: 18,
  REEL_SPEED: 14, // rope shortening while holding C
  // The line hauls itself in on the way down through an arc, the way you pump
  // a swing by standing up at the bottom, and eases off once you are rising so
  // it never drags you up into the anchor. Nothing to hold.
  AUTO_REEL: 11,
  // ...but only down to this share of the line you fired, never past the
  // absolute floor. Left to run all the way in, an automatic reel ends every
  // swing on a short rope spinning fast — the exact thing that made swinging
  // feel out of control — and a flat floor throws away the difference between
  // a long arc off a tower and a short hop between shopfronts.
  AUTO_REEL_KEEP: 0.72,
  AUTO_REEL_MIN: 34,
  SWING_ACCEL: 34, // player steering force mid-swing
  // Gravity while hanging on a line. Walking gravity is 30 — three times
  // Earth's — which is right for a punchy jump and completely wrong for an
  // arc: it drops you out of every swing before it has finished. Lighter here
  // is what turns a plummet into a glide, and it takes the top speed down with
  // it, because a swing's speed is bought with height.
  SWING_GRAVITY: 16,
  // Drag along the arc, per second. A soft ceiling reads better than a clamp:
  // speed settles at a cruise instead of pinning.
  SWING_DRAG: 0.16,
  // The bottom of an arc sits at (anchor height - rope length). Fire a long
  // line at a low anchor and that lands under the pavement, which is why
  // swings kept ending in a scrape along the street. The line quietly takes up
  // slack until the arc clears this much ground.
  GROUND_CLEARANCE: 13,
  RELEASE_BOOST: 1.04,
  // Letting go converts a slice of the swing into lift, so a release carries
  // you up into the next arc rather than dumping you in the street.
  RELEASE_LIFT: 11,
  ZIP_SPEED: 62, // web-zip pull speed
  ZIP_ARRIVE: 5,
};

// ---------------------------------------------------------------- combat
export const COMBAT = {
  MAX_HEALTH: 100,
  SHOT_DAMAGE: 15,
  SHOT_SPEED: 140,
  SHOT_GRAVITY: 6, // web balls droop a little; the client aims off this
  SHOT_RADIUS: 0.55,
  // Hit volume: a vertical capsule rather than one sphere at the navel, so a
  // shot at the head or the feet of a swinging hero counts.
  HIT_RADIUS: 1.35,
  HIT_LOW: 0.9, // capsule endpoints, measured up from the feet
  HIT_HIGH: 2.8,
  // How far back the server will rewind the world to judge a client's shot.
  // Covers the client's own interpolation delay plus half its round trip.
  LAG_COMP_MAX: 0.3,
  // Bullet magnetism. A shot fired within this cone of an enemy is nudged onto
  // them — enough to forgive a shaky reticle mid-swing, not enough to aim for
  // you (it never leads a moving target).
  AIM_ASSIST_ANGLE: 0.055, // ~3.2 degrees
  AIM_ASSIST_RANGE: 130,
  AIM_ASSIST_STRENGTH: 0.7,
  FIRE_COOLDOWN: 0.22,
  FLUID_MAX: 100,
  FLUID_PER_SHOT: 7,
  FLUID_PER_ZIP: 14,
  FLUID_REGEN: 17, // per second
  PROJECTILE_LIFE: 2.6,
  IMPACT_SLOW: 0.55, // hit players get briefly gunked up
  IMPACT_SLOW_TIME: 1.1,
};

// ---------------------------------------------------------------- match
export const MATCH = {
  MIN_PLAYERS: 2,
  BOT_FILL: 7, // bots are added so a solo player still gets a real match
  MAX_PLAYERS: 16,
  LOBBY_WAIT: 8, // seconds of lobby once enough players are present
  COUNTDOWN: 5,
  END_SCREEN: 12,
  SPAWN_HEIGHT: 4,
};

// Shrinking "web storm". Each phase holds, then shrinks to the next radius.
export const STORM = {
  DAMAGE_START: 2.5, // hp/sec outside the safe zone in phase 1
  DAMAGE_RAMP: 1.6, // added per phase
  // Once the last phase is done the zone closes to nothing over this many
  // seconds. Holding a small final ring forever only worked while everyone was
  // shooting at each other; it leaves a match that can never end otherwise.
  FINAL_COLLAPSE: 22,
  PHASES: [
    { hold: 35, shrink: 30, radius: 0.72 },
    { hold: 28, shrink: 26, radius: 0.5 },
    { hold: 24, shrink: 22, radius: 0.32 },
    { hold: 20, shrink: 20, radius: 0.18 },
    { hold: 18, shrink: 18, radius: 0.08 },
    { hold: 15, shrink: 15, radius: 0.02 },
  ],
};

// ---------------------------------------------------------------- skins
// Each player gets one of these cartoon superhero palettes.
export const SKINS = [
  { name: 'Spoodermin', primary: 0xd52b2b, secondary: 0x1b3fb8, accent: 0x101828, eye: 0xffffff },
  { name: 'Nightweaver', primary: 0x1b1b24, secondary: 0x3d3d52, accent: 0xe8e8f0, eye: 0xdfe6ff },
  { name: 'Venomite', primary: 0x1d7a3c, secondary: 0x0f3d20, accent: 0xd7ff4a, eye: 0xd7ff4a },
  { name: 'Arachne', primary: 0x8a2ec2, secondary: 0xffc93c, accent: 0x2a1140, eye: 0xfff3b0 },
  { name: 'Scarlet', primary: 0xe23f6d, secondary: 0xf7f2e8, accent: 0x2b1622, eye: 0xffffff },
  { name: 'Cyanide', primary: 0x18b3c7, secondary: 0x0d2f38, accent: 0xbdf7ff, eye: 0xbdf7ff },
  { name: 'Blazer', primary: 0xf2740c, secondary: 0x3a1d05, accent: 0xffd166, eye: 0xffe9b0 },
  { name: 'Ghostline', primary: 0xe6eaf2, secondary: 0x9aa6bf, accent: 0x2a3350, eye: 0x8fd3ff },
];

export const HERO_NAMES = [
  'Webhead', 'Skyline', 'Crawler', 'Nightspin', 'Silk', 'Tangle', 'Swinger', 'Bugbite',
  'Sticky', 'Arachno', 'Rooftop', 'Slinger', 'Threadcount', 'Widow', 'Hexleg', 'Zipline',
];

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ENDED: 'ended',
};
