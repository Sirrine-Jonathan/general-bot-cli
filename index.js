/**
 * eslint-disable no-continue
 * eslint-disable no-unused-vars
 * eslint-disable no-plusplus
 * @format
 */

const server_config = require('./config');
const fs = require('fs');
const figlet = require('figlet');
const docs = require('./docs');
let replay_url = null;
let replay_id = null;
let global_game_id = null;
let quick_start_ran = false;
let log_lines = [];
let intent_to_change_bot = false;
let bot = null;
let file = null;
const afterQ = '\n>:';
const base = 'https://bot.generals.io'; // wss://botws.generals.io
const io = require('socket.io-client');
const socket = io(base);

// get bot names
// eslint-disable-next-line no-undef
const bots = fs.readdirSync(__dirname + '/bots', { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name);

// map them out
const bot_map = {};
const config_map = {};
bots.map((bot) => {
  if (bot !== 'blank'){
    bot_map[bot] = require('./bots/' + bot);
    config_map[bot] = require('./bots/' + bot + '/config');
  }
});


// default to first bot
let global_bot_name = server_config.default_bot;
let global_bot_config = config_map[global_bot_name];

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

// Adds a line to what will be logged out to a file on game end
function log(line){
  log_lines = [...log_lines, line];
}

function writeLog(){
  if (log_lines.length > 0 && file){
    fs.appendFileSync(file, log_lines.join('\n') + '\n\n', (err) => {
      if (err) console.log(err);
      log_lines = [];
    });
  }
}

function setFile(){
  const now = new Date();
  const filename = global_bot_name + '_' + [
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes()
  ].join('-') + '.txt';
  file = `./logs/${filename}`;
  console.log(`Log file set to ${file}`);
  return file;
}

socket.on('disconnect', () => {
  let msg = 'Disconnected from game server';
  log(msg);
  writeLog();
  log_lines = [];
  // restart();
});

// eslint-disable-next-line no-unused-vars
// function restart(delay) {
//   console.log(`Restarting in ${(delay ?? server_config.restartWaitTime) / 1000} seconds`);
//   setTimeout(() => {
//     console.log('Reconnecting to game server');
//     socket.connect();
//   }, delay ?? server_config.restartWaitTime);
// }

/*
function attachSendEvents(bot){
  // events that can be sent to the game server by the bot
  let send_events = [
    'set_username',
    'play',
    'join_1v1',
    'join_private',
    'join_team',
    'set_custom_team',
    'leave_team',
    'cancel',
    'set_force_start',
    'attack',
    'clear_moves',
    'ping_tile',
    'chat_message',
    'leave_game',
    'stars_and_rank',
  ];
  send_events.forEach((event) => {
    bot.em.on(event, (...params) => {
      log(`BOT SENDING ${event} ${JSON.stringify([...params])}`);
      socket.emit(event, ...params);

      if (event === 'leave_game'){
        replay_url = null;
        replay_id = null;
        console.log('disconnecting event', event);
        socket.disconnect();
      }
    });
  });

  // call the server log function when the bot calls log
  bot.em.on('log', log);
}
*/

function attachReceiveEvents(bot){
  // events that are received from the game server and passed to the bot
  let receive_events = [
    'game_start',
    'game_update',
    'game_lost',
    'game_won',
    'chat_message',
    'stars',
    'rank',
  ];
  receive_events.forEach((event) => {
    socket.on(event, (...params) => {

      // log lines on game_update

      if (event === 'chat_message'){
        const [name, data] = [...params];
        log(`CHAT ${name}: ${data.text}`);
      }

      // we pass the event data to a function
      // implemented by the bot sharing the same name as the event
      let bot_function = event === 'chat_message' ? 'receive_chat_message' : event;
      bot?.[bot_function](...params);

      const [data] = [...params];

      // on game_start let's set the replay_url
      if (event === 'game_start') {
        replay_id = encodeURIComponent(data.replay_id);
        replay_url = `http://bot.generals.io/replays/${replay_id}`;
        log(`Replay URL: ${replay_url}`);
      }

      if ((event === 'game_won' || event === 'game_lost') && (replay_url !== null && replay_id !== null)){
        console.log(`${event} so ${bot.username} is leaving game`);
        bot.leave_game();
      }
    });
  });
}

socket.on('connect', () => {

  // now that we're connected, let's load the bot
  loadBot(global_bot_name);

  function promptForNewBot(){
    if (bot){
      showBotLoaded();
      console.log();
    }
    console.log('Available Bots:\n');
    Object.keys(bot_map).forEach(bot => console.log(` - ${bot}`));
    intent_to_change_bot = true;
  }
  function loadBot(bot_name, log = false){
    bot = null;
    global_bot_name = bot_name;
    global_bot_config = config_map[bot_name];
    const file = setFile();
    bot = new bot_map[global_bot_name]({
      user_id: global_bot_config.user_id,
      username: global_bot_config.username,
      socket,
      file,
    });

    attachReceiveEvents(bot);
    if (log){
      console.log(`"${bot.username}" loaded`);
    }
    intent_to_change_bot = false;
  }
  function showBotLoaded(){
    console.log(`"${bot.username}" currently loaded`);
  }
  var recursiveAsyncReadLine = function (prompt = '') {
    readline.question(`${prompt}${afterQ}`, function (command) {
      command = command.trim();

      if (command === ''){
        console.log('\nInteract with the server by entering a command from the list');
        console.log('If ever you want to see this list again, just enter "help", "docs", or simply, "h"\n');
        console.log(docs);
        recursiveAsyncReadLine();
        return;
      }

      if (command === 'exit'){
        console.log('\nGoodbye!');
        readline.close();
        bot.leave_game();
        return process.exit(0);
      }

      if (command.includes('change bot')){
        if (command.split(' ').length >= 3){
          let bots = Object.keys(bot_map);
          let bot_name = command.split(' ')[2];
          if (bots.indexOf(bot_name) >= 0){
            loadBot(bot_name, true);
            recursiveAsyncReadLine();
          } else {
            console.log(`Bot "${bot_name}" Unavailable`);
            promptForNewBot();
            recursiveAsyncReadLine();
          }
          return;
        } else {
          promptForNewBot();
          recursiveAsyncReadLine();
          return;
        }
      }

      if (intent_to_change_bot){
        let bots = Object.keys(bot_map);
        if (bots.indexOf(command) >= 0){
          loadBot(command, true);
          recursiveAsyncReadLine();
        } else {
          console.log(`Bot "${command}" Unavailable`);
          promptForNewBot();
          recursiveAsyncReadLine();
        }
        return;
      }

      if (command === 'set username') {
        bot.set_username(bot.user_id, bot.username);
      } else if (command === 'check connection') {
        console.log(`Connected ${socket.connected ? 'true':'false'}`);
      } else if (command === 'check bot'){
        showBotLoaded();
      } else if (command === 'connect'){
        if (!socket.connected){
          socket.connect();
        } else {
          console.log('Already connected');
        }
      } else if (command === 'play') {
        bot.play(bot.user_id);
      } else if (command === 'join 1v1') {
        bot.join_1v1(bot.user_id);
      } else if (command.includes('join private') && command.split(' ').length >= 3){
        const split = command.split(' ');
        global_game_id = split[2];
        console.log(`Sending bot ${bot.username} to private game ${global_game_id}\n`);
        bot.join_private(global_game_id, bot.user_id);
      } else if (command.includes('set custom team')) {
        if (command.split(' ').length >= 4){
          let game_id = global_game_id;
          let team_id = command.split(' ')[3];
          if (command.split(' ').length >= 5){
            game_id = command.split(' ')[4];
          }
          bot.set_custom_team(game_id, team_id);
        } else {
          console.log('Invalid format: set custom team <game_id> <team>');
        }
      } else if (command.includes('join team')) {
        if (command.split(' ').length < 3){
          console.log('Invalid format: join team <team_id>');
        } else {
          const team_id = command.split(' ')[2];
          bot.join_team(team_id, bot.user_id);
        }
      } else if (command.includes('leave team')) {
        if (command.split(' ').length <= 3){
          console.log('Invalid format: leave team <team_id>');
        } else {
          const team_id = command.split(' ')[2];
          bot.leave_team(team_id);
        }
      } else if (command === 'cancel') {
        bot.cancel();
      } else if (command === 'force start') {
        bot.set_force_start(global_game_id, true);
      } else if (command.includes('attack')) {
        let arr = command.split(' ');
        if (arr.length >= 3){
          if (arr.length > 3){
            bot.attack(arr[1], arr[2], true);
          } else {
            bot.attack(arr[1], arr[2], false);
          }
        } else {
          console.log('Invalid format: attack <start> <end> <is50>');
        }
      } else if (command === 'clear moves') {
        bot.clear_moves();
      } else if (command.includes('ping tile')) {
        if (command.split(' ').length < 3){
          console.log('Invalid format: ping tile <index>');
        } else {
          bot.ping_tile(command.split(' ')[2]);
        }
      } else if (command === 'leave') {
        bot.leave_game();
      } else if (command === 'stars and rank') {
        bot.stars_and_rank();
      } else if (command === 'help' || command === 'docs' || command === 'h') {
        console.log(docs);
      } else {
        console.log('Command not found');
        console.log(docs);
      }
      recursiveAsyncReadLine();
    });
  };

  figlet.text('\nGenerals Bots', { font: 'Graffiti' }, function(err, welcome_text) {
    if (err) {
      console.log('Something went wrong...');
      console.dir(err);
      return;
    }

    // display title
    let border_length = 88;
    let border = '';
    for (let i = 0; i < border_length; i++) border += '=';
    console.log(`${border}\n`);
    console.log(welcome_text);
    console.log(`\n${border}`);

    // grab optional quick start params
    const args = process.argv.slice(2);
    if (args.length > 0 && !quick_start_ran){
      console.log('\n');
      global_bot_name = args[0].trim();
      loadBot(global_bot_name, true);
      if (args.length > 1){
        global_game_id = args[1].trim();
        console.log(`Sending ${bot.username} to private game ${global_game_id}`);
        bot.join_private(global_game_id, bot.user_id);
        setTimeout(() => bot.set_force_start(global_game_id, true), 1000);
        quick_start_ran = true;
      }

    // if no quickstart params given, give some starting information
    } else {
      console.log('\n\nWelcome to the CLI for generals.io bots!');
      console.log(`The bot set to load by default is "${global_bot_config.username}"\n`);
      console.log('Press \'Enter\' to get started...');
    }

    // begin listening for commands
    recursiveAsyncReadLine();
  });
});
