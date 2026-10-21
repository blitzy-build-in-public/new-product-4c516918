'use strict';

/*
 * Minimal HTTP server tutorial: the complete application, built on the runtime's built-in `http`
 * module with no framework and no dependency.
 *
 * It answers exactly two contracts, both as plain text:
 *   GET /hello  -> 200 `Hello world`
 *   anything else, including any other method on /hello -> 404 `Not Found`
 *
 * Start it with `node server.js` (or `npm start`). It binds the port named by the PORT
 * environment variable, defaulting to 3000, and prints one line per request.
 */

const http = require('http');

// --- Fixed values -----------------------------------------------------------

const DEFAULT_PORT = 3000;

// Ports below 1024 are privileged, and 65535 is the highest value the port field can carry, so
// the accepted range is inclusive of both bounds and closed at each end.
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// PORT arrives from the environment as a string, so only digits are accepted: "abc", "3000.5",
// "-1" and "70000" are rejected with an actionable message rather than silently coerced.
const DIGITS_ONLY_PATTERN = /^\d+$/;

const CONTENT_TYPE_TEXT = 'text/plain';
const HELLO_BODY = 'Hello world';
const NOT_FOUND_BODY = 'Not Found';

// Used as the base for resolving a request target when the request carries no Host header, which
// is legal for HTTP/1.0. The value only has to be syntactically valid: the pathname is all the
// router reads from the result.
const DEFAULT_HOST_HEADER = 'localhost';

// A parsed URL pathname never contains a raw NUL byte, because the URL parser percent-encodes it.
// This value therefore cannot collide with a route key, making it a safe path for a request
// target the parser rejects.
const UNMATCHED_PATH_SENTINEL = '\u0000';

// --- Message and line formats -----------------------------------------------

// Triggered by a PORT value that is not a whole number of digits in range: non-numeric,
// fractional, negative, or above 65535.
const invalidPortMessage = (portValue) =>
  `Invalid PORT "${portValue}": expected an integer between 1024 and 65535. Unset PORT to use the default 3000, or set it to a value in that range.`;

// Triggered by a PORT value below 1024, zero included: those ports are privileged.
const privilegedPortMessage = (portValue) =>
  `Invalid PORT "${portValue}": ports below 1024 are privileged and cannot be used. Set PORT to a value between 1024 and 65535, or unset it to use the default 3000.`;

// Triggered when the bind fails because another process already holds the port (EADDRINUSE).
const portInUseMessage = (port) =>
  `Failed to start server: port ${port} is already in use. Stop the process already using port ${port}, or start this server with a different PORT.`;

// Triggered when the bind fails for lack of permission to hold the port (EACCES).
const permissionDeniedMessage = (port) =>
  `Failed to start server: permission denied while binding port ${port}. Choose a port between 1024 and 65535.`;

// Triggered by any other server error; the runtime's own text is the whole of the detail.
const bindFailureMessage = (error) => `Failed to start server: ${error.message}.`;

// Printed on stdout from inside the listen callback, so the line is proof the bind succeeded.
const startupMessage = (port) => `Server listening on port ${port}`;

// Printed on stdout at the start of the SIGINT sequence.
const shutdownMessage = () => `[${new Date().toISOString()}] Server shutting down`;

// --- Configuration errors ---------------------------------------------------

// Raised for a PORT value this server refuses to bind. The message is the actionable text the
// startup tail prints to stderr before the process ends with status 1.
class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// --- Configuration ----------------------------------------------------------

/*
 * Turns the raw PORT value into the port to bind, or throws a ConfigurationError carrying the
 * message to print. Input: the raw environment string, possibly undefined. Output: a number
 * between 1024 and 65535. Pure: it reads no global and writes nothing.
 */
function parsePort(rawValue) {
  const trimmedValue = typeof rawValue === 'string' ? rawValue.trim() : '';

  // An unset, empty or whitespace-only PORT is absent rather than invalid, so it takes the
  // default.
  if (trimmedValue === '') {
    return DEFAULT_PORT;
  }

  if (!DIGITS_ONLY_PATTERN.test(trimmedValue)) {
    throw new ConfigurationError(invalidPortMessage(rawValue));
  }

  const port = Number(trimmedValue);

  // Checked below the range as well as above it, because a privileged port is a distinct failure
  // with a distinct remedy.
  if (port < MIN_PORT) {
    throw new ConfigurationError(privilegedPortMessage(rawValue));
  }

  if (port > MAX_PORT) {
    throw new ConfigurationError(invalidPortMessage(rawValue));
  }

  return port;
}

// --- Request handling -------------------------------------------------------

/*
 * Derives the pathname the router matches on. Inputs: the raw request target and the Host header
 * used as the URL base. Output: a pathname string, or the sentinel when the target cannot be
 * parsed. Resolving against the WHATWG URL global rather than the deprecated url.parse() keeps
 * the query string out of the match and the parser's security caveats out of the server.
 */
