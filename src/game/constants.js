'use strict';

const CFG = {
  TICK_HZ: 30,
  NET_HZ: 20,

  ARENA_R: 3800,
  SECTOR: 420,

  MAX_PLAYERS_HARD_CAP: 50,

  BASE_SPEED: 172,         // units/sec at small size
  BOOST_MULT: 1.9,
  TURN_RATE: 4.6,          // rad/s at min length
  TURN_RATE_MIN: 1.5,

  START_LEN: 10,
  MAX_LEN: 500,
  PATH_PER_LEN: 3,         // body path length = len * this

  FOOD_COUNT: 2600,
  FOOD_R: 5.5,
  FOOD_VALUE: 1,           // length gained per food

  PELLET_VALUE: 3,         // length gained per pellet
  PELLET_R_BASE: 6,
  PELLET_LIFE: 45,         // seconds
  MAX_PELLETS: 2400,

  DEATH_PELLET_RATIO: 0.6, // fraction of length dropped as pellets
  MAX_DEATH_PELLETS: 90,

  BOOST_MIN_LEN: 13,       // below this, boost disabled
  BOOST_PELLET_EVERY: 0.16,

  SPAWN_RADIUS_MIN: 500,
  SPAWN_RADIUS_MAX: 3300,
  SPAWN_PROTECT: 2.0,      // seconds of spawn protection

  ROOM_CODE_LEN: 6,
  DEFAULT_MAX_PLAYERS: 10,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CFG };
}
