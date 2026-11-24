// When each agent.mjs command started and how long it took, for TICK_EVENTS_FILE.
// The other lines are written when a command returns, so one that hangs and is
// killed leaves nothing; its start line here has no end line.

import { appendFileSync } from 'node:fs';

/**
 * Append a line to `file` now and another as the process exits, however it
 * exits short of a signal. A copy of the tools that is handed the command
 * (origin/main's, or the same one after a pull) is the same command: the
 * environment says so, and it writes nothing.
 */
export function timeCommand(file, cmd, { env = process.env, proc = process } = {}) {
  if (!file || env.AGENT_COMMAND_ID) return;
  const started = Date.now();
  const id = `${proc.pid}-${started}`;
  env.AGENT_COMMAND_ID = id;
  const write = (line) => {
    try {
      appendFileSync(file, `${JSON.stringify({ v: 1, at: new Date().toISOString(), ...line })}\n`);
    } catch (e) {
      console.error(`events: ${e.message}`);
    }
  };
  write({ cmd: 'start', of: cmd, id });
  proc.on('exit', (rc) => write({ cmd: 'end', of: cmd, id, rc, seconds: (Date.now() - started) / 1000 }));
}
