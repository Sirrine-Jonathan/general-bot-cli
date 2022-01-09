/**
 * @format
 */
var events = require("events");
const Objective = require("./objective.js");
const { getRandomQuote } = require("./quotes.js");
const fs = require("fs");

// Terrain Constants.
// Any tile with a nonnegative value is owned by the player corresponding to its value.
// For example, a tile with value 1 is owned by the player with playerIndex = 1.
const TILE_EMPTY = -1;
const TILE_MOUNTAIN = -2;
const TILE_FOG = -3;
const TILE_FOG_OBSTACLE = -4; // Cities and Mountains show up as Obstacles in the fog of war.
const TILE_NAMES = {
  [TILE_EMPTY]: "EMPTY TILE",
  [TILE_MOUNTAIN]: "MOUNTAIN TILE",
  [TILE_FOG]: "FOG TILE",
  [TILE_FOG_OBSTACLE]: "FOG OBSTACLE TILE"
};

// Objective types
const GENERAL_OBJECTIVE = "GENERAL";
const CITY_OBJECTIVE = "CITY";
const POSITION_OBJECTIVE = "POSITION";
const REINFORCE_OBJECTIVE = "REINFORCEMENT";

module.exports = class Bot {
  path = "./logs/";
  filename = "log.txt";

  /*
    Configure the bots behaviour
  */

  // The latest game tick that the bot will pull armies off it's general tile
  PULL_FROM_GENERAL_MAX = 50;

  // The earliest game tick that the bot will start to attack cities
  ATTACK_CITIES_MIN = 100;

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

  // mechanism for freeing the bot when it's gotten stuck
  checksum = null;
  no_change_count = 0;
  no_change_threshold = 5;
  lastAttemptedMove = null;

  // initialize the socket for emiting bot events
  constructor(socket) {
    // set the socket
    if (socket) {
      this.socket = socket;
    } else {
      this.socket = new events.EventEmitter();
    }
    var now = new Date();
    this.filename =
      "LOG_" +
      now.getFullYear() +
      "-" +
      now.getMonth() +
      "-" +
      now.getDate() +
      "_" +
      now.getHours() +
      "-" +
      now.getMinutes() +
      ".txt";
    if (process.env.LOG) {
      console.log("LOGGING TURNED ON");
      console.log(`LOG FILE: ${this.path + this.filename}`);
    } else {
      console.log("LOGGIN TURNED OFF");
    }
  }

  // chat helper
  chat = (msg) => {
    this.socket.emit("chat_message", this.chat_room, msg);
  };

  // clear move queue
  clear = () => {
    this.socket.emit("clear_moves");
  };

  // log function for debugging
  log = function () {
    if (process.env.LOG) {
      let arr = [...arguments].map((param) => {
        if (typeof param === "object") {
          return JSON.stringify(param, null, 2);
        } else {
          return param;
        }
      });
      fs.appendFileSync(this.path + this.filename, arr.join(" ") + "\n");
    } else {
      // console.log(...arguments);
    }
  };

  // getter for the socket or event emitter
  getSocket = () => {
    return this.socket;
  };

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
  patch(old, diff) {
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
  }

  addObjective = (obj, toFront = false) => {
    this.log(`Adding ${obj.type} objective, target: ${obj.target}`);
    this.log(`Queue length ${this.objective_queue.length}`);
    let queue = this.objective_queue.map((obj) => obj.type);
    this.log(`Queue: `, queue);
    if (toFront) {
      this.objective_queue.unshift(obj);
    } else {
      this.objective_queue.push(obj);
    }
  };

  // gather all useful data from all we are give from the game server
  gatherIntel = (data) => {
    this.log("[PUSH GATHERINTEL]");

    // set the bots index
    if (this.playerIndex === null) {
      this.playerIndex = data.playerIndex;
    }

    // game timing
    this.internal_tick = data.turn / 2;
    this.game_tick = Math.ceil(this.internal_tick);
    this.ticks_til_payday = 25 - (this.game_tick % 25);

    // update map variables
    this.map = this.patch(this.map, data.map_diff);
    this.width = this.map[0];
    this.height = this.map[1];
    this.size = this.width * this.height;
    this.armies = this.map.slice(2, this.size + 2);
    this.terrain = this.map.slice(this.size + 2, this.size + 2 + this.size);

    // recognize borders
    let allTiles = Array(this.size)
      .fill(false)
      .map((empty_val, tile) => tile);
    this.leftBorder = allTiles.filter((tile) => this.isLeftBorder(tile));
    this.rightBorder = allTiles.filter((tile) => this.isRightBorder(tile));

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
      /*
      this.log('==STARTING REPORT', {
        general: this.general_tile,
        owned: this.owned,
        current: `${this.current_tile}, (${this.current_coords.x}, ${this.current_coords.y})`,
        dimensions: `${this.width} x ${this.height}`,
      });
      */
    }

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
        .map((tile) => this.armiesAtTile(tile))
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
      // this.clear();
    }
    this.checksum = newChecksum;

    this.log("[POP GATHERINTEL]");
  };

  // runs twice every game tick
  update = (data) => {
    this.log("=================================");
    this.log(`GAME TICK ${data.turn / 2}`);
    this.log("=================================");
    this.log("[PUSH UPDATE]");

    this.gatherIntel(data);

    // skip lots of processing if we can't even make a move
    if (this.isFullyStretched()) {
      this.log("Skipping move since we are fully stretched");
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
      this.log(`Last move failed: ${lastMoveFailed}`);
      if (lastMoveFailed) {
        this.log("FOUND FAILED MOVE, reattempting");
        this.attack(this.lastAttemptedMove.from, this.lastAttemptedMove.to);
        return;
      }
    }

    /*
      POTENTIALLY BEGIN TARGETING A GENERAL
    */
    if (
      JSON.stringify(this.generals) !== JSON.stringify(data.generals) &&
      this.game_tick !== 0 &&
      this.ATTACK_GENERALS &&
      this.USE_OBJECTIVES
    ) {
      // log things
      this.log("GENERALS has been updated");
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
    this.generals = data.generals;

    /*
      POTENTIALLY BEGIN TARGETING A CITY
    */
    let cities = this.patch(this.cities, data.cities_diff);
    if (
      JSON.stringify(cities) !== JSON.stringify(this.cities) &&
      this.game_tick >= this.ATTACK_CITIES_MIN &&
      this.ATTACK_CITIES &&
      this.USE_OBJECTIVES
    ) {
      // filter out owned cities (owned by any player)
      let unowned_cities = cities.filter((city) => city !== TILE_EMPTY);

      // log things
      this.log("CITIES has been updated");
      this.log({ all_cities: cities, all_unowned_cities: unowned_cities });

      // Only focus on new visible cities before a specified game tick
      if (
        this.game_tick < this.ATTACK_CITIES_MAX &&
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
    this.cities = cities;

    if (data.turn > 1) {
      this.doNextMove(data);
    }
    this.log("[POP UPDATE]");
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
    this.log("[PUSH DONEXTMOVE]");
    this.log(`OBJECTIVE QUEUE LENGTH ${this.objective_queue.length}`);

    // find the next objective
    let objective;
    let attempt = 0;
    while (objective === undefined && this.objective_queue.length > 0) {
      this.log(`Looking for next/current objective, attempt #${++attempt}`);

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
        this.log("process old objective", completed_objective);

        // consider renewing objective immediately
        if (
          completed_objective.complete &&
          !this.isOwned(completed_objective.target)
        ) {
          // only renew the objective if the target is not now owned
          // this is part of why this logic needs to happen on the tick after the last queue's move
          if (!this.isOwned(completed_objective.target)) {
            this.log("renewing objective", completed_objective);
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
          this.log(`set current_tile to best not general source tile ${best}`);
          this.current_tile = best;
        }

        // Do something once the objective queue has been emptied
        if (this.objective_queue.length <= 0) {
          // ... do thing ...
          this.log("OBJECTIVE QUEUE IS EMPTY");
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
      this.log("Reinforcing general");
      let newObj = new Objective(REINFORCE_OBJECTIVE, this.general_tile); // asdf
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
        this.log("OBJECTIVE COMPLETE", completed_objective);

        // more debug logs for cities
        if (completed_objective.type === CITY_OBJECTIVE) {
          this.log(
            "city obj finished, terrain is",
            this.terrain[completed_objective.target]
          );
          this.log("cities are", this.cities);
          this.log(
            "armies at target city",
            this.armies[completed_objective.target]
          );
        }

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
    this.log("[POP DONEXTMOVE]");
  };

  // takes a queue and returns the updated queue,
  // this function will handle executing the move and refreshing the queue
  // if the queue needs to be continued from a better source.
  executeObjectiveStep = (objective) => {
    this.log("[PUSH EXECUTEOBJECTIVESTEP]");
    // this.chat(`Moving towards tile ${objective.target}`)
    const LOG_OBJECTIVE_STEP = true;
    if (LOG_OBJECTIVE_STEP) {
      this.log("Running next step on objective", objective);
    }

    // return objective if queue is empty
    if (objective.queue !== null && objective.queue.length <= 0) {
      if (LOG_OBJECTIVE_STEP) {
        this.log("Objective has empty queue");
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
      this.log("setting current tile to next move");
      this.current_tile = objective.getNextMove();
    }

    if (objective.queue === null || this.armiesAtTile(this.current_tile) <= 1) {
      if (LOG_OBJECTIVE_STEP) {
        this.log("refreshing/initializing queue");
        if (objective.queue === null) {
          this.log("because queue is null");
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
        if (objective.queue === null) {
          this.log("objective queue found null, needs refreshing");
        } else if (!this.current_tile) {
          this.log("current tile not found, objective queue needs refreshing");
        } else {
          this.log(
            `current tile ${this.current_tile}, armies = ${this.armiesAtTile(
              this.current_tile
            )}`
          );
          this.log("no armies at current tile, queue needs refreshing");
        }
      }
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
        this.log("next tile", next_tile);
      }
      if (next_tile === this.current_tile) {
        next_tile = objective.queue.shift();
        if (LOG_OBJECTIVE_STEP) {
          this.log("next tile is current, get next tile", next_tile);
          this.log("next tile", next_tile);
        }
      }

      if (next_tile === objective.target) {
        this.log(
          "Marking objective as complete, processing completion on next tick"
        );
        objective.complete = true;
      }
      this.attack(this.current_tile, next_tile);
      this.current_tile = next_tile;
    } else {
    }
    this.log("[POP EXECUTEOBJECTIVESTEP]");
    return objective;
  };

  getSurroundingTiles = (index) => {
    return [
      this.getUp(index),
      this.getRight(index),
      this.getDown(index),
      this.getLeft(index)
    ];
  };


  getSurroundingTerrain = (index) => {
    let terrain = this.getSurroundingTiles(index).map(
      (tile) => this.terrain[tile]
    );
    return terrain;
  };

  randomMove = (
    data,
    priority = [
      this.isLowEnemy, // Enemy Owned
      this.isEmpty, // Empty
      this.isOwned // Self Owned
    ]
  ) => {
    this.log("[PUSH RANDOMMOVE]");
    const LOG_RANDOM_MOVE = true;

    // start trying to determine the next move
    let found_move = false;
    let set_queue_abandon_loop = false;
    let attempt = 0;
    while (!found_move && !set_queue_abandon_loop) {
      this.log(`Attempt #${++attempt}`);

      // set our desired starting point for the next move to null
      let from_index = null;

      // let's start by trying to get the best frontline
      from_index = this.getBestFrontline(
        this.game_tick < this.PULL_FROM_GENERAL_MAX
      );

      if (from_index !== null) {
        this.log(`from_index is frontline`);
      }

      // if there are no frontlines available, we'll get from perimeter instead
      // if there are frontlines, we'll want to schedule an objective to reinforce it
      if (from_index === null && this.frontline.length <= 0) {
        this.log(`no frontline found`);
        from_index = this.getBestPerimeter(
          this.game_tick < this.PULL_FROM_GENERAL_MAX
        );
        if (from_index !== null) {
          this.log(`from_index is perimeter with no frontline`);
        }
      }

      // we've found a frontline with armies
      // in this case we will move directly from this square to another,
      // other scenarios will involve queueing an objective to bring armies to the frontline or perimeter
      if (from_index !== null) {
        let options = this.getSurroundingTiles(from_index);

        // start loop to consider options based on prioroty
        for (let i = 0; i < priority.length; i++) {
          // map the options to array indicating
          // whether the options is usable or not,
          // while preserving the index of the option
          let can_use = options.map(
            (op) =>
              priority[i](op) &&
              (!this.isCity(op) || this.game_tick >= this.ATTACK_CITIES_MIN)
          );

          // let's not enter the loop below if there are no usable options
          // this should never be true because of the if we are in, but just in case...
          if (
            can_use.length <= 0 ||
            can_use.filter((op) => Boolean(op)).length <= 0
          ) {
            this.log(`No options matching priority ${priority[i].name}`);
            continue;
          } else {
            this.log(`Found options matching priority ${priority[i].name}`);
          }

          this.log("found usable options for move from frontline/perimeter");

          // get a random usable option from the options list
          let to_index;
          let found_to_index = false;
          let inner_attempt = 0;

          // start loop for finding to_index
          while (!found_to_index) {
            this.log(`Attempt #${attempt}:${++inner_attempt}`);
            let index = null;

            // if the options are enemy tiles, let's select the one with the least armies
            if (this.isEnemy(options[0])) {
              let lowest_armies = null;
              let lowest_armies_index = null;
              options.forEach((each, idx) => {
                if (
                  can_use[idx] &&
                  (lowest_armies === null ||
                    this.armiesAtTile(each) < lowest_armies)
                ) {
                  lowest_armies = this.armiesAtTile(each);
                  lowest_armies_index = idx;
                }
              });
              index = lowest_armies_index;
              if (index !== null) {
                this.log(
                  `from ${from_index}, planning to attack weakest army at option ${index}`
                );
                this.log(
                  `It's tile ${options[index]} and can_use is ${can_use[index]}`
                );
              }
            }

            // if the options are empty tiles, let's select the one closest to the center tile
            if (this.isEmpty(options[0])) {
              let closest = null;
              let closest_index = null;
              let center = Math.floor(this.size / 2);
              options.forEach((each, idx) => {
                if (
                  can_use[idx] &&
                  (closest === null ||
                    this.distanceBetweenTiles(each, center) < closest)
                ) {
                  closest = this.distanceBetweenTiles(each, center);
                  closest_index = idx;
                }
              });
              index = closest_index;
              if (index !== null) {
                this.log(
                  `from ${from_index}, planning to attack empty tile closest to center at option ${index}`
                );
                this.log(
                  `It's tile ${options[index]} and can_use is ${can_use[index]}`
                );
              }
            }

            // as a backup, we'll get a random option index
            if (index === null) {
              index = Math.floor(Math.random() * options.length);
              this.log(`planning to attack random tile: ${options[index]}`);
            }

            // double check if the option at that index is usable
            if (can_use[index]) {
              // if so, let's set our to_index and leave the loop
              to_index = index;
              found_to_index = true;
              if (LOG_RANDOM_MOVE) {
                const MOVE_MAP = ["up", "right", "down", "left"];
                this.log(
                  `moving ${MOVE_MAP[to_index]} to ${options[to_index]}`
                );
              }
            }
          } // end loop for finding to_index from options matching current priority

          // translate option index to an actual move
          const optionsToMovesMap = [this.up, this.right, this.down, this.left];
          let next_move = optionsToMovesMap[to_index];
          found_move = true;

          // get type of index we are taking
          let taking_type = this.terrain[options[to_index]];
          this.log({ taking_type, last_type_taken: this.last_type_taken });

          // set last type taken
          this.last_type_taken = taking_type;

          // If we are taking a player tile and we are about to run out of armies to attack,
          // let's plan on reinforcing this frontline
          const armiesBelowThreshold =
            this.armiesAtTile(this.general_tile) < this.game_tick;
          const armiesMinAcheived =
            this.armiesAtTile(this.general_tile) > this.GENERAL_MIN;
          if (
            this.ATTACK_ENEMIES &&
            this.USE_OBJECTIVES &&
            this.isEnemy(taking_type) &&
            this.armies[from_index] <= 2 && // don't start the enemy target objective until we're almost out on the frontline
            (!armiesBelowThreshold || armiesMinAcheived)
          ) {
            this.log(`Targeting player ${this.usernames[taking_type]}`);
            let newObj = new Objective(
              POSITION_OBJECTIVE,
              options[to_index],
              null,
              true
            );
            newObj.tick_created = this.internal_tick;

            // add it to front of the queue as long as we are not in the middle of reinforcing the general tile
            let armies_at_general = this.armiesAtTile(this.general_tile);
            if (
              (armies_at_general >= this.game_tick ||
                armies_at_general >= this.GENERAL_MIN) &&
              !this.isAttackingGeneral()
            ) {
              this.addObjective(newObj, true);
            }
          }

          // perform our next move
          next_move(from_index);

          break; // break from priority for loop, since we made it this far.
          // earlier in the loop we would have run 'continue' had we wanted it to.
        } // end loop to consider options based on prioroty

        // quit outermost while loop if we've found our move
        if (found_move) {
          set_queue_abandon_loop = true; // set this as a security measure
          break;
        }
      } // end if statement for when frontline tile was found, or a perimeter tile was found after
      // checking that no other frontline tiles exist.

      /*
        If from_index is not frontline but is permieter, and there are frontline tiles,
        then let's move troops to the weak frontline we've detected.
      */
      if (
        this.EXPAND_FRONTLINE &&
        this.USE_OBJECTIVES &&
        from_index === null &&
        this.frontline.length > 0
      ) {
        this.log(`Trying to expand frontline`);

        // schedule objective to go towards perimeter
        let best_source = this.getBestSourceTile(
          this.game_tick < this.PULL_FROM_GENERAL_MAX
        );
        let closest_frontline = this.getClosestFrontline(best_source);

        // check if it really is a perimeter, because getRandomPerimeter falls back to
        // returning a random owned tile
        if (
          best_source !== null &&
          closest_frontline !== null &&
          this.isFrontline(closest_frontline)
        ) {
          this.log("Expanding frontline");
          let queue = this.getPathDepthFirst(best_source, closest_frontline);
          let newObj = new Objective(
            POSITION_OBJECTIVE,
            closest_frontline,
            queue,
            false
          );
          newObj.tick_created = this.internal_tick;
          this.addObjective(newObj);
          this.doNextMove(data);

          set_queue_abandon_loop = true;
          break;
        } else {
          this.log(`failed expanding frontline`);
          this.log({
            best_source,
            closest_frontline,
            isFrontline: this.isFrontline(closest_frontline)
          });
        }
      } else {
        this.log(`can't attempt expanding frontline`);
        this.log({
          expand_frontline_setting: this.EXPAND_FRONTLINE,
          use_objectives_setting: this.USE_OBJECTIVES,
          from_index: from_index,
          frontline: this.frontline
        });
      }

      /*
        If from_index is neither frontline, nor perimeter (best source),
        but there are perimeters, just without armies, then let's bring our armies to the weak perimeter
      */
      if (
        this.EXPAND_FRONTLINE &&
        this.USE_OBJECTIVES &&
        from_index === null &&
        this.perimeter.length > 0 &&
        this.frontline.length <= 0 &&
        this.game_tick > 1
      ) {
        this.log(`Trying to expand perimeter`);

        // schedule objective to go towards perimeter
        let best_source = this.getBestSourceTile(
          this.game_tick < this.PULL_FROM_GENERAL_MAX
        );
        let closest_perimeter = this.getClosestPerimeter(best_source);

        // check if it really is a perimeter, because getRandomPerimeter falls back to
        // returning a random owned tile
        if (
          best_source !== null &&
          closest_perimeter !== null &&
          this.isPerimeter(closest_perimeter)
        ) {
          this.log("Expanding perimeter");
          let queue = this.getPathDepthFirst(best_source, closest_perimeter);
          let newObj = new Objective(
            POSITION_OBJECTIVE,
            closest_perimeter,
            queue,
            false
          );
          newObj.tick_created = this.internal_tick;
          this.addObjective(newObj);
          this.doNextMove(data);

          set_queue_abandon_loop = true;
          break;
        } else {
          this.log(`Failed expanding perimeter`);
          this.log({
            best_source,
            closest_perimeter,
            isPerimeter: this.isPerimeter(closest_perimeter)
          });
        }
      } else {
        this.log(`can't attempt expanding perimeter`);
        this.log({
          expand_frontline_setting: this.EXPAND_FRONTLINE,
          use_objectives_setting: this.USE_OBJECTIVES,
          from_index: from_index,
          game_tick: this.game_tick,
          frontline: this.frontline,
          perimeter: this.perimeter
        });
      }
    }
    this.log("[POP RANDOMMOVE]");
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
      fromTerrain: this.terrain[from]
    };
  };

  attack = function (from, to) {
    this.log(`launching attacking from ${from} to ${to}`);
    this.lastAttemptedMove = this.recordMove(from, to);
    this.current_tile = to;
    this.socket.emit("attack", from, to);
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

      // if tile is on right edge
      if (this.isRightBorder(tile)) {
        // set right tile to false
        surrounding_mapped[1] = false;
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

  isLeftBorder = (tile) => tile % this.width === 0;

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
  isLowEnemy = (tile, lowness_threshold = 1) => {
    return (
      this.terrain[tile] !== this.playerIndex &&
      this.terrain[tile] >= 0 &&
      this.armies[tile] <= lowness_threshold
    );
  };

  // returns true or false if an enemy owns a tile within our comfort threshold
  isEnemyClose = () => {
    let isEnemyClose = this.enemies
      .map((tile) => this.distanceBetweenTiles(this.general_tile, tile))
      .some((distance) => distance >= this.CLOSENESS_LIMIT);
    this.log("REINFORCE GENERAL, ENEMY IS TOO CLOSE");
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
      if (armies_at_tile > most_armies) {
        best_tile = tile;
        most_armies = armies_at_tile;
      }
    });
    return best_tile;
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
        this.log("Stopped searching path due to length limit");
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
