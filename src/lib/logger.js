const util = require('util');

function timestamp() {
  return new Date().toISOString();
}

function format(level, args) {
  const msg = args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 3 }))).join(' ');
  return `${timestamp()} [${process.pid}] ${level.toUpperCase()} - ${msg}`;
}

function info(...args) {
  console.log(format('info', args));
}

function warn(...args) {
  console.warn(format('warn', args));
}

function error(...args) {
  console.error(format('error', args));
}

function debug(...args) {
  if (process.env.DEBUG) console.debug(format('debug', args));
}

module.exports = { info, warn, error, debug };
