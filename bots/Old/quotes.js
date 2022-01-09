/**
 * @format
 */
const quotes = [
  "Guard against the impostures of pretended patriotism.",
  "Labor to keep alive in your breast that little spark of celestial fire called conscience.",
  "Perseverance and spirit have done wonders in all ages.",
  "The harder the conflict, the greater the triumph.",
  "Worry is the intrest paid by those who borrow trouble.",
  "Where are our Men of abilities? Why do they not come forth to save their Country?",
  "We must consult our means rather than our wishes.",
  "Real men despise battle, but will never run from it.",
];

function getRandomQuote() {
  let index = Math.floor(Math.random() * quotes.length);
  return quotes[index];
}

module.exports = {
  quotes,
  getRandomQuote,
};
