/**
 * [Bot] Blank
 * Exists for defining the api, and as a starting point for future bots
 *
 * @format
 */

var events = require("events");
const Objective = require("./objective.js");
const { getRandomQuote } = require("./quotes.js");

// Terrain Constants.
// Any tile with a nonnegative value is owned by the player corresponding to its value.
// For example, a tile with value 1 is owned by the player with playerIndex = 1.
const TILE_EMPTY = -1;
const TILE_MOUNTAIN = -2;
const TILE_FOG = -3;
const TILE_FOG_OBSTACLE = -4; // Cities and Mountains show up as Obstacles in the fog of war.

// Objective types
const GENERAL_OBJECTIVE = "GENERAL";
const CITY_OBJECTIVE = "CITY";
const POSITION_OBJECTIVE = "POSITION";
const REINFORCE_OBJECTIVE = "REINFORCEMENT";

// exports a class named Bot
module.exports = class Bot {
  playerIndex = null;

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
  // END BOT SPECIFIC PROPS

  // constructor takes a socket or setups an event emitter
  constructor(config) {
    this.user_id = config.user_id;
    this.username = config.username;
    this.em = new events.EventEmitter();
    this.log(`Bot ${config.username} created`)
  }

  // each function is named after the event received from the game server
  game_start = (data) => {
    this.playerIndex = data.playerIndex;
    this.replay_id = data.playerIndex;
    this.chat_room = data.playerIndex;
    this.team_chat_room = data.playerIndex;
    this.usernames = data.usernames;
    this.teams = data.teams;
    this.chat_message('Have Fun!');
  };
  // runs twice every game tick
  game_update = (data) => {
    this.log("=================================");
    this.log(`GAME TICK ${data.turn / 2}`);
    this.log("=================================");

    this.gatherIntel(data);

    // skip lots of processing if we can't even make a move
    if (this.isFullyStretched()) {
      this.log("Fully Stretched");
      return;
    }

    if (data.turn > 1) {
      this.doNextMove(data);
    }
  }

  game_lost = (data) => {
    this.chat_message(`Oh no, ${data.killer} got me!`);
  };

  game_won = (data) => {
    this.log("WIN DATA: ", data);
    this.chat_message(`Thanks for playing!`);
  };
  receive_chat_message = (chat_room, data) => {
    // do fun things with other players chat messages
  };
  stars = (data) => {};
  rank = (data) => {};

  // here are all function that the bot can use to interface with the game server
  // when these are called, emit an evit by the same name for the bot server to send to the game server
  set_username = (user_id = this.user_id, username = this.username) => {
    this.log("Setting bot username");
    this.em.emit("set_username", user_id, username);
  }
  play = (user_id = this.user_id) => {
    this.log("Joining FFA");
    this.em.emit('play', user_id);
  }
  join_1v1 = (user_id = this.user_id) => {
    this.log("Joining 1v1");
    this.em.emit('join_1v1', user_id);
  }
  join_private = (custom_game_id, user_id = this.user_id) => {
    console.log("bot called join_private");
    this.log(`Joining custom game ${custom_game_id} with bot id ${user_id}`);
    this.em.emit("join_private", custom_game_id, user_id);
    this.chat_message(`Hi everyone! I will destroy you lol`);
  }
  set_custom_team = (custom_game_id, team) => {
    this.log(`Joining custom team ${team} on ${custom_game_id}`);
    this.em.emit("set_custom_team", custom_game_id, team);
  }
  join_team = (team_id, user_id = this.user_id) => {
    this.log(`Joining team ${team_id}`);
    this.em.emit("join_team", team_id, user_id);
  }
  leave_team = (team_id) => {
    this.log(`Leaving team ${team_id}`);
    this.em.emit("leave_team", team_id);
  }
  cancel = () => {
    this.log(`Leaving the game queue`);
    this.em.emit('cancel');
  }
  set_force_start = (queue_id, doForce) => {
    this.log(`Setting force_start to ${doForce} for queue ${queue_id}`);
    this.em.emit('set_force_start', queue_id, doForce);
  }
  attack = (start, end, is50 = false) => {
    this.log(`Attacking from ${start} to ${end}`);
    this.lastAttemptedMove = this.recordMove(from, to);
    this.current_tile = to;
    this.em.emit('attack', start, end, is50);
  }
  clear_moves = () => {
    this.em.emit('clear_moves');
  }
  pint_tile = (index) => {
    this.em.emit('ping_tile', index);
  }
  chat_message = (text, chat_room = this.chat_room) => {
    this.em.emit('chat_message', chat_room, text);
  }
  // contrived function that allows bot to specify team only chat
  team_chat_message = (text, chat_room = this.team_chat_room) => {
    this.em.emit('chat_message', chat_room, text); // purposefully emits 'chat_message' with team_chat_room
  }
  leave_game = () => {
    this.log('Leaving game');
    this.em.emit('leave_game');
  }
  stars_and_rank = (user_id = this.user_id) => {
    this.em.emit
    ('stars_and_rank', user_id);
  }

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

  log = function (...params) {
    let arr = [...params].map((param) => {
      if (typeof param === "object") {
        return JSON.stringify(param, null, 2);
      } else {
        return param;
      }
    });
    this.em.emit('log', arr.join(' '))
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

  /*
    FUNCTIONS SPECIFIC TO THIS BOT
  */

  gatherIntel = (data) => {
    // update generals
    this.generals = data.generals;

    // update cities
    //this.cities = this.patch(this.cities, data.cities_diff);
  }

  doNextMove = (data) => {

  }
};
