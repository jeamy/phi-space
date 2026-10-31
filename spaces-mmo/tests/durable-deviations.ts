// `npm run test:durable`: tests of the general suites that do not hold with the durable path on, each because the path
// deliberately behaves otherwise. A test leaves this list when it passes; a failure that is no decision of the path is a
// bug to fix, not an entry. `test` is the test's exact name, `reason` why it cannot hold.
export const DEVIATIONS: Array<{ test: string; reason: string }> = [
];
