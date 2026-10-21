'use strict';

/*
 * Performance measurement harness for the tutorial server, run by `npm run bench`.
 *
 * It launches the real `server.js` as a child process and measures the three performance gates
 * the project defines, using only primitives the runtime itself ships:
 *   1. `GET /hello` answers within 10 ms at the median, over 200 requests each on a fresh
 *      connection.
 *   2. 100 requests in flight at once are all answered 200 with the body `Hello world`.
 *   3. The server's resident set grows by less than 5 MB across 5,000 requests.
 *
 * The process under test is the one a user starts by hand, never an in-process copy of the
 * application, so what is measured is what ships. The exit status is 0 only when all three gates
 * pass, and 1 when any gate fails or cannot be measured, so a failed gate halts whatever runs it.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

// --- Fixed values -----------------------------------------------------------

// The application is started as `node server.js` from the project root: the same runtime binary
// that runs this harness, against the same file a user runs.
const SERVER_ENTRY_PATH = __dirname + '/../server.js';
const SERVER_WORKING_DIRECTORY = __dirname + '/..';

// The server binds every interface and the harness only ever connects over loopback.
const SERVER_HOST = '127.0.0.1';

// Contract 1 of the server: GET /hello answers 200 with exactly this body.
const HELLO_PATH = '/hello';
const EXPECTED_HELLO_STATUS = 200;
const EXPECTED_HELLO_BODY = 'Hello world';

// The startup confirmation, printed on stdout from inside the listen callback. No request is
// issued before this line appears, so nothing is measured against a server that is not listening.
const STARTUP_LINE_PREFIX = 'Server listening on port';

// --- Gate thresholds and sample counts --------------------------------------

const LATENCY_SAMPLE_COUNT = 200;
const LATENCY_GATE_MS = 10;

const CONCURRENCY_REQUEST_COUNT = 100;
// Printed target for the concurrent batch: informational only, never asserted, because a loaded
// host legitimately takes longer without that meaning the event loop blocked.
const CONCURRENCY_INFORMATIONAL_WALL_CLOCK_MS = 1000;

const MEMORY_WARMUP_REQUEST_COUNT = 200;
const MEMORY_SAMPLE_REQUEST_COUNT = 5000;
const MEMORY_GROWTH_GATE_BYTES = 5 * 1024 * 1024;

// --- Timeouts that protect the harness itself -------------------------------

// Harness safety, not a gate: a stalled response must not hang the run forever.
const REQUEST_SAFETY_TIMEOUT_MS = 10000;
// Harness safety, not a gate: a server that ignores SIGINT is killed so cleanup always completes.
const CLEANUP_TIMEOUT_MS = 5000;

// --- Starting the server under test -----------------------------------------

/*
 * Asks the kernel for an unused port and releases it, so the child can be handed a port nothing
 * else holds. The literal 0 used to ask for the ephemeral port must never be forwarded to the
 * child: the application rejects any PORT below 1024. Input: none. Output: the released port.
 */
function probeFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      reject(new Error(`Could not probe a free port: ${error.message}`));
    });

    probe.listen(0, SERVER_HOST, () => {
      const { port } = probe.address();

      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/*
 * Starts the real application as a child process and waits for it to confirm the bind. Input: the
 * port to configure it with. Output: the child, the stdout lines captured so far, a reader for its
 * stderr and a promise that resolves on the startup line. Rejection carries the child's stderr, so
 * a server that fails to start is diagnosable instead of merely absent.
 */
function spawnServer(port) {
  const child = childProcess.spawn(process.execPath, [SERVER_ENTRY_PATH], {
    cwd: SERVER_WORKING_DIRECTORY,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const stderrChunks = [];

  const stderrText = () => stderrChunks.join('').trim();

  const waitForStartup = new Promise((resolve, reject) => {
    let settled = false;
    let stdoutRemainder = '';

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      // Data arrives in chunks of arbitrary size, so lines are reassembled before they are
      // inspected: a chunk boundary can fall in the middle of the startup line.
      const text = stdoutRemainder + chunk;
      const lines = text.split('\n');
      stdoutRemainder = lines.pop();

      for (const line of lines) {
        const captured = line.trim();
        stdoutLines.push(captured);

        if (captured.startsWith(STARTUP_LINE_PREFIX)) {
          settle(resolve, captured);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    child.once('error', (error) => {
      settle(reject, new Error(`Could not start ${SERVER_ENTRY_PATH}: ${error.message}`));
    });

    // A child that dies before confirming the bind can never serve a request, so the wait fails
    // here with its diagnostics rather than at the first request with a bare connection error.
    child.once('exit', (code, signal) => {
      settle(
        reject,
        new Error(
          `Server exited before printing its startup line (code ${code}, signal ${signal}). stderr: ${stderrText() || '(empty)'}`
        )
      );
    });
  });

  return { child, stdoutLines, stderrText, waitForStartup };
}

/*
 * Stops the child and resolves once it is gone. Cleanup rather than a gate: the SIGINT exit-status
 * gate belongs to the functional suite, so the observed status is reported by the caller and never
 * asserted here. A child that ignores SIGINT is escalated to SIGKILL, which keeps the harness from
 * ever waiting on it indefinitely.
 */
function shutdownChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    let escalation = null;
    let reported = false;

    const report = (code, signal) => {
      if (reported) {
        return;
      }
      reported = true;

      if (escalation !== null) {
        clearTimeout(escalation);
      }

      resolve({ code, signal });
    };

    child.once('exit', (code, signal) => report(code, signal));

    escalation = setTimeout(() => {
      child.kill('SIGKILL');
    }, CLEANUP_TIMEOUT_MS);

    child.kill('SIGINT');
  });
}

// --- Driving the server -----------------------------------------------------

/*
 * Issues one `GET /hello` and resolves with the status code and the body it received. Every
 * request opens a connection of its own, which is both the cold-connection shape the latency gate
 * is defined on and the shape the tutorial's own `curl` workflow produces.
 */
function requestHello(port) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: SERVER_HOST,
        port,
        path: HELLO_PATH,
        method: 'GET',
        agent: false,
        headers: { Connection: 'close' },
      },
      (response) => {
        const statusCode = response.statusCode;
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ statusCode, body });
        });
      }
    );

    request.setTimeout(REQUEST_SAFETY_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Request to ${HELLO_PATH} gave no response within ${REQUEST_SAFETY_TIMEOUT_MS} ms`)
      );
    });

    request.on('error', reject);
    request.end();
  });
}

/*
 * Issues `count` sequential `GET /hello` requests and discards the responses. Inputs: the port and
 * the count. Used for the memory batches, whose interest is the server's allocation behaviour
 * across many requests rather than each response, and which stay sequential so that gate depends
 * on neither the latency gate nor the concurrency gate.
 */
async function issueSequentialRequests(port, count) {
  for (let issued = 0; issued < count; issued += 1) {
    await requestHello(port);
  }
}

/*
 * Measures the cold-connection round trip of `count` sequential `GET /hello` requests. The clock
 * runs from just before a request is issued until its response ends, so each sample covers
 * connection setup as well as the server's own work. Output: one sample in milliseconds per
 * request, none skipped.
 */
async function measureSequentialLatencyMs(port, count) {
  const samples = [];

  for (let issued = 0; issued < count; issued += 1) {
    const startNs = process.hrtime.bigint();

    await requestHello(port);

    samples.push(Number(process.hrtime.bigint() - startNs) / 1e6);
  }

  return samples;
}

/*
 * Issues `count` `GET /hello` requests simultaneously against the one server. Each outcome is
 * mapped to its own result or error, so a single failure cannot hide the others, and one clock
 * spans the batch to give its wall clock. Output: the status codes, the bodies, the failures
 * recorded and the wall clock in milliseconds.
 */
async function runConcurrentBatch(port, count) {
  const startNs = process.hrtime.bigint();

  const outcomes = await Promise.all(
    Array.from({ length: count }, () =>
      requestHello(port).then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error })
      )
    )
  );

  const wallClockMs = Number(process.hrtime.bigint() - startNs) / 1e6;

  const statusCodes = [];
  const bodies = [];
  const failures = [];

  for (const outcome of outcomes) {
    if (outcome.error) {
      failures.push(outcome.error.message);
      continue;
    }

    statusCodes.push(outcome.response.statusCode);
    bodies.push(outcome.response.body);
  }

  return { statusCodes, bodies, failures, wallClockMs };
}

// --- Reading the measurements -----------------------------------------------

// The middle sample of the sorted set: the latency gate is defined on the median, which a heavy
// host can move far less than a maximum.
function medianOf(samples) {
  if (samples.length === 0) {
    throw new Error('medianOf requires at least one sample');
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// The nearest-rank sample at the given percentile, sorted ascending first. Printed alongside the
// median for information; only the median decides the latency gate.
function percentileOf(samples, percentile) {
  if (samples.length === 0) {
    throw new Error('percentileOf requires at least one sample');
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(nearestRank - 1, 0), sorted.length - 1);

  return sorted[index];
}

/*
 * Reads the resident set of another process, which is how the memory gate observes a server the
 * harness only ever sees from outside. Input: the child's pid. Output: its VmRSS in bytes, or null
 * when the value cannot be read — /proc is absent on some platforms, and a status file it cannot
 * produce has no VmRSS line to parse.
 */
function readResidentSetBytes(pid) {
  let statusText;

  try {
    statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const match = statusText.match(/VmRSS:\s+(\d+)\s+kB/);

  return match === null ? null : Number(match[1]) * 1024;
}

// --- Reporting --------------------------------------------------------------

// Prints one gate's name, its measured numbers and its verdict, and returns the verdict so the
// caller can carry it into the summary and the exit status.
function reportGate(name, passed, detail) {
  console.log(`\n${name}`);
  console.log(`  ${detail}`);
  console.log(`  ${passed ? 'PASS' : 'FAIL'}`);

  return passed;
}

// --- Entry point ------------------------------------------------------------

/*
 * Runs the three gates against one child process and returns the process status: 0 when all three
 * pass, 1 when any fails or cannot be measured. A failed gate sets the status but does not stop the
 * run, so one execution reports all three. Every gate runs inside a try whose finally stops the
 * child, so no failure can leave a server process behind.
 */
async function main() {
  const port = await probeFreePort();
  const server = await spawnServer(port);
  const gateResults = [];

  try {
    await server.waitForStartup;

    const latencySamples = await measureSequentialLatencyMs(port, LATENCY_SAMPLE_COUNT);
    const medianMs = medianOf(latencySamples);
    const p95Ms = percentileOf(latencySamples, 95);

    gateResults.push(
      reportGate(
        'Gate 1 - latency of GET /hello',
        medianMs < LATENCY_GATE_MS,
        `median ${medianMs.toFixed(3)} ms, p95 ${p95Ms.toFixed(3)} ms, max ${Math.max(...latencySamples).toFixed(3)} ms over ${LATENCY_SAMPLE_COUNT} requests on fresh connections (gate: median < ${LATENCY_GATE_MS} ms)`
      )
    );

    const batch = await runConcurrentBatch(port, CONCURRENCY_REQUEST_COUNT);
    const answeredResponses = batch.statusCodes.filter(
      (statusCode, index) =>
        statusCode === EXPECTED_HELLO_STATUS && batch.bodies[index] === EXPECTED_HELLO_BODY
    ).length;

    gateResults.push(
      reportGate(
        'Gate 2 - concurrent requests',
        batch.failures.length === 0 && answeredResponses === CONCURRENCY_REQUEST_COUNT,
        `${answeredResponses}/${CONCURRENCY_REQUEST_COUNT} responses were ${EXPECTED_HELLO_STATUS} with body "${EXPECTED_HELLO_BODY}", ${batch.failures.length} request errors, wall clock ${batch.wallClockMs.toFixed(1)} ms (target < ${CONCURRENCY_INFORMATIONAL_WALL_CLOCK_MS} ms, informational)`
      )
    );

    await issueSequentialRequests(port, MEMORY_WARMUP_REQUEST_COUNT);
    const residentBytesBefore = readResidentSetBytes(server.child.pid);

    await issueSequentialRequests(port, MEMORY_SAMPLE_REQUEST_COUNT);
    const residentBytesAfter = readResidentSetBytes(server.child.pid);

    if (residentBytesBefore === null || residentBytesAfter === null) {
      gateResults.push(
        reportGate(
          'Gate 3 - memory stability',
          false,
          `not measurable: /proc/${server.child.pid}/status is unavailable on this platform, so VmRSS could not be read`
        )
      );
    } else {
      const growthBytes = residentBytesAfter - residentBytesBefore;

      gateResults.push(
        reportGate(
          'Gate 3 - memory stability',
          growthBytes < MEMORY_GROWTH_GATE_BYTES,
          `${residentBytesBefore} bytes after ${MEMORY_WARMUP_REQUEST_COUNT} requests -> ${residentBytesAfter} bytes after ${MEMORY_SAMPLE_REQUEST_COUNT} requests, growth ${growthBytes} bytes (gate < ${MEMORY_GROWTH_GATE_BYTES} bytes)`
        )
      );
    }
  } finally {
    const exitStatus = await shutdownChild(server.child);

    console.log(
      `\nServer stopped with exit code ${exitStatus.code} (signal ${exitStatus.signal}) after ${server.stdoutLines.length} stdout lines.`
    );

    // The server logs to stdout only, so anything on stderr is worth showing before the summary.
    const serverStderr = server.stderrText();
    if (serverStderr !== '') {
      console.error(`Server stderr:\n${serverStderr}`);
    }
  }

  const passedGateCount = gateResults.filter((passed) => passed).length;
  console.log(`\n${passedGateCount}/${gateResults.length} performance gates passed`);

  process.exitCode = passedGateCount === gateResults.length ? 0 : 1;
}

// An unexpected failure of the harness itself, such as a port probe that cannot bind or a server
// that never starts, ends the run with status 1 and a message rather than a stack trace alone.
main().catch((error) => {
  console.error(`Performance harness failed: ${error.message}`);
  process.exitCode = 1;
});

