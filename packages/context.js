const time = require('./time')

let currentLocation = process.env.CURRENT_LOCATION || 'Gurugram, Haryana, India'

function setLocation(loc) { currentLocation = loc }
function getLocation() { return currentLocation }

function liveContextBlock() {
  return `=== LIVE CONTEXT (ground truth — trust this over your own assumptions) ===
    Current date & time: ${time.nowForPrompt()}
    Current location: ${getLocation()}`
}

module.exports = { setLocation, getLocation, liveContextBlock }