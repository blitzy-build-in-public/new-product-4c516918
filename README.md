# nodejs-tutorial-hello-world

A minimal, dependency-free Node.js HTTP server built as a teaching reference. It uses only the
built-in `http` module and answers exactly two contracts: `GET /hello` returns `Hello world`, and
every other request returns `Not Found`. Run it, send one request, watch it succeed or be rejected,
and read the line it prints on the console.

## Prerequisites

- **Node.js v18.0.0 or later.** The `engines` field in `package.json` is `>=18.0.0`. That version is
  the compatibility floor this tutorial is written against, and an Active LTS release is preferable
  for anything beyond learning the tutorial.
- **`curl`**, which ships with most systems. It is used for the verification step below. Any HTTP
  client works just as well.

## Installation

Nothing beyond Node.js is required. There is no install step, no third-party dependency of any kind,
no `node_modules` directory and no lockfile.

## Running the server

Start it with Node directly:

```bash
node server.js
```

Or start it through the npm script, which runs the same single-file application:

```bash
npm start
```

Either way, once the port is bound the server prints:

```text
Server listening on port 3000
```

The process runs in the foreground and serves requests until you interrupt it.

## Testing the response

With the server running, send the one defined request:

```bash
curl http://localhost:3000/hello
```

```text
Hello world
```

The body carries no trailing newline, so the output ends without a line break. Add `-i` to see the
whole exchange, headers included:

```bash
curl -i http://localhost:3000/hello
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 11
Date: <written by the runtime>
Connection: keep-alive
Keep-Alive: timeout=5

Hello world
```

The application sets `Content-Type` and `Content-Length`. The runtime appends the `Date`,
`Connection` and `Keep-Alive` headers of its own.

Every other request is answered by the catch-all, so an undefined path returns the not-found body:

```bash
curl -i http://localhost:3000/invalid
```

```text
HTTP/1.1 404 Not Found
Content-Type: text/plain
Content-Length: 9
Date: <written by the runtime>
Connection: keep-alive
Keep-Alive: timeout=5

Not Found
```

The HTTP method is part of the match, so `GET /hello` is the only request that succeeds. A request
such as `POST /hello` takes the same `Not Found` answer, as does `GET /hello/` with a trailing
slash.

## Request logging

Every request writes one line to stdout before any routing decision is made, so matched and
unmatched requests are both logged. The format is an ISO-8601 timestamp in square brackets, the HTTP
method, and then the request target as received.

```text
2026-01-15T10:30:00.000Z GET /hello
```

The startup line, the request lines and the shutdown line are written to stdout. Configuration and
bind errors are written to stderr.

## Configuring the port

| Variable | Default | Valid values |
|----------|---------|--------------|
| `PORT` | `3000`, used when the variable is unset, empty or whitespace only | An integer from `1024` to `65535` inclusive |

Both bounds are valid: `1024` and `65535` are accepted, while `1023` and `65536` are not. Override
the default by setting the variable for the process:

```bash
PORT=8080 npm start
```

```text
Server listening on port 8080
```

A `PORT` value that is not an integer in that range stops the server before it binds: the message is
written to stderr and the process exits with status 1. A value that is not a whole number in range
reports:

```text
Invalid PORT "abc": expected an integer between 1024 and 65535. Unset PORT to use the default 3000, or set it to a value in that range.
```

A value below `1024` reports:

```text
Invalid PORT "80": ports below 1024 are privileged and cannot be used. Set PORT to a value between 1024 and 65535, or unset it to use the default 3000.
```

## Shutting down

Press `CTRL+C` in the terminal running the server. It logs one line and stops:

```text
2026-01-15T10:30:00.000Z Server shutting down
```

The process exits with status 0, so the next shell prompt is reached cleanly.

## Project layout

```text
project-root/
├── server.js            # The whole HTTP server
├── package.json         # Project metadata and the start, test and bench scripts
├── README.md            # This file
├── test/
│   └── server.test.js   # Verification suite for the functional, logging, configuration and shutdown gates
└── scripts/
    └── benchmark.js     # Performance measurement harness for the latency, concurrency and memory gates
```

The two verification commands, both runnable from the project root:

```bash
npm test
```

Runs the `node:test` suite that covers the functional, logging, configuration and shutdown gates.

```bash
npm run bench
```

Runs the built-in-only harness that measures the latency, concurrency and memory gates.
