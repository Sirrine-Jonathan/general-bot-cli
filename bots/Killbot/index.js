/**
 * [Bot] Blank
 * Exists for defining the api, and as a starting point for future bots
 *
 * @format
 */

var events = require("events");

// exports a class named Bot
module.exports = class Bot {
  playerIndex = null;
  owned = [];

  // constructor takes a socket or setups an event emitter
  constructor(config) {
    this.user_id = config.user_id;
    this.username = config.username;
    this.em = new events.EventEmitter();
  }

  // log function for debugging
  log = function () {
    let arr = [...arguments].map((param) => {
      if (typeof param === "object") {
        return JSON.stringify(param, null, 2);
      } else {
        return param;
      }
    });
    this.em.emit('log', arr.join(" ") + "\n")
  };

  // each function is named after the event received from the game server
  game_start = (data) => {
    this.playerIndex = data.playerIndex;
    this.replay_id = data.playerIndex;
    this.chat_room = data.playerIndex;
    this.team_chat_room = data.playerIndex;
    this.usernames = data.usernames;
    this.teams = data.teams;
  };
  game_update = (data) => {};
  game_lost = (data) => {};
  game_won = (data) => {};
  chat_message = (chat_room, data) => {};
  stars = (data) => {};
  rank = (data) => {};

  // here are all function that the bot can use to interface with the game server
  // when these are called, emit an evit by the same name for the bot server to send to the game server
  set_username = () => {}
  play = () => {}
  join_1v1 = (user_id = this.user_id) => {
    this.log("Joining 1v1");
    this.em.emit('join_1v1', user_id);
  }
  join_private = (custom_game_id, user_id = this.user_id) => {
    this.log('Bot emitting join_private event');
    this.em.emit("join_private", custom_game_id, user_id);
  }
  set_custom_team = () => {}
  join_team = () => {}
  leave_team = () => {}
  cancel = () => {
    this.log(`Leaving the game queue`);
    this.em.emit('cancel');
  }
  set_force_start = (queue_id, doForce) => {
    this.log(`Setting force_start to ${doForce} for queue ${queue_id}`);
    this.em.emit('set_force_start', queue_id, doForce);
  }
  attack = () => {}
  clear_moves = () => {}
  pint_tile = () => {}
  chat_message = () => {}
  leave_game = () => {
    this.log('Leaving game');
    this.em.emit('leave_game');
  }
  stars_and_rank = () => {}
};
