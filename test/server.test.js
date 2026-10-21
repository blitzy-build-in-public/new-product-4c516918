'use strict';

/*
 * Verification suite for the tutorial HTTP server (AAP 0.5.1 Component D).
 *
 * It exercises the real `server.js` the way a user runs it — spawned as a child process, never
 * imported — and asserts the functional, logging, configuration and shutdown gates the plan fixes
 * (AAP 0.8). Only what the runtime ships is used: `node:test` as the runner, `node:assert/strict`
 * for the assertions, `node:http` as the client (never the global fetch, which is experimental
 * across the runtime's 18.x line), `node:net` to find and hold ports, and `node:child_process` to
 * start the server. The three performance gates live in `scripts/benchmark.js` and are not
 * repeated here.
 *
 * Every case owns its port and its child process, and stops the child in a `finally` block, so a
 * failing assertion can never leave a server running.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

// --- Values fixed by the plan (AAP 0.3.3, 0.5.2, 0.8) ------------------------

// The response contracts, down to the byte: the content type carries no charset parameter and each
// body has a fixed byte length.
const CONTENT_TYPE_PLAIN = 'text/plain';
const HELLO_PATH = '/hello';
const HELLO_QUERY_PATH = '/hello?x=1';
const HELLO_BODY = 'Hello world';
const HELLO_BODY_LENGTH = 11;
const NOT_FOUND_BODY = 'Not Found';
const NOT_FOUND_BODY_LENGTH = 9;

// Paths that must fall through to the not-found contract: a name that is no route, the root, and a
// nested path. The defined path with a trailing slash is asserted as `HELLO_PATH + '/'`, which is
// not the defined path either.
const UNDEFINED_PATHS = ['/invalid', '/', '/anything/else'];

// Methods the route table holds no key for. A defined path reached with one of them takes the same
// 404 as an undefined path: the plan fixes 404 for that case and adds no 405 and no Allow header.
const UNMATCHED_HELLO_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

// Port configuration (AAP 0.5.2). The accepted range is inclusive at both ends; 1024 and 65535 are
// valid, 1023 and 65536 are not.
const DEFAULT_PORT = 3000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const ACCEPTED_PORT_BOUNDARIES = [MIN_PORT, MAX_PORT];

// An unset PORT, an empty one and a whitespace-only one are all "not configured" and take the
// default. `undefined` is passed to buildEnv, which deletes the variable rather than setting it.
const FALLBACK_PORT_VALUES = [undefined, '', '   '];

// Values that fail the digits-only test or exceed the range take the range message.
const RANGE_REJECTED_PORT_VALUES = ['abc', '3000.5', '-1', '70000'];

// Values that are a whole number of digits below 1024 — zero included, because port 0 is privileged
// and the server rejects it — take the privileged-port message.
const PRIVILEGED_PORT_VALUES = ['0', '80', '1023'];

// Message and line literals quoted from AAP 0.5.2, reproduced verbatim so the suite asserts exactly
// the text a user reads. Each one states an offending value, the accepted range and the correction,
// which is what makes it actionable.

// Triggered by a PORT that is not a whole number of digits in range: non-numeric, fractional,
// negative, or above 65535.
const invalidPortMessage = (portValue) =>
  `Invalid PORT "${portValue}": expected an integer between 1024 and 65535. Unset PORT to use the default 3000, or set it to a value in that range.`;

// Triggered by a PORT below 1024, zero included.
const privilegedPortMessage = (portValue) =>
  `Invalid PORT "${portValue}": ports below 1024 are privileged and cannot be used. Set PORT to a value between 1024 and 65535, or unset it to use the default 3000.`;

// Triggered when the bind fails because another process already holds the port (EADDRINUSE).
const portInUseMessage = (port) =>
  `Failed to start server: port ${port} is already in use. Stop the process already using port ${port}, or start this server with a different PORT.`;

// The line the server prints from inside its listen callback, so its appearance on stdout is proof
// the bind succeeded.
const STARTUP_LINE_PREFIX = 'Server listening on port ';
const startupLine = (port) => `${STARTUP_LINE_PREFIX}${port}`;

// The tail of the line the server prints when it receives SIGINT.
const SHUTDOWN_LINE_SUFFIX = ' Server shutting down';

// One request log line: an ISO-8601 timestamp, the method, then the request target as received.
const LOG_LINE_PATTERN =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] (GET|POST|HEAD|PUT|DELETE) \S+$/;

// The shutdown line, timestamp aside.
const SHUTDOWN_LINE_PATTERN =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Server shutting down$/;

// Bounds. The host is shared and may be loaded, so a server that never reports its startup line or
// never exits fails its own case with the child's collected output rather than hanging the runner.
const STARTUP_TIMEOUT_MS = 10000;
const LINE_POLL_INTERVAL_MS = 10;

// The two waits that follow a live server are bounded for the same reason, because the plan makes a
// server that is still listening after SIGINT, or that never answers, a failure of the shutdown and
// request gates: without a bound that failure would arrive as a run that never ends instead.
const SIGINT_EXIT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

// The probed port is unowned between the probe releasing it and the child binding it, and this host
// is shared with runs drawing from the same ephemeral pool, so that window can be lost to another
// process: a spawn that failed only because of the collision is retried with a fresh port instead of
// failing the case as a false negative.
const PROBED_PORT_ATTEMPTS = 3;

// The shutdown case waits for exactly three lines: the startup line, one request line, and the
// shutdown line.
const SHUTDOWN_CASE_LINE_COUNT = 3;

// --- Helpers ----------------------------------------------------------------

/*
 * Reserves a port from the operating system for one case. Input: none. Output: the port the system
 * assigned. That value is never the 0 the probe asked for, and only the assigned value may be
 * forwarded to the child: PORT=0 is below 1024 and the server rejects it as privileged.
 */
function probeFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/*
 * Builds a child's environment from this process's own. Input: the variables to override. Output:
 * the environment to spawn with. A key mapped to undefined is deleted rather than set, because
 * child_process stringifies every value it is given: { PORT: undefined } would hand the child the
 * literal string 'undefined' instead of leaving the variable unset.
 */
function buildEnv(overrides = {}) {
  const env = { ...process.env };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

/*
 * Splits a text stream into complete lines and hands each line to `onLine` as it arrives. Attached
 * the moment the child is spawned, because a line delivered before the listener exists is lost and
 * the startup line is the signal every case waits for.
 */
function splitLines(stream, onLine) {
  stream.setEncoding('utf8');

  let buffered = '';

  const emit = (line) => onLine(line.replace(/\r$/, ''));

  stream.on('data', (chunk) => {
    buffered += chunk;

    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      emit(buffered.slice(0, newlineIndex));
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  });

  // Whatever the stream ended with is still output, so a final line without a newline is emitted
  // too rather than dropped.
  stream.on('end', () => {
    if (buffered !== '') {
      emit(buffered);
      buffered = '';
    }
  });
}

/*
 * Renders everything a child wrote, for failure messages, so a failing case is diagnosable from its
 * output alone.
 */
function describeOutput(stdoutLines, stderrText) {
  return `stdout: ${JSON.stringify(stdoutLines)}\nstderr: ${JSON.stringify(stderrText)}`;
}

// --- Server lifecycle -------------------------------------------------------

/*
 * Spawns `server.js` on one exact port and resolves once the child reports that port on stdout.
 * Inputs: the environment to run it with and the port it is expected to bind. Output:
 * { child, port, stdoutLines, stderrText, stop }. The line and error collections stay live for the
 * life of the child, so a case reads the whole of its output after stopping it.
 *
 * The child is spawned through process.execPath — the same command a user runs, independent of PATH
 * — with the checkout root as its working directory, and the startup line is awaited so no request
 * can be sent before the bind completed.
 */
async function spawnListeningServer(env, expectedPort) {
  const expectedStartupLine = startupLine(expectedPort);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const server = {
    child,
    port: expectedPort,
    stdoutLines: [],
    stderrText: '',
    stop: () => stopServer(server),
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    server.stderrText += chunk;
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The child is killed before the case fails: a server that never reported its port must not
      // be left running on the host.
      child.kill('SIGKILL');
      reject(
        new Error(
          `The server did not print "${expectedStartupLine}" within ${STARTUP_TIMEOUT_MS} ms.\n${describeOutput(server.stdoutLines, server.stderrText)}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    const rejectOnEarlyExit = (code, signal) => {
      clearTimeout(timer);

      const error = new Error(
        `The server exited before printing "${expectedStartupLine}" (code ${code}, signal ${signal}).\n${describeOutput(server.stdoutLines, server.stderrText)}`,
      );

      // Carried as a flag rather than re-parsed from stderr at the call site: losing the port to
      // another process is the one early exit a caller may retry, and the child's own message is
      // what identifies it. 'close' fires once both pipes are drained, so the text is complete here.
      error.portInUse = server.stderrText.includes(portInUseMessage(expectedPort));

      reject(error);
    };

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', rejectOnEarlyExit);

    splitLines(child.stdout, (line) => {
      server.stdoutLines.push(line);

      if (line === expectedStartupLine) {
        clearTimeout(timer);
        child.removeListener('close', rejectOnEarlyExit);
        resolve();
      }
    });
  });

  return server;
}

/*
 * Starts the server on a port the operating system chooses, for the cases that only need a working
 * server. Output: the object spawnListeningServer returns, carrying the port it bound.
 *
 * The port can be taken by another process in the window between the probe releasing it and the
 * child binding it, which on a shared host is a false negative rather than a defect, so a spawn
 * whose failure was that collision is retried with a fresh port, up to PROBED_PORT_ATTEMPTS times.
 * Anything else is reported at once, and the last attempt's error is thrown when every attempt
 * collided, so the case still fails with the child's own EADDRINUSE diagnostic. The fixed ports the
 * plan names are never re-probed: only a port the operating system assigned is replaced.
 */
async function startServer() {
  let lastError = null;

  for (let attempt = 0; attempt < PROBED_PORT_ATTEMPTS; attempt += 1) {
    const port = await probeFreePort();

    try {
      return await spawnListeningServer(buildEnv({ PORT: String(port) }), port);
    } catch (error) {
      if (error.portInUse !== true) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

/*
 * Sends SIGINT to a server child and resolves with the status it exited with. Input: the server
 * object spawnListeningServer returned, whose child is the process to stop. Output: { code, signal }.
 * The close listener is attached before the signal is sent, because a fast exit nobody is listening
 * for would leave the case waiting forever; a child that has already exited resolves immediately for
 * the same reason.
 *
 * It settles on 'close' rather than 'exit' so the pipes are fully drained before a case reads the
 * child's stderr: stdout and stderr are separate streams, so a diagnostic written beside the startup
 * line can still be in flight when 'exit' fires, and a teardown resolving there would hand the case
 * an incomplete stderrText. Same reasoning as spawnExpectingExit, which settles on 'close' for
 * exactly this reason.
 *
 * The wait is bounded, because the plan makes a server still listening after SIGINT a failure of the
 * shutdown gate: unbounded, that failure would arrive as a run that never ends rather than as the
 * failing case it is. The child is killed at the bound and reported with its own output, whether it
 * was still running or had exited without its pipes closing.
 */
function stopServer(server) {
  const { child } = server;

  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    const timer = setTimeout(() => {
      // 'close' has not fired by the bound, which is either a child that is still running or one
      // that exited without its output pipes closing: the message names which, so the failure stays
      // actionable instead of reporting a stopped process as a running server.
      const reason =
        child.exitCode === null && child.signalCode === null
          ? `was still running ${SIGINT_EXIT_TIMEOUT_MS} ms after SIGINT`
          : `exited without closing its output pipes within ${SIGINT_EXIT_TIMEOUT_MS} ms of SIGINT`;

      // The child is killed before the case fails: a server that ignores SIGINT must not be left
      // running on the host.
      child.kill('SIGKILL');
      reject(
        new Error(
          `The server ${reason}.\n${describeOutput(server.stdoutLines, server.stderrText)}`,
        ),
      );
    }, SIGINT_EXIT_TIMEOUT_MS);

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill('SIGINT');
  });
}

/*
 * Stops a server and asserts the clean SIGINT teardown the plan specifies: exit status 0 and no
 * signal death. Every case that starts a server tears it down through this, so a failing assertion
 * still stops the child and a teardown that misbehaves is reported as a failure of its own.
 */
async function stopAndAssertCleanExit(server) {
  const { code, signal } = await server.stop();

  assert.strictEqual(
    code,
    0,
    `expected SIGINT to exit with status 0, saw code ${code} and signal ${signal}.\n${describeOutput(server.stdoutLines, server.stderrText)}`,
  );
  assert.strictEqual(
    signal,
    null,
    `expected a clean exit rather than a signal death, saw signal ${signal}.\n${describeOutput(server.stdoutLines, server.stderrText)}`,
  );
}

/*
 * Ends one sub-case and reports whatever went wrong in it. Inputs: the server the case started (null
 * when it failed before a server existed) and the error the case's own body raised (null when the
 * body passed). Output: none when the body passed and the child was stopped cleanly; otherwise it
 * throws.
 *
 * The body's own error stays the reported cause even when the teardown assertion then fails too,
 * because the failure the case was written to catch — a wrong status, a wrong body, a missing
 * startup line — is the one whose diagnosis a reader needs. A teardown error thrown over it would
 * discard that failure and point the run at the wrong place, so the case's error object is kept as
 * it is, with the teardown failure appended to its message and attached as `teardownError`, and its
 * stack still ending at the assertion that failed first.
 */
async function finishSubCase(server, caseError) {
  let teardownError = null;

  if (server !== null) {
    try {
      await stopAndAssertCleanExit(server);
    } catch (error) {
      teardownError = error;
    }
  }

  if (caseError === null) {
    if (teardownError !== null) {
      throw teardownError;
    }

    return;
  }

  if (teardownError !== null) {
    caseError.message = `${caseError.message}\nAdditionally, the teardown failed: ${teardownError.message}`;
    caseError.teardownError = teardownError;
  }

  throw caseError;
}

/*
 * Issues one HTTP request against the server and resolves with its status, headers and body.
 * Inputs: the port, the method and the request target. Each request opens its own connection and
 * drains its response, so no keep-alive socket outlives a case and the client never interferes with
 * the server's shutdown.
 *
 * Waiting for the response is bounded, because a server that accepts the connection but never
 * answers would otherwise leave this promise unsettled and hang the whole run rather than fail its
 * case: on expiry the request is destroyed and the case fails naming the request that went
 * unanswered.
 */
function request(port, method, path) {
  return new Promise((resolve, reject) => {
    // Assigned once the request exists: both settling arms clear it, and the expiry arm needs the
    // request itself in order to destroy it.
    let timer = null;

    const clientRequest = http.request(
      { host: '127.0.0.1', port, method, path, agent: false },
      (res) => {
        res.setEncoding('utf8');

        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      },
    );

    timer = setTimeout(() => {
      clientRequest.destroy();
      reject(
        new Error(
          `No response to ${method} ${path} on port ${port} within ${REQUEST_TIMEOUT_MS} ms.`,
        ),
      );
    }, REQUEST_TIMEOUT_MS);

    clientRequest.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    clientRequest.end();
  });
}

/*
 * Asserts the not-found contract on one response: status, content type, byte length and body. The
 * body is compared byte-exactly, which is what proves that no internal detail — no path list, no
 * stack trace, no error text — is ever exposed.
 */
function assertNotFoundResponse(response) {
  assert.strictEqual(response.statusCode, 404);
  assert.strictEqual(response.headers['content-type'], CONTENT_TYPE_PLAIN);
  assert.strictEqual(response.headers['content-length'], String(NOT_FOUND_BODY_LENGTH));
  assert.strictEqual(response.body, NOT_FOUND_BODY);
}

/*
 * Spawns `server.js` with an environment that must make it stop, and resolves with the status it
 * exited with plus everything it wrote. Input: the environment overrides. Used for the
 * configuration and bind failures, which must report their message and end instead of serving.
 *
 * The promise settles on 'close' rather than 'exit' so the pipes are fully drained and the exact
 * stderr text can be asserted, and a child still alive when the bound expires is killed and
 * reported, so a rejected configuration that wrongly starts a server never leaks a process.
 */
function spawnExpectingExit(envOverrides) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: buildEnv(envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  let stderrText = '';

  splitLines(child.stdout, (line) => stdoutLines.push(line));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `The server did not exit within ${STARTUP_TIMEOUT_MS} ms.\n${describeOutput(stdoutLines, stderrText)}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdoutLines, stderrText });
    });
  });
}

