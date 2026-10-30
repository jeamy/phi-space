let count = 0;
export const calls = () => count;
export async function complete(): Promise<string> { count++; return "say fallback"; }
