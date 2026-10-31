# Space Chat

As of 2026-10-07. Implementation: [chat.ts](../../agent/examples/chat.ts).

Three conversations alice → bob → carol communicate through Msg entries
`{room, from, to, n, text}`. The host creates one notify template per recipient by room and to.
Entries remain in the Space as history. Scripted answers are deterministic; in live mode,
content quality, the exact number of rounds and model conformance are not guaranteed properties.

`runChat` can be imported without side effects and is configurable with maxTurns/timeoutMs.
The CLI uses nine steps scripted, six live. The host waits for the message count or the deadline,
cancels subscriptions, stops delivery and aborts remaining conversation work instead of waiting for idle indefinitely.
Abort/shutdown still requires working cancellation in the harness/provider; this is not a hard
operating-system deadline for an uncooperative process. Events already delivered can still trigger
answers until the stop. Notify is best effort, not a general exactly-once chat guarantee.

```bash
npm run example:chat
# Real model: requires approval under AGENTS.md
node --experimental-strip-types agent/examples/chat.ts --live "Thema"
```

The faux dispatcher ignores system messages when checking the last tool result.
After the tool call it ends the turn. These are conversations in one process, not
distributed hosts. MemoryStorage loses the history when the process ends.

[agent/test/examples/recovery.test.ts](../../agent/test/examples/recovery.test.ts) runs runChat itself and checks the ring 0–3.
The older agent/test/examples/chat.test.ts checks its own scripts with the real Space. Live-model, long-running and
multi-host evidence is missing. [Back to the overview](README.en.md).
