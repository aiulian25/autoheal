import { SPEED_TEST_LIMITS, SPEED_TEST_URL } from "../../shared/network.js";

const BITS_PER_BYTE = 8;
const BITS_PER_MEGABIT = 1_000_000;

export interface MeasuredSpeed {
  downMbps: number;
  upMbps: number;
}

// Each worker repeats one transfer until time is up. The first moments are a connection getting up to speed, so
// they are not counted.
async function megabitsDuring(
  workers: number,
  milliseconds: number,
  transfer: (signal: AbortSignal, count: (bytes: number) => void) => Promise<void>,
) {
  const startedAt = Date.now();
  const stop = AbortSignal.timeout(milliseconds);
  let counted = 0;
  const count = (bytes: number) => {
    if (Date.now() - startedAt >= SPEED_TEST_LIMITS.warmUpMilliseconds) counted += bytes;
  };
  const worker = async () => {
    while (!stop.aborted) await transfer(stop, count);
  };
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));
  if (counted === 0) {
    const failure = results.find((result) => result.status === "rejected" && !stop.aborted);
    throw failure?.status === "rejected" ? failure.reason : new Error("The speed test server sent nothing back.");
  }
  const seconds = (milliseconds - SPEED_TEST_LIMITS.warmUpMilliseconds) / 1_000;
  return (counted * BITS_PER_BYTE) / BITS_PER_MEGABIT / seconds;
}

const refusedBy = (response: Response) => new Error(`The speed test server answered ${response.status}.`);

/**
 * The line as seen from this machine, for a router that will not run a test itself. Its own cable or Wi-Fi can hold
 * the figure down, so it says less about the provider than the router's own test does.
 */
export async function measureSpeed(
  baseUrl: string = SPEED_TEST_URL,
  milliseconds: number = SPEED_TEST_LIMITS.directionMilliseconds,
): Promise<MeasuredSpeed> {
  const downMbps = await megabitsDuring(SPEED_TEST_LIMITS.workers, milliseconds, async (signal, count) => {
    const response = await fetch(`${baseUrl}/__down?bytes=${SPEED_TEST_LIMITS.downloadBytes}`, { signal });
    if (!response.ok || response.body === null) throw refusedBy(response);
    for await (const chunk of response.body) count(chunk.byteLength);
  });
  const payload = new Uint8Array(SPEED_TEST_LIMITS.uploadBytes);
  const upMbps = await megabitsDuring(SPEED_TEST_LIMITS.workers, milliseconds, async (signal, count) => {
    const response = await fetch(`${baseUrl}/__up`, { method: "POST", body: payload, signal });
    await response.arrayBuffer();
    if (!response.ok) throw refusedBy(response);
    count(payload.byteLength);
  });
  return { downMbps, upMbps };
}