/*
 * Holds one free port from inside this process so the next bind on it fails, which is the
 * EADDRINUSE gate. Output: the port and a release() that closes the holder. The holder binds
 * exactly the way the server does — no host, so the wildcard address — because that is what makes
 * the collision certain.
 */
async function occupyPort() {
  const port = await probeFreePort();
  const holder = net.createServer();

  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(port, resolve);
  });

  return {
    port,
    release: () => new Promise((resolve) => holder.close(() => resolve())),
  };
}

/*
 * Resolves once the server has printed at least `expectedLineCount` lines on stdout. A request log
 * line is written by the child before it answers, but the pipe to this process is asynchronous, so
 * the line can still be in flight when the response has arrived — and the shutdown line is written
 * just before the child exits. The bound keeps a server that logs nothing from hanging the runner.
 */
function waitForLineCount(server, expectedLineCount) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const poll = setInterval(() => {
      if (server.stdoutLines.length >= expectedLineCount) {
        clearInterval(poll);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= STARTUP_TIMEOUT_MS) {
        clearInterval(poll);
        reject(
          new Error(
            `Expected ${expectedLineCount} lines on stdout within ${STARTUP_TIMEOUT_MS} ms, saw ${server.stdoutLines.length}.\n${describeOutput(server.stdoutLines, server.stderrText)}`,
          ),
        );
      }
    }, LINE_POLL_INTERVAL_MS);
  });
}

