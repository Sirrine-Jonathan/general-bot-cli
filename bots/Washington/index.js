/**
 * [Bot] Blank
 * Exists for defining the api, and as a starting point for future bots
 *
 * @format
 */

const { EventEmitter } = require('events');
const Objective = require('./objective.js');

// Terrain Constants.
// Any tile with a nonnegative value is owned by the player corresponding to its value.
// For example, a tile with value 1 is owned by the player with playerIndex = 1.
const TILE_EMPTY = -1;
const TILE_MOUNTAIN = -2;
const TILE_FOG = -3;
const TILE_FOG_OBSTACLE = -4; // Cities and Mountains show up as Obstacles in the fog of war.

// Objective types
const GENERAL_OBJECTIVE = 'GENERAL';
const CITY_OBJECTIVE = 'CITY';
const POSITION_OBJECTIVE = 'POSITION';
const REINFORCE_OBJECTIVE = 'REINFORCEMENT';

// exports a class named Bot
module.exports = class Bot {

  // START BOT SPECIFIC PROPS
  // The latest game tick that the bot will pull armies off it's general tile
  PULL_FROM_GENERAL_MAX = 50;

  // The earliest game tick that the bot will start to attack cities
  ATTACK_CITIES_MIN = 50;

  // The latest game tick that the bot will continue to attack cities
  ATTACK_CITIES_MAX = 2000;

  // whether or not to queue objectives at all
  USE_OBJECTIVES = true;

  // whether or not to attack enemy generals
  ATTACK_GENERALS = true;

  // whether or not to attack cities
  ATTACK_CITIES = true;

  // whether or not to add enemy objectives to the objective queue
  ATTACK_ENEMIES = true;

  // random moves will expand the front line via an objective when frontline
  // doesn't have enough armies to progress
  EXPAND_FRONTLINE = true;
  EXPAND_PERIMETER = true;

  REINFORCE_GENERAL = true;
  BEGIN_REINFORCING = false;

  // reinforce to keep up with game tick, unless min is acheived
  GENERAL_MIN = 700;

  // The most we'll look into a path before considering it too long to continue searching
  DEFAULT_PATH_LENGTH_LIMIT = 20;
  PATH_LENGTH_LIMIT = this.DEFAULT_PATH_LENGTH_LIMIT;

  // The closest we'll let an enemy get to our general before we start sending home reinforcements
  CLOSENESS_LIMIT = 60;

  // Game data from game_start
  // https://dev.generals.io/api#game_start
  playerIndex = null;
  replay_id = null;
  replay_url;
  chat_room;
  team_chat_room;
  usernames;
  teams;

  // Useful data gathered from the info give on game update
  game_tick = 0;
  ticks_til_payday = 25;

  generals = []; // The indicies of generals we have vision of.
  cities = []; // The indicies of cities we have vision of.

  width = null; // map width
  height = null; // map height
  map = []; // large array continue all map information
  terrain = []; // obstacle or enemy player information of map
  owned = []; // all the owned tiles
  usable = [];
  enemies = []; // all tiles owned by enemies
  perimeter = []; // all the tiles on the perimeter of the bots territory

  current_tile = null;
  current_coors = null;
  general_tile = null;
  general_coords = null;

  last_move = null;
  last_type_taken = null;
  objective_queue = [];
  last_chat = null;
  history = [];
  current_target = null;
  random_from = null;
  current_path = [];

  // mechanism for freeing the bot when it's gotten stuck
  checksum = null;
  no_change_count = 0;
  no_change_threshold = 5;
  lastAttemptedMove = null;
  first_fail = null;
  // END BOT SPECIFIC PROPS

  // constructor takes a socket or setups an event emitter
  constructor(config) {
    this.user_id = config.user_id;
    this.username = config.username;
    this.socket = config.socket;
    this.em = new EventEmitter();
    this.file = config.file;
    this.created_at = new Date().toLocaleString();
    this.log(`Bot ${config.username} created ${this.created_at}`);
  }

  // each function is named after the event received from the game server
  game_start = (data) => {
    this.playerIndex = data.playerIndex;
    this.replay_id = encodeURIComponent(data.replay_id);
    this.replay_url = `http://bot.generals.io/replays/${this.replay_id}`;
    this.chat_room = data.chat_room;
    this.team_chat_room = data.team_chat_room;
    this.usernames = data.usernames;
    this.teams = data.teams;
  };

  // runs twice every game tick
  game_update = (data) => {
    this.log('=================================');
    this.log(`GAME TICK ${data.turn / 2} (owned: ${this.owned.length})`);
    this.log('=================================');

    this.gatherIntel(data);

    // update generals
    this.generals = data.generals;

    // update cities
    this.cities = this.patch(this.cities, data.cities_diff);

    // skip lots of processing if we can't even make a move
    if (this.isFullyStretched()) {
      this.log('Fully Stretched');
      return;
    }

    // check if there was a failed attack we need to attempt again
    if (this.lastAttemptedMove !== null) {
      const lastAttemptedMoveCheck = this.recordMove(
        this.lastAttemptedMove.from,
        this.lastAttemptedMove.to
      );
      const lastMoveFailed =
        JSON.stringify(this.lastAttemptedMove) ===
        JSON.stringify(lastAttemptedMoveCheck);
      if (lastMoveFailed) {
        if (this.first_fail === null) {
          this.log(`FOUND FAILED MOVE (first seen on tick: ${this.internal_tick})`);
          this.first_fail = this.internal_tick;
        } else {
          this.log(`FOUND FAILED MOVE (seen since tick: ${this.first_fail})`);
        }
        if (Math.abs(this.internal_tick - this.first_fail) < 3) {
          this.log(`Retry Attempt #${this.internal_tick - this.first_fail}`);
          this.attack_alt(this.lastAttemptedMove.from, this.lastAttemptedMove.to);
          return;
        } else {
          this.log('Giving up on move, clearing queue');
          this.clear();
        }
      } else {
        this.first_fail = null;
      }
    }

    if (data.turn > 1) {
      this.doNextMove(data);
    }
  };

  game_lost = () => {
    this.log(`game lost so ${this.username} is leaving game`);
    this.leave_game();
  };

  game_won = () => {
    this.chat_message('I WIN!');
    this.log(`game won so ${this.username} is leaving game`);
    this.leave_game();
  };

  // (chat_room, data)
  receive_chat_message = () => {
    // do fun things with other players chat messages
  };
  // (data)
  stars = () => {};
  // (data)
  rank = () => {};

  // here are all function that the bot can use to interface with the game server
  // when these are called, emit an evit by the same name for the bot server to send to the game server
  set_username = (user_id = this.user_id, username = this.username) => {
    this.log('Setting bot username');
    this.em.emit('set_username', user_id, username);
  };
  play = (user_id = this.user_id) => {
    this.log('Joining FFA');
    this.em.emit('play', user_id);
  };
  join_1v1 = (user_id = this.user_id) => {
    this.log('Joining 1v1');
    this.em.emit('join_1v1', user_id);
  };
  join_private = (custom_game_id, user_id = this.user_id) => {
    this.em.emit('join_private', custom_game_id, user_id);
  };
  set_custom_team = (custom_game_id, team) => {
    this.log(`Joining custom team ${team} on ${custom_game_id}`);
    this.em.emit('set_custom_team', custom_game_id, team);
  };
  join_team = (team_id, user_id = this.user_id) => {
    this.log(`Joining team ${team_id}`);
    this.em.emit('join_team', team_id, user_id);
  };
  leave_team = (team_id) => {
    this.log(`Leaving team ${team_id}`);
    this.em.emit('leave_team', team_id);
  };
  cancel = () => {
    this.log('Leaving the game queue');
    this.em.emit('cancel');
  };
  set_force_start = (queue_id, doForce) => {
    this.em.emit('set_force_start', queue_id, doForce);
  };
  clear_moves = () => {
    this.em.emit('clear_moves');
  };
  pint_tile = (index) => {
    this.em.emit('ping_tile', index);
  };
  chat_message = (text, chat_room = this.chat_room) => {
    this.em.emit('chat_message', chat_room, text);
  };
  // contrived function that allows bot to specify team only chat
  team_chat_message = (text, chat_room = this.team_chat_room) => {
    this.em.emit('chat_message', chat_room, text); // purposefully emits 'chat_message' with team_chat_room
  };
  leave_game = () => {
    this.log('Leaving game');
    this.em.emit('leave_game');
  };
  // (user_id = this.user_id)
  stars_and_rank = () => {};

  /*
    Helper function useful for all bots
  */
  patch = (old, diff) => {
    const out = [];
    let i = 0;
    while (i < diff.length) {
      if (diff[i]) {
        // matching
        Array.prototype.push.apply(
          out,
          old.slice(out.length, out.length + diff[i])
        );
      }
      i++;
      if (i < diff.length && diff[i]) {
        // mismatching
        Array.prototype.push.apply(out, diff.slice(i + 1, i + 1 + diff[i]));
        i += diff[i];
      }
      i++;
    }
    return out;
  };

  log = (...params) => {
    const lines = [...params].map((param) => {
      if (typeof param === 'object') {
        return JSON.stringify(param, null, 2);
      } else {
        return param;
      }
    });
    this.em.emit('log', lines.join(' '));
    // fs.appendFileSync(this.file, lines.join(' ') + '\n', (err) => {
    //   if (err) console.log(err);
    // });
  };

  /*
    FUNCTIONS SPECIFIC TO THIS BOT
  */

  isFullyStretched = () => {
    if (this.game_tick < this.PULL_FROM_GENERAL_MAX) {
      return this.owned
        .map((tile) => this.armies[tile])
        .every((amount) => amount === 1);
    } else {
      return this.owned
        .map((tile) => {
          if (this.isGeneral(tile)) {
            return 1; // return 1 for general tile just to not include it in our .every
          } else {
            return this.armies[tile];
          }
        })
        .every((amount) => amount === 1);
    }
  };

  gatherIntel = (data) => {
    // set the bots index
    if (this.playerIndex === null) {
      this.playerIndex = data.playerIndex;
      this.log(`set bot index ${this.playerIndex}`);
    }

    // game timing
    this.internal_tick = data.turn / 2;
    this.game_tick = Math.ceil(this.internal_tick);
    this.ticks_til_payday = 25 - (this.game_tick % 25);

    // update map variables
    this.map = this.patch(this.map, data.map_diff);
    if (data.turn === 1) {
      this.width = this.map[0];
      this.height = this.map[1];
      this.size = this.width * this.height;
    }
    this.armies = this.map.slice(2, this.size + 2);
    this.terrain = this.map.slice(this.size + 2, this.size + 2 + this.size);

    // recognize borders
    let allTiles = Array(this.size)
      .fill(false)
      .map((empty_val, tile) => tile);
    this.leftBorder = allTiles.filter((tile) => this.isLeftBorder(tile));
    this.rightBorder = allTiles.filter((tile) => this.isRightBorder(tile));

    // all the enemy tiles
    let newEnemies = this.terrain
      .map((tile, idx) => {
        if (this.isEnemy(idx)) {
          return idx;
        }
        return null;
      })
      .filter((tile) => tile !== null);
    this.enemies = newEnemies;

    // all the tiles we own
    let newOwned = this.terrain
      .map((tile, idx) => {
        if (tile === this.playerIndex) {
          return idx;
        }
        return null;
      })
      .filter((tile) => tile !== null);
    this.owned = newOwned;

    // all the usable tiles we own
    let newUsable = this.owned
      .filter(tile => {
        return this.armiesAtTile(tile) >= 2;
      });
    this.usable = newUsable;

    // of the tiles we own, only the ones on the perimeter
    let newPerimeter = this.owned.filter((tile) => this.isPerimeter(tile));
    this.perimeter = newPerimeter;

    // of the tiles we own, only the ones that border an enemy
    let newFrontline = this.owned.filter((tile) => this.isFrontline(tile));
    this.frontline = newFrontline;
    if (!this.BEGIN_REINFORCING && this.frontline.length > 0){
      this.clear();
      this.BEGIN_REINFORCING = true;
    }

    // update checksum that will help us recognized when/if the bot is stuck
    let newChecksum = [
      // all owned tiles
      ...this.owned,

      // all armies at owned tiles minus ones that increase on every tick anyway
      ...this.owned
        .filter((tile) => !this.isGeneral(tile) && !this.isCity(tile))
        .map((tile) => this.armiesAtTile(tile)),
    ];
    if (
      this.checksum !== null &&
      JSON.stringify(this.checksum) === JSON.stringify(newChecksum)
    ) {
      this.no_change_count++;
    } else {
      this.no_change_count = 0;
    }
    if (this.no_change_count >= this.no_change_threshold) {
      this.log(
        `recognized no change for ${this.no_change_count} consecutive ticks at tick ${this.game_tick}`
      );
      this.objective_queue = [];
      this.no_change_count = 0;
      this.clear();
    }
    this.checksum = newChecksum;

    // do things at first turn
    if (data.turn === 1) {

      // set general info
      this.general_tile = data.generals[this.playerIndex];
      this.general_coords = this.getCoords(this.general_tile);

      // initialize current tile info
      this.current_tile = this.general_tile;
      this.current_coords = this.getCoords(this.current_tile);

      // why not dump a starting report

      this.log('==STARTING REPORT==');
      this.log({
        general: this.general_tile,
        owned: this.owned,
        current: `${this.current_tile}, (${this.current_coords.x}, ${this.current_coords.y})`,
        dimensions: `${this.width} x ${this.height}`,
      });
    }
  };

  // Getting surrounding tiles
  getLeft = (index) => index - 1;
  getRight = (index) => index + 1;
  getDown = (index) => index + this.width;
  getUp = (index) => index - this.width;
  getUpLeft = (index) => this.getLeft(this.getUp(index));
  getUpRight = (index) => this.getRight(this.getUp(index));
  getDownLeft = (index) => this.getLeft(this.getDown(index));
  getDownRight = (index) => this.getRight(this.getDown(index));

  recordMove = (from, to) => {
    return {
      to,
      from,
      toArmies: this.armiesAtTile(to),
      fromArmies: this.armiesAtTile(from),
      toTerrain: this.terrain[to],
      fromTerrain: this.terrain[from],
    };
  };

  attack_alt = (from, to, is50 = false) => {
    this.log(`launching alt attack from ${from} to ${to}`);
    this.lastAttemptedMove = this.recordMove(from, to);
    this.current_tile = to;
    if (this.armiesAtTile(from) < 2){
      this.log(`CANNOT MOVE FROM THIS ONE BECAUSE IT DOESN'T HAVE ENOUGH ARMIES!!!! ${this.armiesAtTile(from)}`);
    }
    this.socket.emit('attack', from, to, is50);
  };

  attack = function (from, to, is50 = false) {
    this.log(`launching attack from ${from} to ${to}`);
    this.lastAttemptedMove = this.recordMove(from, to);
    this.current_tile = to;
    if (this.armiesAtTile(from) < 2){
      this.log(`CANNOT MOVE FROM THIS ONE BECAUSE IT DOESN'T HAVE ENOUGH ARMIES!!!! ${this.armiesAtTile(from)}`);
    }
    this.em.emit('attack', from, to, is50);
  };

  left = (index) => {
    this.attack(index, this.getLeft(index));
  };

  right = (index) => {
    this.attack(index, this.getRight(index));
  };

  down = (index) => {
    this.attack(index, this.getDown(index));
  };

  up = (index) => {
    this.attack(index, this.getUp(index));
  };

  // check if file is frontline tile
  isFrontline = (tile) => {
    let surrounding = this.getSurroundingTiles(tile);
    let foundEnemy = false;
    surrounding.forEach((t) => {
      if (this.isEnemy(t) && !this.willMoveCrossHorizontalBorder(tile, t)) {
        foundEnemy = true;
      }
    });
    return foundEnemy;
  };

  // check if tile is a perimeter tile
  isPerimeter = (tile) => {
    // first check we actually own it,
    if (this.terrain[tile] === this.playerIndex) {
      // get surrounding tiles
      let surrounding = this.getSurroundingTiles(tile);
      // filter out all tiles that would not make it a perimeter tile
      // this will filter out vertical warps too
      let surrounding_mapped = surrounding.map((tile) =>
        this.isVentureTile(tile)
      );

      // if tile is on top edge
      if (this.isTopBorder(tile)) {
        // set top tile to false
        surrounding_mapped[0] = false;
      }

      // if tile is on right edge
      if (this.isRightBorder(tile)) {
        // set right tile to false
        surrounding_mapped[1] = false;
      }

      // if tile is on bottom edge
      if (this.isBottomBorder(tile)) {
        // set bottom tile to false
        surrounding_mapped[2] = false;
      }

      // if tile is on left edge
      if (this.isLeftBorder(tile)) {
        // set left tile to false
        surrounding_mapped[3] = false;
      }

      let venture_tiles = [];
      for (let i = 0; i < surrounding.length; i++) {
        if (surrounding_mapped[i]) {
          venture_tiles.push(surrounding[i]);
        }
      }

      // this.log(`venture tiles for ${tile}: ${venture_tiles}`);
      // this.log(`is ${tile} perimter? ${venture_tiles.length > 0}`);
      return venture_tiles.length > 0;
    }
    return false;
  };

  isTopBorder = (tile) => tile < this.width;

  isLeftBorder = (tile) => tile % this.width === 0;

  isBottomBorder = (tile) => tile >= this.size - this.width;

  isRightBorder = (tile) => (tile + 1) % this.width === 0;

  willMoveCrossHorizontalBorder = (from, to) => {
    if (this.isRightBorder(from) && this.getRight(from) === to) {
      return true;
    }

    // if tile is on left edge and next move is right
    if (this.isLeftBorder(from) && this.getLeft(from) === to) {
      return true;
    }

    return false;
  };

  isVentureTile = (tile) => {
    let terrain = this.terrain[tile];
    return (
      terrain !== undefined &&
      terrain !== this.playerIndex &&
      terrain !== TILE_MOUNTAIN &&
      terrain !== TILE_FOG_OBSTACLE && // exclude cities as venturing
      this.isInBounds(tile) &&
      (!this.isCity(tile) || this.game_tick >= this.ATTACK_CITIES_MIN)
    );
  };

  isInBounds = (tile) => {
    let { x, y } = this.getCoords(tile);
    return x >= 0 || x <= this.width || y >= 0 || y <= this.height;
  };

  // helper for checking if tile is the general tile
  isGeneral = (tile) => tile === this.general_tile;

  // helper for checking if a tile is a city
  isCity = (tile) => this.cities.includes(tile);

  // helper to see if we own a tile
  isOwned = (tile) => this.owned.includes(tile);

  // helper to see if tile is empty
  isEmpty = (tile) => this.terrain[tile] === TILE_EMPTY;

  // helpert to see if tile is owned by an enemy
  isEnemy = (tile) => {
    return this.terrain[tile] !== this.playerIndex && this.terrain[tile] >= 0;
  };

  // helpert to see if tile is owned by an enemy
  isLowEnemy = (tile, attacking_tile) => {
    const attacking_armies = this.armies[attacking_tile];
    return (
      // is not players own tile
      this.terrain[tile] !== this.playerIndex &&
      // is a player (so must be enemy)
      this.terrain[tile] >= 0 &&
      // is less than attacking armies by at least 2
      this.armies[tile] <= attacking_armies - 2
    );
  };

  // returns true or false if an enemy owns a tile within our comfort threshold
  isEnemyClose = () => {
    let isEnemyClose = this.enemies
      .map((tile) => this.distanceBetweenTiles(this.general_tile, tile))
      .some((distance) => distance >= this.CLOSENESS_LIMIT);
    this.log('REINFORCE GENERAL, ENEMY IS TOO CLOSE');
    return isEnemyClose;
  };

  closeEnemyIsStronger = () => {
    return this.enemies.some((tile) => {
      return (
        this.distanceBetweenTiles(this.general_tile, tile) >=
          this.CLOSENESS_LIMIT &&
        this.armies[tile] >= this.armies[this.general_tile]
      );
    });
  };

  // helper for getting the number of armies at a tile
  armiesAtTile = (tile) => this.armies[tile];

  // any tile we own
  getRandomOwned = () => {
    const index_in_owned = Math.floor(Math.random() * this.usable.length);
    return this.usable[index_in_owned];
  };

  // get the tile that will be the best source of armies
  getBestSourceTile = (includeGeneral = false) => {
    let most_armies = 0;
    let best_tile = null;
    this.usable.forEach((tile) => {
      let armies_at_tile = this.armies[tile];
      if (
        (best_tile === null || armies_at_tile > most_armies) &&
        (includeGeneral || !this.isGeneral(tile))
      ) {
        best_tile = tile;
        most_armies = armies_at_tile;
      }
    });
    return best_tile;
  };

  getBestFrontline = (includeGeneral = false) => {
    if (this.frontline.length <= 0) return null; // short circuit to improve performance
    let most_armies = 1; // explicitly set to 1 since we don't want frontline tiles with anything less than 2
    let best_tile = null;
    this.frontline.forEach((tile) => {
      let armies_at_tile = this.armiesAtTile(tile);
      if (
        armies_at_tile > most_armies &&
        (includeGeneral || !this.isGeneral(tile))
      ) {
        best_tile = tile;
        most_armies = armies_at_tile;
      }
    });
    return best_tile;
  };

  getSortedFrontline = () => {
    let sorted = [...this.frontline];
    sorted.sort((a, b) => {
      let armies_a = this.armiesAtTile(a);
      let armies_b = this.armiesAtTile(b);
      return armies_b - armies_a;
    });
    return sorted;
  };

  getBestPerimeter = (includeGeneral = false) => {
    if (this.perimeter.length <= 0) return null;
    let most_armies = 1;
    let best_tile = null;
    this.perimeter.forEach((tile) => {
      let armies_at_tile = this.armies[tile];
      if (
        armies_at_tile > most_armies &&
        (includeGeneral || !this.isGeneral(tile))
      ) {
        best_tile = tile;
        most_armies = armies_at_tile;
      }
    });
    return best_tile;
  };

  getRandomPerimeter = () => {
    if (this.perimeter.length <= 0) return null;
    let usablePerimeter = this.perimeter.filter(tile => this.armiesAtTile(tile) >= 2);
    if (usablePerimeter.length <= 0) return null;
    const index = Math.floor(Math.random() * usablePerimeter.length);
    return usablePerimeter[index];
  };

  getClosestPerimeter = (start) => {
    let distances = this.perimeter.map((tile) =>
      this.distanceBetweenTiles(start, tile)
    );
    let shortest = this.width * this.height;
    let index = null;
    distances.forEach((distance, idx) => {
      if (distance < shortest || index === null) {
        index = idx;
        shortest = distance;
      }
    });
    if (index === null) return null;
    return this.perimeter[index];
  };

  getFartherPerimeter = (start) => {
    let distances = this.perimeter.map((tile) =>
      this.distanceBetweenTiles(start, tile)
    );
    let farthest = 0;
    let index = null;
    distances.forEach((distance, idx) => {
      if (distance > farthest || index === null) {
        index = idx;
        farthest = distance;
      }
    });
    if (index === null) return null;
    return this.perimeter[index];
  };

  getClosestFrontline = (start) => {
    if (this.frontline.length <= 0) return null;
    let distances = this.frontline.map((tile) =>
      this.distanceBetweenTiles(start, tile)
    );
    let shortest = this.width * this.height;
    let index = null;
    distances.forEach((distance, idx) => {
      if (distance < shortest || index === null) {
        index = idx;
        shortest = distance;
      }
    });
    return this.frontline[index];
  };

  getClosest = (current_tile, tile_list) => {
    let lowest_index = 0;
    let lowest_qty = null;
    tile_list
      .map((tile) => this.distanceBetweenTiles(current_tile, tile))
      .forEach((qty, idx) => {
        if (lowest_qty === null || qty < lowest_qty) {
          lowest_index = idx;
          lowest_qty = qty;
        }
      });
    return tile_list[lowest_index];
  };

  distanceBetweenTiles = (a, b) => {
    return this.distanceBetweenCoords(this.getCoords(a), this.getCoords(b));
  };

  distanceBetweenCoords = (a, b) => {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  };

  // get x, y of tile
  getCoords = (tile) => {
    var y = Math.floor(tile / this.width);
    var x = tile % this.width;
    return { x, y };
  };

  // get tile of x, y
  getTileAtCoords = (x, y) => {
    return y * this.width + x;
  };

  getSurroundingTiles = (index) => {
    return [
      this.getUp(index),
      this.getRight(index),
      this.getDown(index),
      this.getLeft(index),
    ];
  };

  getSurroundingTerrain = (index) => {
    let terrain = this.getSurroundingTiles(index).map(
      (tile) => this.terrain[tile]
    );
    return terrain;
  };

  clear = () => {
    this.objective_queue = [];
  };

  doNextMove = (data) => {
    this.log(`OBJECTIVE QUEUE LENGTH ${this.objective_queue.length}`);

    // find the next objective
    let objective;
    let attempt = 0;
    while (objective === undefined && this.objective_queue.length > 0) {
      this.log(`Looking for next step, attempt #${++attempt}`);

      // get the next objective to check from the queue
      // if this objective is not usable, we'll shift it from the queue
      let next_objective = this.objective_queue[0];

      // if objective queue is null or not empty, we've found our current objective
      if (next_objective.queue === null || next_objective.queue.length > 0) {
        // if this objective has not yet been started
        // let's do some things
        if (!next_objective.started) {
          // if it's a general objective, let's chat about it
          if (next_objective.type === GENERAL_OBJECTIVE) {
            let general_index = this.generals.indexOf(next_objective.target);
            let username = this.usernames[general_index];
            this.log(
              `Targeting ${username}'s general at ${next_objective.target}`
            );
          } else {
            this.log(
              `Targeting ${next_objective.type} at ${next_objective.target}`
            );
          }

          // set the 'started' flag to true, so we don't repeat this stuff
          next_objective.started = true;
        }

        // set the objective so we can exit our while loop
        objective = next_objective;

        // The next queue in line is empty and we need to handle that now.
      } else {
        let completed_objective = this.objective_queue.shift();
        this.log('process old objective', completed_objective);

        // consider renewing objective immediately
        if (
          completed_objective.complete &&
          !this.isOwned(completed_objective.target)
        ) {
          // only renew the objective if the target is not now owned
          // this is part of why this logic needs to happen on the tick after the last queue's move
          if (!this.isOwned(completed_objective.target)) {
            this.log('renewing objective', completed_objective);
            let newObj = new Objective(
              completed_objective.type,
              completed_objective.target,
              null,
              null,
              true
            );
            newObj.tick_created = this.internal_tick;
            this.addObjective(newObj);
          }
        }

        // set current to random if completed task was position task and target was general,
        // so we don't move all armies off the general immediately after reinforcing it
        if (
          completed_objective.type === POSITION_OBJECTIVE &&
          completed_objective.target === this.general_tile
        ) {
          let best = this.getBestSourceTile(false) ?? this.getRandomOwned();
          this.log(`set current_tile to best not general source tile ${best}`);
          this.current_tile = best;
        }

        // Do something once the objective queue has been emptied
        if (this.objective_queue.length <= 0) {
          // ... do thing ...
          this.log('OBJECTIVE QUEUE IS EMPTY');
        }
      }
    }

    // if general is below threshold, push a position objective to
    // start of queue, make sure we don't add it twice though.
    const alreadyReinforcing =
      this.objective_queue.length > 0 &&
      this.objective_queue[0].target === this.general_tile;
    const reinforcementAlreadyQueued = this.objective_queue.some(
      (obj) => obj.type === REINFORCE_OBJECTIVE
    );
    const settingsAllowReinforcement =
      this.REINFORCE_GENERAL && this.USE_OBJECTIVES;
    const armiesBelowThreshold =
      this.armiesAtTile(this.general_tile) < this.game_tick;
    if (
      settingsAllowReinforcement &&
      !alreadyReinforcing &&
      !reinforcementAlreadyQueued &&
      this.BEGIN_REINFORCING &&
      ((armiesBelowThreshold &&
        !this.isAttackingGeneral()) ||
        this.closeEnemyIsStronger())
    ) {
      this.log('Reinforcing general');
      let newObj = new Objective(REINFORCE_OBJECTIVE, this.general_tile);
      newObj.tick_created = this.internal_tick;
      if (this.closeEnemyIsStronger()) {
        this.addObjective(newObj, true);
      } else {
        this.addObjective(newObj);
      }
    }

    // if there's no objective, let's resort to doing a random move,
    if (!objective) {
      this.randomMove(data);

      // otherwise, let's begin processing the next move in the current objective's queue
    } else {
      // executed next step and returned the updated objective
      let updated_objective = this.executeObjectiveStep(objective);
      if (updated_objective === null) {
        this.log('refreshing path found empty queue');
        return null;
      }

      // if it's complete (meaning the target tile was reached, but not necessarily owned)
      if (updated_objective.complete) {
        let completed_objective = this.objective_queue[0];
        this.log('OBJECTIVE COMPLETE', completed_objective);

        // more debug logs for cities
        if (completed_objective.type === CITY_OBJECTIVE) {
          this.log(
            'city obj finished, terrain is',
            this.terrain[completed_objective.target]
          );
          this.log('cities are', this.cities);
          this.log(
            'armies at target city',
            this.armies[completed_objective.target]
          );
        }

        // chat tile capture for position objectives
        if (
          this.isOwned(completed_objective.target) &&
          completed_objective.type !== POSITION_OBJECTIVE &&
          completed_objective.type !== REINFORCE_OBJECTIVE
        ) {
          this.log(`Captured ${completed_objective.type} at ${completed_objective.target}`);
        }

        // if the objective is not complete, but the queue is empty,
        // then a clear path must not have been found, or
        // the objective was interrupted by a takeover
      } else if (updated_objective.queue.length <= 0) {
        this.randomMove(data);
      }
    }
  };

  randomMove = (
    data,
    priority = [
      this.isLowEnemy, // Enemy Owned
      this.isEmpty, // Empty
      this.isOwned, // Self Owned
    ],
  ) => {
    let queued_move = false;
    let move_from = null;
    let move_to = null;

    // if we have a frontline, let's either move from there, or send reinforcements
    if (this.frontline > 0) {
      const frontline_tile = this.getBestFrontline();
      if (frontline_tile !== null) {
        const newThing = true;
        if (newThing){
          const sorted = this.getSortedFrontline().filter(tile => this.armiesAtTile(tile) >= 2);
          this.log(`Sorted frontline ${sorted}`);
          while (sorted.length > 0 && move_to === null) {
            let next_best = sorted.pop();
            this.log(`Next best: ${next_best}`);
            move_to = this.randomMoveFromTile(next_best, priority);
            this.log(`Found move to ${move_to}`);
          }
          if (move_to === null) {
            queued_move = this.expandFrontline(data);
          } else {
            this.log(`Attacking from frontline ${move_from} to ${move_to}`);
          }
        } else {
          const frontline_tile = this.getBestFrontline();
          if (frontline_tile !== null) {
            move_to = this.randomMoveFromTile(frontline_tile, priority);
            move_from = frontline_tile;
            this.log(`Attacking from frontline ${move_from} to ${move_to}`);
          } else if (this.EXPAND_FRONTLINE) {
            queued_move = this.expandFrontline(data);
          }
        }
      } else if (this.EXPAND_FRONTLINE && this.USE_OBJECTIVES) {
        queued_move = this.expandFrontline(data);
      }
    }

    // if we have a perimeter, let's either move from there, or send reinforcements
    if (
      !queued_move &&
      (move_from === null || move_to === null) &&
      this.perimeter.length > 0
    ) {
      this.log('has perimeter');
      const perimeter_tile = this.getBestPerimeter(
        this.game_tick < this.PULL_FROM_GENERAL_MAX
      );
      if (perimeter_tile !== null) {
        move_to = this.randomMoveFromTile(perimeter_tile, priority);
        move_from = perimeter_tile;
        this.log(`Attacking from perimeter ${move_from} to ${move_to}`);
      } else if (
        this.EXPAND_PERIMETER &&
        this.USE_OBJECTIVES &&
        this.perimeter.filter((tile) => !this.isGeneral(tile)).length > 0
      ) {
        queued_move = this.expandPerimeter(data);
      }
    }

    // if we queued a move, let's stop the random function
    if (queued_move) return;

    // if we are missing either move_from or move_to, we have more work to do
    if (move_from === null || move_to === null) {
      this.log('nothing queued or otherwise');
      let best_source = this.getBestSourceTile(this.game_tick < this.PULL_FROM_GENERAL_MAX);
      let random_owned = this.getRandomOwned();
      this.log(`best source returned ${best_source}`);
      this.log(`random owned returned ${random_owned}`);
      move_from = (best_source !== null) ? best_source : random_owned;
      this.log(`move_from set to ${move_from}`);
      move_to = this.randomMoveFromTile(move_from, priority);
      this.log(`random move from ${move_from} to ${move_to}`);
    }

    // If we are taking a player tile and we are about to run out of armies to attack,
    // let's plan on reinforcing this frontline
    let taking_type = this.terrain[move_to];
    const generalBelowThreshold =
      this.armiesAtTile(this.general_tile) < this.game_tick;
    const generalMinAcheived =
      this.armiesAtTile(this.general_tile) > this.GENERAL_MIN;
    if (
      this.ATTACK_ENEMIES &&
      this.USE_OBJECTIVES &&
      this.isEnemy(taking_type) &&
      this.armies[move_from] <= 2 && // don't start the enemy target objective until we're almost out on the frontline
      (!generalBelowThreshold || generalMinAcheived) &&
      !this.isAttackingGeneral()
    ) {
      this.log(`Targeting player ${this.usernames[taking_type]}`);
      let newObj = new Objective(
        POSITION_OBJECTIVE,
        move_from,
        null,
        null,
        true
      );
      this.addObjective(newObj, true);
    }

    // perform move to
    this.attack(move_from, move_to);
  };

  randomMoveFromTile = (
    move_from,
    priority = [
      this.isLowEnemy, // Enemy Owned
      this.isEmpty, // Empty
      this.isOwned, // Self Owned
    ],
  ) => {
    // the tiles options,
    this.log(`Getting random move from ${move_from}`);
    let options = this.getSurroundingTiles(move_from);
    this.log(`Surrounding Tiles: ${options}`);
    let move_to = null;
    let used_priority = null;

    // loop over the priority to find a set of viable options
    let viable_options = [];
    for (let i = 0; i < priority.length; i++) {
      this.log(`checking priority ${priority[i].name} from ${move_from}`);
      let passing_options = options.filter((op) => {
        const isCity = this.isCity(op);
        const passes_priority_check = priority[i](op, move_from);
        const passes =
          // must pass priority function check
          passes_priority_check &&
          // if we attack a city, we'll do it deliberately
          !isCity;
        return passes;
      });

      // continue to next priority if no viable options
      if (passing_options.length <= 0) {
        continue;
      } else {
        viable_options = passing_options;
        used_priority = priority[i].name;
        break; // found our viable options, so let's break
      }
    }
    this.log(`Viable Options: ${viable_options}`);
    if (viable_options.length === 0) {
      return null;
    }

    // if the options are enemy tiles, let's select the one with the least armies
    if (used_priority === 'isEnemy') {
      let lowest_armies = null;
      let lowest_armies_tile = null;
      viable_options.forEach((tile) => {
        if (lowest_armies === null || this.armiesAtTile(tile) < lowest_armies) {
          lowest_armies = this.armiesAtTile(tile);
          lowest_armies_tile = tile;
        }
      });
      if (lowest_armies_tile !== null) {
        this.log(`Moving to weakest enemy tile (${lowest_armies_tile})`);
        move_to = lowest_armies_tile;
      }
    }

    // if the options are empty tiles, let's select the one closest to the center tile
    if (used_priority === 'isEmpty') {
      let closest = null;
      let closest_tile = null;
      let center = Math.floor((this.width * Math.floor(this.height / 2)) - Math.floor(this.width / 2));
      viable_options.forEach((tile) => {
        const distance = this.distanceBetweenTiles(tile, center);
        if (closest === null || distance < closest) {
          closest = distance;
          closest_tile = tile;
        }
      });
      if (closest_tile !== null) {
        this.log(`Moving to empty tile ${closest_tile} closest to center (${center})`);
        move_to = closest_tile;
      }
    }

    // if the option tiles are owned tiles, let's select the one that is closest to the closest perimeter
    if (used_priority === 'isOwned') {
      let closest = null;
      let closest_tile = null;
      const closest_perimeter = this.getClosestPerimeter(move_from);
      viable_options.forEach((tile) => {
        const distance = this.distanceBetweenTiles(tile, closest_perimeter);
        if (closest === null || distance < closest) {
          closest = distance;
          closest_tile = tile;
        }
      });
      if (closest_tile !== null && this.lastAttemptedMove?.from !== closest_tile) {
        this.log(
          `Moving to owned tile (${closest_tile}) closest to closest perimeter (${closest_perimeter})`
        );
        move_to = closest_tile;
      }
      if (this.lastAttemptedMove?.from !== closest_tile){
        this.log('Prevented repeat move');
      }
    }

    // as a backup, we'll get a random option index
    if (move_to === null) {
      let random_index = Math.floor(Math.random() * viable_options.length);
      move_to = viable_options[random_index];
    }

    return move_to;
  };

  expandFrontline = (data, defer = false) => {
    this.log('Trying to expand frontline');

    let best_source = this.getBestSourceTile(
      this.game_tick < this.PULL_FROM_GENERAL_MAX
    );
    let closest_frontline = this.getClosestFrontline(best_source);

    if (
      best_source !== null &&
      closest_frontline !== null &&
      this.isFrontline(closest_frontline)
    ) {
      this.log('Expanding frontline');
      let queue = this.getPathDepthFirst(best_source, closest_frontline);
      let newObj = new Objective(
        POSITION_OBJECTIVE,
        closest_frontline,
        best_source,
        queue,
        false
      );
      this.addObjective(newObj);

      if (!defer) {
        this.doNextMove(data);
      }

      return true;
    } else {
      this.log('failed expanding frontline');
      return false;
    }
  };

  expandPerimeter = (data, defer = false) => {
    this.log('Trying to expand perimeter');
    let best_source = this.getBestSourceTile(
      this.game_tick < this.PULL_FROM_GENERAL_MAX
    );
    let perimeter_target =
      this.game_tick > 50
        ? this.getFartherPerimeter(this.general_tile)
        : this.getClosestPerimeter(best_source);

    if (
      best_source !== null &&
      perimeter_target !== null &&
      this.isPerimeter(perimeter_target)
    ) {
      this.log('Expanding perimeter');
      let queue = this.getPathDepthFirst(best_source, perimeter_target);
      let newObj = new Objective(
        POSITION_OBJECTIVE,
        perimeter_target,
        best_source,
        queue,
        false
      );
      this.addObjective(newObj);

      if (!defer) {
        this.doNextMove(data);
      }

      return true;
    } else {
      this.log('Failed expanding perimeter');
      return false;
    }
  };

  // takes a queue and returns the updated queue,
  // this function will handle executing the move and refreshing the queue
  // if the queue needs to be continued from a better source.
  executeObjectiveStep = (objective) => {
    const LOG_OBJECTIVE_STEP = true;
    if (LOG_OBJECTIVE_STEP) {
      this.log('Running next step on objective', objective);
    }

    // return objective if queue is empty
    if (objective.queue !== null && objective.queue.length <= 0) {
      if (LOG_OBJECTIVE_STEP) {
        this.log('Objective has empty queue');
      }
      return objective;
    }

    if (
      (this.current_tile === undefined ||
        this.current_tile === null ||
        this.armiesAtTile(this.current_tile) <= 1) &&
      objective.queue !== null &&
      objective.queue.length >= 2
    ) {
      this.log('setting current tile to next move');
      this.current_tile = objective.getNextMove();
    }

    if (objective.queue === null || this.armiesAtTile(this.current_tile) <= 1) {
      if (LOG_OBJECTIVE_STEP) {
        this.log('refreshing/initializing queue');
        if (objective.queue === null) {
          this.log('because queue is null');
        }
        if (this.armiesAtTile(this.current_tile) <= 1) {
          this.log(
            `because the current tile ${
              this.current_tile
            } has too few armies ${this.armiesAtTile(this.current_tile)}`
          );
        }
      }
      let best_source =
        this.getBestSourceTile(this.game_tick < this.PULL_FROM_GENERAL_MAX) ??
        this.getRandomOwned();
      if (LOG_OBJECTIVE_STEP) {
        let c = this.getCoords(best_source);
        this.log(`using best source tile ${best_source} (${c.x}, ${c.y})`);
      }
      objective.queue = this.getPathDepthFirst(best_source, objective.target);
      if (this.objective_queue.length <= 0){
        return null;
      }
      this.current_tile = best_source;
    }

    // check if we can just continue on the current queue
    if (this.armiesAtTile(this.current_tile) > 1) {
      if (LOG_OBJECTIVE_STEP) {
        this.log(`current tile ${this.current_tile} is set and has armies`);
      }
      let next_tile = objective.queue.shift();
      if (LOG_OBJECTIVE_STEP) {
        this.log('next tile', next_tile);
      }
      if (next_tile === this.current_tile) {
        next_tile = objective.queue.shift();
        if (LOG_OBJECTIVE_STEP) {
          this.log('next tile is current, get next tile', next_tile);
          this.log('next tile', next_tile);
        }
      }

      if (next_tile === objective.target) {
        this.log(
          'Marking objective as complete, processing completion on next tick'
        );
        objective.complete = true;
      }
      this.attack(this.current_tile, next_tile);
      this.current_tile = next_tile;
    }
    return objective;
  };

  isAttackingGeneral = () => {
    return (
      this.objective_queue.length > 0 &&
      this.objective_queue[0].type === GENERAL_OBJECTIVE
    );
  };

  addObjective = (obj, toFront = false) => {
    this.log(`Adding ${obj.type} objective, target: ${obj.target}`);
    this.log(`Queue length ${this.objective_queue.length}`);
    let queue = this.objective_queue.map((obj) => obj.type);
    if (toFront) {
      this.objective_queue.unshift(obj);
    } else {
      this.objective_queue.push(obj);
    }
    this.log('Queue: ', queue);
  };

  /*
    Depth First Search for finding Paths
  */
  getPathDepthFirst = (start, finish) => {
    if (start === finish) return [];
    let path = [];
    let visited = [];
    let paths = [];
    const addPathDepthFirst = (p, newLimit = false) => {
      if (newLimit) {
        this.PATH_LENGTH_LIMIT = p.length;
      }
      paths = [...paths, p];
    };
    this.addPathDepthFirstStep(start, finish, path, visited, addPathDepthFirst);

    // recursion is finished, now we log how many paths were found
    this.log(`found ${paths.length} paths`);

    // if we are targeting an enemy, make sure we pick a path that will
    // leave  us with enough armies to conquer it
    if (this.isEnemy(finish)) {
      // find the ending armies count by the end of each path
      let ending_armies_counts = paths.map((path) => {
        let count = 0;
        path.forEach((tile) => {
          let next_tile_armies = this.armiesAtTile(tile);
          if (this.isEnemy(tile)) {
            count -= next_tile_armies;
          } else if (this.isOwned(tile)) {
            count += next_tile_armies;
          }
        });
        return count;
      });

      // filter out any paths that won't meet army qualifications
      let sufficient = paths.filter((path, idx) => {
        if (this.generals.indexOf(finish) >= 0) {
          return (
            ending_armies_counts[idx] > this.armiesAtTile(finish) + path.length
          );
        } else {
          return ending_armies_counts[idx] > this.armiesAtTile(finish);
        }
      });

      this.log(`found ${sufficient.length} sufficient paths`);
      paths = sufficient.length > 0 ? sufficient : path;
    }

    // map all the paths to thier length
    let lengths = paths.map((path) => path.length);
    let shortest_length = Math.min(...lengths);
    this.log(`shortest_length = ${shortest_length}`);
    let index_of_shortest = lengths.indexOf(shortest_length);
    let shortest_path = paths[index_of_shortest];
    this.log(`shortest_path = ${JSON.stringify(shortest_path)}`);
    let path_terrains = shortest_path?.map((tile) => this.terrain[tile]);
    this.log(`shortest_path terrains ${path_terrains}`);

    this.PATH_LENGTH_LIMIT = this.DEFAULT_PATH_LENGTH_LIMIT;
    const returning_path = shortest_path ?? [];
    this.log(`DECIDED PATH ${returning_path}`);
    return returning_path;
  };

  addPathDepthFirstStep = (next, finish, path, visited, addPathDepthFirst) => {
    const LOG_ADD_PATH_STEP = false;
    const last_move = path[path.length - 1];

    if (
      path.length > this.PATH_LENGTH_LIMIT &&
      this.PATH_LENGTH_LIMIT !== null
    ) {
      if (LOG_ADD_PATH_STEP) {
        this.log('Stopped searching path due to length limit');
      }
      return;
    }

    if (next === finish) {
      path = [...path, next];
      visited = [...visited, next];
      if (
        this.PATH_LENGTH_LIMIT === null ||
        path.length < this.PATH_LENGTH_LIMIT
      ) {
        addPathDepthFirst(path, true);
      } else {
        addPathDepthFirst(path);
      }
      return;
    }

    // coords
    let { x, y } = this.getCoords(next);

    // check visited
    if (visited.includes(next)) {
      if (LOG_ADD_PATH_STEP) {
        this.log(`already visited ${next}, (${x},${y})`);
      }
      return;
    }

    // check bounds
    if (x < 0 || x > this.width || y < 0 || y > this.height) {
      if (LOG_ADD_PATH_STEP) {
        this.log(
          `${next} tile out of bounds (${x} < 0 || ${x} > ${this.width} || ${y} < 0 || ${y} > ${this.height})`
        );
      }
      return;
    }

    // check horizontal warp moves
    if (
      last_move !== undefined &&
      this.willMoveCrossHorizontalBorder(last_move, next)
    ) {
      if (LOG_ADD_PATH_STEP) {
        this.log(`moving from ${last_move} to ${next} will is not possible`);
      }
      return;
    }

    if (this.terrain[next] === TILE_MOUNTAIN) {
      if (LOG_ADD_PATH_STEP) {
        this.log(`${next} is ${this.terrain[next]}`);
      }
      return;
    }

    // check terrain
    if (
      this.terrain[next] !== TILE_EMPTY &&
      this.terrain[next] !== TILE_FOG &&
      this.terrain[next] < 0 &&
      this.isCity(next) &&
      !this.isCity(finish) // don't include cities in path, unless a city is the target
    ) {
      if (LOG_ADD_PATH_STEP) {
        this.log(`${next} non traversable terrain ${this.terrain[next]}`);
      }
      return;
    }

    // passes all checks
    path = [...path, next];
    visited = [...visited, next];
    let borders = this.getSurroundingTiles(next);
    borders.forEach((tile) =>
      this.addPathDepthFirstStep(tile, finish, path, visited, addPathDepthFirst)
    );
  };
};