function resolvePathname(rawUrl, hostHeader) {
  try {
    return new URL(rawUrl, `http://${hostHeader || DEFAULT_HOST_HEADER}`).pathname;
  } catch {
    // A target the URL parser rejects cannot name a defined route, so it resolves to a path no
    // route key can hold instead of throwing inside the request listener.
    return UNMATCHED_PATH_SENTINEL;
  }
}

/*
 * Writes the one line this server emits per request, before any routing decision is taken.
 * Input: the request. The target is logged exactly as received, so the line shows what the client
 * asked for even though the router matches on the parsed pathname instead.
 */
function logRequest(req) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
}

/*
 * The single response finalizer: every response this server sends is written here. Inputs: the
 * response, the status code and the body. It writes the status and both headers in one call and
 * ends the stream once, which is what keeps a request from ever writing a header after sending or
 * a body after end.
 */
function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': CONTENT_TYPE_TEXT,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Answers the one defined route: GET /hello, 200 with the hello body.
function handleHello(req, res) {
  sendText(res, 200, HELLO_BODY);
}

// The fallback for every request no route matched. It carries no detail about why the request was
// unmatched, so no path list, stack trace or internal error text can reach the client.
function handleNotFound(req, res) {
  sendText(res, 404, NOT_FOUND_BODY);
}

/*
 * The complete route table: each key is `${method} ${pathname}` mapped to the handler that
 * answers it. It encodes the two contracts this server keeps — `GET /hello` answers 200 with the
 * hello body, and every other request, including a defined path reached with a different method,
 * falls through to the 404 handler. The method is part of the key, so the table itself enforces
 * method matching. Adding a route is one key and one handler.
 */
const ROUTES = {
  'GET /hello': handleHello,
};

/*
 * The request listener registered on the server. Inputs: the request and the response. It logs
 * the request first, then resolves the pathname, then looks up `${method} ${pathname}` in the
 * route table and runs the matched handler, falling back to the 404 handler.
 */
function routeRequest(req, res) {
  logRequest(req);

  const pathname = resolvePathname(req.url, req.headers.host);
  const handler = ROUTES[`${req.method} ${pathname}`];

  if (handler) {
    handler(req, res);
    return;
  }

  handleNotFound(req, res);
}

// --- Process lifecycle ------------------------------------------------------

// The port this process is configured with, assigned once by the startup tail. It is held at
// module scope so the server's error handler can name the port in its messages while keeping its
// own signature.
let configuredPort = DEFAULT_PORT;

/*
 * Reports a server-level error and ends the process with status 1. Input: the error the server
 * emitted. Every message names the port and the remedy, and every one goes to stderr, so no
 * diagnostic reaches a response body.
 */
function handleServerError(error) {
  if (error.code === 'EADDRINUSE') {
    reportFatalMessageAndExit(portInUseMessage(configuredPort));
  } else if (error.code === 'EACCES') {
    reportFatalMessageAndExit(permissionDeniedMessage(configuredPort));
  } else {
    reportFatalMessageAndExit(bindFailureMessage(error));
  }
}

/*
 * Reports a fatal condition on stderr and ends the process with status 1. Input: the message to
 * print. The write is completed before the exit is requested, because process.exit() does not
 * wait for a pending stderr write: with stderr on a pipe under backpressure the message would
 * otherwise be dropped and the process would end silently, losing the only diagnostic there is.
 * The message is written as its own line, exactly as console.error writes it, so the output each
 * caller produced is unchanged.
 */
function reportFatalMessageAndExit(message) {
  process.stderr.write(`${message}\n`, () => {
    process.exit(1);
  });
}

/*
 * Registers the SIGINT handler for shutdown. Input: the server to close. The sequence writes the
 * shutdown line, stops accepting connections, releases idle keep-alive sockets, and exits with
 * status 0 from inside the close callback, so the process never ends while a response is still
 * being written.
 */
function registerShutdownHandlers(server) {
  process.on('SIGINT', () => {
    console.log(shutdownMessage());

    server.close(() => {
      process.exit(0);
    });

    // close() releases idle keep-alive sockets by itself only from v19.0.0 onwards. The call is
    // made when the runtime provides it, which covers the 18.2.0-18.19.x window where close()
    // alone would wait for a client that has nothing left to send.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });
}

/*
 * Creates the server, wires its lifecycle handlers and starts it listening. Input: the validated
 * port. No host is passed to listen(), so the runtime's default all-interface binding applies.
 */
function startServer(port) {
  const server = http.createServer(routeRequest);

  // Registered before listen(): an 'error' event with no listener is thrown by the emitter and
  // would replace the actionable message below with a stack trace.
  server.on('error', handleServerError);
  registerShutdownHandlers(server);

  server.listen(port, () => {
    console.log(startupMessage(port));
  });
}

// --- Process entry ----------------------------------------------------------

// Validate the configured port and start the server in one guarded sequence. A configuration
// failure reports its message on stderr and ends the process with status 1 without ever reaching
// startServer, so a rejected PORT ends the process before any server exists.
try {
  configuredPort = parsePort(process.env.PORT);
  startServer(configuredPort);
} catch (error) {
  reportFatalMessageAndExit(error.message);
}
