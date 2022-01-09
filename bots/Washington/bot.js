/**
 * [Bot] Blank
 * Exists for defining the api, and as a starting point for future bots
 *
 * @format
 */

var events = require('events');
require('dotenv').config();
const Objective = require('./objective.js');
const { getRandomQuote } = require('./quotes.js');
const fs = require('fs');

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
  // logging informartion
  path = './logs/';
  filename = 'log.txt';
  log_lines = [];
  log_chunk = [];
  should_log = false;
  first_fail = null;

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
  replay_id;
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

  // constructor takes a socket or setups an event emitter
  constructor() {
    this.em = new events.EventEmitter();
    this.filename = this.updateFilename();
  }

  updateFilename = () => {
    var now = new Date();
    return (
      'LOG_' +
      now.getFullYear() +
      '-' +
      now.getMonth() +
      '-' +
      now.getDate() +
      '_' +
      now.getHours() +
      '-' +
      now.getMinutes() +
      '.txt'
    );
  };

  // log function for debugging
  log = function () {
    let arr = [...arguments].map((param) => {
      if (typeof param === 'object') {
        return JSON.stringify(param, null, 2);
      } else {
        return param;
      }
    });
    const line = arr.join(' ') + '\n';
    this.log_lines = [...this.log_lines, line];
    this.em.emit('log', this.log_lines);
    if (process.env.LOG === 'TRUE' && this.should_log) {
      this.log_chunk.push(line);
    }
  };

  // each function is named after the event received from the game server
  game_start = (data) => {
    this.updateFilename();
    this.should_log = true;
    this.log('Game Started');
    Object.keys(data).forEach((key) => {
      this[key] = data[key];
    });
    this.replayUrl = `http://bot.generals.io/replays/${encodeURIComponent(
      data.replay_id
    )}`;
    this.log(
      `Game starting! The replay will be available after the game at ${this.replayUrl}`
    );
  };
  game_lost = (data) => {
    const line = `Defeated by ${data.killer}`;
    this.chat(line);
    this.log(line);
  };
  game_won = (data) => {};
  chat_message = (chat_room, data) => {};
  stars = (data) => {};
  rank = (data) => {};

  // function for sending events
  /*
    IMPLEMENTED:
    "attack",

    SHOULD IMPLEMENT:
    "clear_moves",
    "ping_tile",

    COULD IMPLEMENT, BUT NOT REALLY NECESSARY
    "set_username",
    "play",
    "join_1v1",
    "join_private",
    "set_custom_team",
    "leave_team",
    "cancel",
    "set_force_start",
    "leave_game",
    "stars_and_rank",
  */
  chat = (msg) => {
    this.em.emit('chat_message', msg);
  };

  leave_game = () => {
    this.updateFilename();
    this.should_log = false;
    console.log(`${username} left the game`);
    this.em.emit('leave_game');
  };

  /*
    PATCH FUNCTION
  */
  /* Returns a new array created by patching the diff into the old array.
   * The diff formatted with alternating matching and mismatching segments:
   * Example 1: patching a diff of [1, 1, 3] onto [0, 0] yields [0, 3].
   * Example 2: patching a diff of [0, 1, 2, 1] onto [0, 0] yields [2, 0].
   *
   * First element of diff is how many are matching.
   * Patch will copy that number of elements to out.
   * Next element in diff is how many are differnt.
   * If num different is x, then the next x elements will be the changes.
   * Patch will copy the next x number of elements of diff to out.
   * Next elements will be how many are matching, and will follow the above pattern
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

  addObjective = (obj, toFront = false) => {
    this.log(`Adding ${obj.type} objective, target: ${obj.target}`);
    obj.tick_created = this.internal_tick;
    if (toFront) {
      this.objective_queue.unshift(obj);
    } else {
      this.objective_queue.push(obj);
    }
    const queue_types = this.objective_queue.map((obj) => obj.type);
    this.log(`Queue length ${this.objective_queue.length}`);
    this.log('Queue: ', queue_types);
  };

  clear = () => {
    this.objective_queue = [];
  };

  // gather all useful data from all we are give from the game server
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

    // of the tiles we own, only the ones on the perimeter
    let newPerimeter = this.owned.filter((tile) => this.isPerimeter(tile));
    this.perimeter = newPerimeter;

    // of the tiles we own, only the ones that border an enemy
    let newFrontline = this.owned.filter((tile) => this.isFrontline(tile));
    this.frontline = newFrontline;

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
      this.chat(getRandomQuote());

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

  // runs twice every game tick
  game_update = (data) => {
    if (this.log_chunk.length > 0 && process.env.LOG === 'TRUE') {
      const chunk = this.log_chunk.join('') + '\n\n';
      this.log_chunk = [];
      fs.appendFile(this.path + this.filename, chunk, (err) => {
        if (err) console.log(err);
      });
    }
    this.log('=================================');
    this.log(`GAME TICK ${data.turn / 2}`);
    this.log('=================================');
    this.current_target = null;
    this.random_from = null;
    this.current_path = null;

    this.gatherIntel(data);

    // update generals
    const oldGenerals = this.generals;
    this.generals = data.generals;

    // update cities
    let oldCities = this.cities;
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
          this.first_fail = this.internal_tick;
        }
        this.log(`FOUND FAILED MOVE (from tick: ${this.first_fail})`);
        if (Math.abs(this.internal_tick - this.first_fail) < 3) {
          this.log('Retrying');
          this.attack(this.lastAttemptedMove.from, this.lastAttemptedMove.to);
          return;
        } else {
          this.log('Givng up on move, clearing queue');
          this.clear();
        }
      } else if (this.first_fail === null) {
        this.first_fail = null;
      }
    }

    /*
      POTENTIALLY BEGIN TARGETING A GENERAL
    */
    if (
      JSON.stringify(oldGenerals) !== JSON.stringify(this.generals) &&
      this.game_tick !== 0 &&
      this.ATTACK_GENERALS &&
      this.USE_OBJECTIVES
    ) {
      // log things
      this.log('Found new generals');
      this.log({ generals: data.generals });

      // filter out bot itself
      let generals = data.generals.filter(
        (general) => general !== -1 && general !== this.general_tile
      );

      // if others are still visible...
      if (generals.length > 0) {
        // find the closest general
        let closest = this.getClosest(
          this.current_tile ??
            this.getBestSourceTile(true) ??
            this.getRandomOwned(),
          generals
        );
        this.log({ closest });

        // if the general objective is not already underway, let's queue it
        if (!this.isAttackingGeneral()) {
          // clear queue to take this as highest priority
          // this.objective_queue = [];
          let newObj = new Objective(GENERAL_OBJECTIVE, closest);
          newObj.tick_created = this.internal_tick;
          this.addObjective(newObj, true);
        }
      }
    }

    /*
      POTENTIALLY BEGIN TARGETING A CITY
    */
    if (JSON.stringify(this.cities) !== JSON.stringify(oldCities)) {
      // filter out owned cities (owned by any player)
      let unowned_cities = this.cities.filter((city) => city !== TILE_EMPTY);

      // log things
      this.log('Found new city');
      this.log({ all_cities: this.cities, all_unowned_cities: unowned_cities });

      // Only focus on new visible cities before a specified game tick
      if (
        this.game_tick < this.ATTACK_CITIES_MAX &&
        this.game_tick > this.ATTACK_CITIES_MIN &&
        this.ATTACK_CITIES &&
        this.USE_OBJECTIVES &&
        unowned_cities.length > 0 &&
        this.armiesAtTile(this.general_tile) > this.game_tick // enough armies at general to be attacking cities
      ) {
        // find the closest city
        let closest = this.getClosest(
          this.current_tile ??
            this.getBestSourceTile(false) ??
            this.getRandomOwned(),
          unowned_cities
        );
        this.log({ closest });

        let newObj = new Objective(CITY_OBJECTIVE, closest);
        newObj.tick_created = this.internal_tick;
        this.addObjective(newObj);
      }
    }

    if (data.turn > 1) {
      this.doNextMove(data);
    }
    return {
      ...data,
      current_target: this.current_target,
      random_from: this.random_from,
      current_path: this.current_path,
    };
  };

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

  isAttackingGeneral = () => {
    return (
      this.objective_queue.length > 0 &&
      this.objective_queue[0].type === GENERAL_OBJECTIVE
    );
  };

  doNextMove = (data) => {
    this.log(`Objectives queued: ${this.objective_queue.length}`);

    // find the next objective
    let objective;
    while (objective === undefined && this.objective_queue.length > 0) {
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
            this.chat(`Targeting ${username}'s general`);
            this.log(
              `Targeting ${username}'s general at tile ${next_objective.target}`
            );
          } else {
            this.log(
              `Targeting ${next_objective.type} at tile ${next_objective.target}`
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

        // consider renewing objective immediately
        if (
          completed_objective.complete &&
          !this.isOwned(completed_objective.target)
        ) {
          // only renew the objective if the target is not now owned
          // this is part of why this logic needs to happen on the tick after the last queue's move
          if (!this.isOwned(completed_objective.target)) {
            this.log(
              'Renewing objective for terget',
              completed_objective.target
            );
            let newObj = new Objective(
              completed_objective.type,
              completed_objective.target,
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
          this.current_tile = best;
        }

        // Do something once the objective queue has been emptied
        if (this.objective_queue.length <= 0) {
          // ... do thing ...
          this.log('Objective queue is empty');
        }
      }
    }
    if (objective) {
      this.current_path = objective.queue;
      this.current_target = objective.target;
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
    const armiesMinAcheived =
      this.armiesAtTile(this.general_tile) > this.GENERAL_MIN;
    const stoppedPullingFromGeneral =
      this.game_tick >= this.PULL_FROM_GENERAL_MAX;
    if (
      settingsAllowReinforcement &&
      !alreadyReinforcing &&
      !reinforcementAlreadyQueued &&
      ((armiesBelowThreshold &&
        !armiesMinAcheived &&
        stoppedPullingFromGeneral &&
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

      // if it's complete (meaning the target tile was reached, but not necessarily owned)
      if (updated_objective.complete) {
        let completed_objective = this.objective_queue[0];
        this.log('Objective completed for tile', completed_objective.target);

        // chat tile capture for position objectives
        if (
          this.isOwned(completed_objective.target) &&
          completed_objective.type !== POSITION_OBJECTIVE &&
          completed_objective.type !== REINFORCE_OBJECTIVE
        ) {
          this.chat(`Captured ${completed_objective.type}`);
        }

        // if the objective is not complete, but the queue is empty,
        // then a clear path must not have been found, or
        // the objective was interrupted by a takeover
      } else if (updated_objective.queue.length <= 0) {
        this.randomMove(data);
      }
    }
  };

  // takes a queue and returns the updated queue,
  // this function will handle executing the move and refreshing the queue
  // if the queue needs to be continued from a better source.
  executeObjectiveStep = (objective) => {
    const LOG_OBJECTIVE_STEP = true;
    if (LOG_OBJECTIVE_STEP) {
      this.log(`Running next step on objective for tile ${objective.target}`);
    }

    // return objective if queue is empty
    if (objective.queue !== null && objective.queue.length <= 0) {
      if (LOG_OBJECTIVE_STEP) {
        this.log('Current objective has empty queue');
      }
      return objective;
    }

    // objective has moves in queue
    this.current_path = objective.queue;
    this.current_target = objective.target;
    this.random_from = null;

    if (
      (this.current_tile === undefined ||
        this.current_tile === null ||
        this.armiesAtTile(this.current_tile) <= 1) &&
      objective.queue !== null &&
      objective.queue.length >= 2
    ) {
      this.current_tile = objective.getNextMove();
    }

    if (objective.queue === null || this.armiesAtTile(this.current_tile) <= 1) {
      let best_source =
        this.getBestSourceTile(this.game_tick < this.PULL_FROM_GENERAL_MAX) ??
        this.getRandomOwned();
      objective.queue = this.getPathDepthFirst(best_source, objective.target);
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
      if (next_tile === this.current_tile && next_tile !== objective.target) {
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
      if (next_tile !== this.current_tile) {
        this.attack(this.current_tile, next_tile);
      }
      this.current_tile = next_tile;
    }
    return objective;
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
      this.game_tick % 2 === 0
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

  randomMove = (
    data,
    priority = [
      this.isLowEnemy, // Enemy Owned
      this.isEmpty, // Empty
      this.isOwned, // Self Owned
    ]
  ) => {
    this.log('Finding Random Move', {
      frontline: JSON.stringify(this.frontline),
      perimeter: JSON.stringify(this.perimeter),
      owned: JSON.stringify(this.owned),
    });
    let queued_move = false;
    let move_from = null;
    let move_to = null;

    // if we have a frontline, let's either move from there, or send reinforcements
    if (this.frontline > 0) {
      this.log('has frontline');
      const frontline_tile = this.getBestFrontline();
      if (frontline_tile !== null) {
        this.log('Has frontline');
        const newThing = true;
        if (newThing){
          const sorted = this.getSortedFrontline();
          this.log(`Sorted frontline ${sorted}`);
          while (sorted.length > 0 && move_to === null) {
            let next_best = sorted.pop();
            this.log(`Next best: ${next_best}`);
            move_to = this.randomMoveFromTile(priority, next_best);
            this.log(`Found move to ${move_to}`);
          }
          if (move_to === null) {
            this.log(
              'No move found with sorted frontline, resort to expanding if possible'
            );
            queued_move = this.expandFrontline(data);
          } else {
            this.log(`Attacking from frontline ${move_from} to ${move_to}`);
          }
        } else {
          const frontline_tile = this.getBestFrontline();
          if (frontline_tile !== null) {
            move_to = this.randomMoveFromTile(priority, frontline_tile);
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
        move_to = this.randomMoveFromTile(priority, perimeter_tile);
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
      move_from =
        this.getBestSourceTile(this.game_tick < this.PULL_FROM_GENERAL_MAX) ??
        this.getRandomOwned();
      move_to = this.randomMoveFromTile(priority, move_from);
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
        true
      );
      this.addObjective(newObj, true);
    }

    // perform move to
    this.attack(move_from, move_to);
  };

  randomMoveFromTile = (
    priority = [
      this.isLowEnemy, // Enemy Owned
      this.isEmpty, // Empty
      this.isOwned, // Self Owned
    ],
    move_from
  ) => {
    // the tiles options,
    let options = this.getSurroundingTiles(move_from);
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
          // must not be a city before ATTACK_CITIES_MIN
          (!isCity || this.game_tick >= this.ATTACK_CITIES_MIN);
        /*
        this.log(
          `checking tile: ${op} (city: ${isCity}, passes: ${passes_priority_check}, passes_all: ${passes}})`
        );
        */
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
      let center = Math.floor(this.size / 2);
      viable_options.forEach((tile) => {
        const distance = this.distanceBetweenTiles(tile, center);
        if (closest === null || distance < closest) {
          closest = distance;
          closest_tile = tile;
        }
      });
      if (closest_tile !== null) {
        this.log(`Moving to empty tile closest to center (${center})`);
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
      if (closest_tile !== null && this.lastAttemptedMove?.to !== closest_tile) {
        this.log(
          `Moving to owned tile (${closest_tile}) closest to closest perimeter (${closest_perimeter})`
        );
        move_to = closest_tile;
      }
    }

    // as a backup, we'll get a random option index
    if (move_to === null) {
      let random_index = Math.floor(Math.random() * viable_options.length);
      move_to = viable_options[random_index];
    }

    return move_to;
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

  attack = function (from, to) {
    this.log(`launching attacking from ${from} to ${to}`);
    this.lastAttemptedMove = this.recordMove(from, to);
    this.current_tile = to;
    this.em.emit('attack', from, to);
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
    const index_in_owned = Math.floor(Math.random() * this.owned.length);
    return this.owned[index_in_owned];
  };

  // get the tile that will be the best source of armies
  getBestSourceTile = (includeGeneral = false) => {
    let most_armies = 0;
    let best_tile = null;
    this.owned.forEach((tile) => {
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
    const index = Math.floor(Math.random() * this.perimeter.length);
    return this.perimeter[index];
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

  /*
    Depth First Search for finding Paths
  */
  getPathDepthFirst = (start, finish) => {
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
      this.log(
        `${sufficient.length > 0 ? 'Regular Paths' : 'Paths'}: ${paths}`
      );
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
    return shortest_path ?? [];
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
      !this.isCity(finish) && // don't include cities in path, unless a city is the target
      this.isGeneral(next) &&
      !this.isGeneral(finish) // don't include general in path, unless our general is the target
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
