'use strict';

// Test-only POSIX supervisor double: it proves the runner's ready contract when
// a supervisor exits before writing any guard. It must stay alive briefly so the
// exit listener is attached before the process terminates.
//
// `HAFT_TEST_HANG=1` makes the same fixture model a supervisor stuck before its
// guard is ever published, which exercises bounded cleanup latency. Reusing one
// fixture matters because the runner caches the resolved supervisor runtime for
// the lifetime of the test worker.
if (process.env.HAFT_TEST_HANG === '1') {
  setInterval(() => undefined, 1000);
} else {
  setTimeout(() => process.exit(70), 100);
}
