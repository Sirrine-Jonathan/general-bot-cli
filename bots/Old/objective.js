/**
 * @format
 */
module.exports = class Objective {
  constructor(type, target, queue = null, started = false) {
    this.type = type;
    this.target = target;
    this.queue = queue;
    this.started = started;
    this.complete = false;
    this.initial_takeover_requirement;
    this.take_over_requirement;
    this.tick_created;
    this.tick_renewed;
  }

  peakNextMove = () => {
    return this.queue[0];
  };

  getNextMove = () => {
    return this.queue.shift();
  };

  initTakeoverRequirement = (num) => {
    this.initial_takeover_requirement = num;
  };

  setTakeoverRequirement = (num) => {
    this.take_over_requirement = num;
  };
};
