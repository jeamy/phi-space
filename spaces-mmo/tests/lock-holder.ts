// A process that holds a room's lock as an engine transaction does and is then killed (tests/contention.test.ts, a worker
// crash while it holds a lock): it opens a transaction with a short lease, takes the lock (holdRoomVersion, which writes
// it back with its version counted up under the transaction), says "held <version>" and waits to be killed. Its
// transaction is never committed: the space ends it when the lease runs out, and the lock comes back as it was.
//   node --experimental-strip-types tests/lock-holder.ts <space address> <room> <lease ms>
import { connectSpace } from "phi-spaces";
import { holdRoomVersion } from "../server/engine/room-lock.ts";

const [address, room, lease] = process.argv.slice(2);
if (!address || !room || !lease) throw new Error("usage: lock-holder.ts <space address> <room> <lease ms>");
const { space } = connectSpace(address);
const txn = (await space.createTransaction(Number(lease))).id;
const version = await holdRoomVersion(space, txn, room);
if (version === null) throw new Error(`the lock of ${room} stayed taken`);
process.stdout.write(`held ${version}\n`);
setInterval(() => {}, 60_000);