// --- The suite --------------------------------------------------------------

/*
 * One parent case with one sub-case per plan gate, awaited so the sub-cases run in order: each owns
 * its own port and its own child process, so one failure cannot disturb the next.
 */
test('server.js HTTP contract and process gates', async (t) => {
  await t.test('GET /hello answers 200 with the hello contract', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      const response = await request(server.port, 'GET', HELLO_PATH);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.headers['content-type'], CONTENT_TYPE_PLAIN);
      assert.strictEqual(response.headers['content-length'], String(HELLO_BODY_LENGTH));
      assert.strictEqual(response.body, HELLO_BODY);
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('a query string does not defeat the hello match', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      const response = await request(server.port, 'GET', HELLO_QUERY_PATH);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.headers['content-type'], CONTENT_TYPE_PLAIN);
      assert.strictEqual(response.headers['content-length'], String(HELLO_BODY_LENGTH));
      assert.strictEqual(response.body, HELLO_BODY);
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('an undefined path answers the not-found contract', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      for (const path of UNDEFINED_PATHS) {
        assertNotFoundResponse(await request(server.port, 'GET', path));
      }
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('a defined path reached with another method answers the not-found contract', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      for (const method of UNMATCHED_HELLO_METHODS) {
        const response = await request(server.port, method, HELLO_PATH);

        assertNotFoundResponse(response);
        // The plan fixes 404 for a defined path reached with the wrong method, so there is no 405
        // and no Allow header to answer with.
        assert.strictEqual(response.headers.allow, undefined);
      }
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('HEAD /hello answers the 404 headers with no body at all', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      const response = await request(server.port, 'HEAD', HELLO_PATH);

      assert.strictEqual(response.statusCode, 404);
      assert.strictEqual(response.headers['content-type'], CONTENT_TYPE_PLAIN);
      assert.strictEqual(response.headers['content-length'], String(NOT_FOUND_BODY_LENGTH));
      // A HEAD response carries the headers of the matching GET and no body, so the server ending
      // the response with the not-found body is correct while zero bytes reach the client.
      assert.strictEqual(response.body, '');
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('a trailing slash is not the defined path', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      assertNotFoundResponse(await request(server.port, 'GET', HELLO_PATH + '/'));
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('every request is logged in the fixed format before routing', async () => {
    // Matched and unmatched requests alike: the 404s are what prove the line is written before the
    // route lookup, because no route matched them.
    const issuedRequests = [
      ['GET', HELLO_PATH],
      ['GET', HELLO_QUERY_PATH],
      ['GET', UNDEFINED_PATHS[0]],
      ['POST', HELLO_PATH],
      ['PUT', HELLO_PATH],
      ['DELETE', HELLO_PATH],
      ['HEAD', HELLO_PATH],
    ];

    // The child's stdout is the startup line followed by exactly one line per request, so a count
    // that matches is itself the proof that nothing was logged twice and nothing was logged not at
    // all.
    const expectedLineCount = issuedRequests.length + 1;

    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      for (const [method, path] of issuedRequests) {
        await request(server.port, method, path);
      }

      await waitForLineCount(server, expectedLineCount);

      assert.strictEqual(server.stdoutLines.length, expectedLineCount);
      assert.strictEqual(server.stdoutLines[0], startupLine(server.port));

      const logLines = server.stdoutLines.slice(1);

      issuedRequests.forEach(([method, path], index) => {
        const logLine = logLines[index];

        assert.match(logLine, LOG_LINE_PATTERN);
        // The target is logged exactly as received, so the query string appears in the line even
        // though the router matched on the parsed pathname.
        assert.ok(
          logLine.endsWith(` ${method} ${path}`),
          `log line ${index} was ${JSON.stringify(logLine)}`,
        );
      });
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('a configured PORT is honoured and reported on stdout', async () => {
    let server = null;
    let caseError = null;

    try {
      server = await startServer();

      // startServer only resolves once this line was printed, so its presence means the bind had
      // completed before the first request was sent — and that nothing went to stderr.
      assert.deepStrictEqual(server.stdoutLines, [startupLine(server.port)]);
      assert.strictEqual(server.stderrText, '');
      // The value the operating system handed the probe is the value the server bound; a port the
      // server would have rejected as privileged can never be forwarded to it.
      assert.ok(
        server.port >= MIN_PORT && server.port <= MAX_PORT,
        `expected a port in ${MIN_PORT}-${MAX_PORT}, saw ${server.port}`,
      );

      const response = await request(server.port, 'GET', HELLO_PATH);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body, HELLO_BODY);
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      await finishSubCase(server, caseError);
    }
  });

  await t.test('the inclusive port boundaries 1024 and 65535 are accepted', async () => {
    for (const boundaryPort of ACCEPTED_PORT_BOUNDARIES) {
      let server = null;
      let caseError = null;

      try {
        server = await spawnListeningServer(
          buildEnv({ PORT: String(boundaryPort) }),
          boundaryPort,
        );

        assert.deepStrictEqual(
          server.stdoutLines,
          [startupLine(boundaryPort)],
          `expected the startup line for PORT=${boundaryPort}`,
        );
        assert.strictEqual(server.stderrText, '');
      } catch (error) {
        // Held for the teardown below: the case's own failure must stay the reported cause.
        caseError = error;
      } finally {
        await finishSubCase(server, caseError);
      }
    }
  });

  await t.test('an unset, empty or whitespace-only PORT falls back to the default 3000', async () => {
    for (const rawPortValue of FALLBACK_PORT_VALUES) {
      let server = null;
      let caseError = null;

      try {
        server = await spawnListeningServer(buildEnv({ PORT: rawPortValue }), DEFAULT_PORT);

        assert.deepStrictEqual(
          server.stdoutLines,
          [startupLine(DEFAULT_PORT)],
          `expected the default port for PORT=${JSON.stringify(rawPortValue)}`,
        );
        // The default-port gate fixes the startup line and nothing on stderr, so the second half of
        // the row is asserted here as it is in the configured-PORT and boundary cases: a regression
        // that printed a diagnostic while still printing the startup line would otherwise pass.
        assert.strictEqual(
          server.stderrText,
          '',
          `expected no stderr for PORT=${JSON.stringify(rawPortValue)}`,
        );
      } catch (error) {
        // Held for the teardown below: the case's own failure must stay the reported cause.
        caseError = error;
      } finally {
        await finishSubCase(server, caseError);
      }

      // The row is checked twice on purpose. The arm inside the loop is the counterpart the sibling
      // cases carry, evaluated as soon as the startup line arrives on stdout; this one runs after
      // finishSubCase returned, so the child has exited and both pipes are closed and its stderr is
      // complete. Stdout and stderr are delivered as separate events, so a diagnostic written in
      // the same tick as the startup line can still be in flight when the arm above is evaluated:
      // this one is what makes such a regression fail the case. Reaching here means the body passed
      // and the child was stopped cleanly, so the server object always exists.
      assert.strictEqual(
        server.stderrText,
        '',
        `expected no stderr for PORT=${JSON.stringify(rawPortValue)}`,
      );
    }
  });

  await t.test('a non-numeric, fractional, negative or out-of-range PORT is rejected', async () => {
    for (const portValue of RANGE_REJECTED_PORT_VALUES) {
      const result = await spawnExpectingExit({ PORT: portValue });

      // Nothing on stdout: the value was refused before any server existed, so no bind was
      // attempted and no startup line can appear.
      assert.deepStrictEqual(result.stdoutLines, []);
      assert.strictEqual(result.code, 1, `PORT=${portValue} exited with code ${result.code}`);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.stderrText, `${invalidPortMessage(portValue)}\n`);
    }
  });

  await t.test('a privileged PORT is rejected as privileged', async () => {
    for (const portValue of PRIVILEGED_PORT_VALUES) {
      const result = await spawnExpectingExit({ PORT: portValue });

      assert.deepStrictEqual(result.stdoutLines, []);
      assert.strictEqual(result.code, 1, `PORT=${portValue} exited with code ${result.code}`);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.stderrText, `${privilegedPortMessage(portValue)}\n`);
    }
  });

  await t.test('a port already in use is reported actionably', async () => {
    const holder = await occupyPort();

    try {
      const result = await spawnExpectingExit({ PORT: String(holder.port) });

      // The server registers its 'error' handler before it calls listen(), so a failed bind is
      // reported with this message rather than crashing on an emitter error nobody handles.
      assert.deepStrictEqual(result.stdoutLines, []);
      assert.strictEqual(result.code, 1);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.stderrText, `${portInUseMessage(holder.port)}\n`);
    } finally {
      await holder.release();
    }
  });

  await t.test('SIGINT shuts the server down cleanly with status 0', async () => {
    let server = null;
    let exitStatus = null;
    let caseError = null;

    try {
      server = await startServer();
      await request(server.port, 'GET', HELLO_PATH);

      // stop() attaches its close listener before it sends the signal, so a fast exit is not missed.
      exitStatus = await server.stop();

      // The shutdown line is written by the child just before it exits and the pipe to this process
      // is asynchronous, so the line is awaited rather than assumed.
      await waitForLineCount(server, SHUTDOWN_CASE_LINE_COUNT);

      assert.strictEqual(exitStatus.code, 0);
      assert.strictEqual(exitStatus.signal, null);
      assert.strictEqual(server.stdoutLines.length, SHUTDOWN_CASE_LINE_COUNT);
      assert.strictEqual(server.stdoutLines[0], startupLine(server.port));

      const shutdownLines = server.stdoutLines.filter((line) =>
        line.endsWith(SHUTDOWN_LINE_SUFFIX),
      );

      assert.strictEqual(shutdownLines.length, 1);
      assert.match(shutdownLines[0], SHUTDOWN_LINE_PATTERN);
    } catch (error) {
      // Held for the teardown below: the case's own failure must stay the reported cause.
      caseError = error;
    } finally {
      // Already stopped on the happy path, where stop() resolves from the status it recorded; this
      // tears the child down if the case failed before that point, and reports the case's own
      // failure either way.
      if (server !== null && exitStatus === null) {
        await finishSubCase(server, caseError);
      } else if (caseError !== null) {
        throw caseError;
      }
    }
  });
});

